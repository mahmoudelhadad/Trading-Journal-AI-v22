/**
 * components/LocalPersistenceNotice.tsx
 *
 * Phase 6g-1 — SYNC_ARCHITECTURE_SPEC.md §3.4.
 *
 * The "distinct, blocking notice" §3.4 requires for exactly two
 * conditions, both reported through services/localPersistenceEvents.ts:
 *   1. A local write failed — "must direct the user toward a
 *      corrective action (freeing device storage), not offer a 'retry'
 *      that cannot succeed until they do."
 *   2. This tab's local-database connection was force-closed by a
 *      version upgrade in another tab — "prompting that tab to reload."
 *
 * WHY A MODAL, NOT A TOAST: §3.4 says "blocking," not merely "visible."
 * A dismissible corner toast is what the *ordinary* pending-changes
 * indicator already looks like — the one thing this notice must never
 * be folded into (§3.4's own words). Reuses the existing Modal/Card/
 * Button primitives — the same choice already made for the similarly
 * serious SyncConflictReview dialog — not a new visual language.
 *
 * WHY `connection_force_closed` CANNOT BE DISMISSED VIA THE BACKDROP:
 * after a forced close, every subsequent local read/write throws
 * (indexedDb.ts deliberately never reopens the connection — see its own
 * header). Letting the backdrop silently dismiss this one would leave
 * the user in a broken app with no visible explanation. `save_failed`
 * has no such requirement — dismissing it just closes the dialog; nothing
 * about the app's state depends on it staying open.
 *
 * MOUNTED ONCE, GLOBALLY, IN main.jsx — same placement as
 * SyncConflictReview, for the same reason: a session-wide condition,
 * not a per-page one.
 */

import React, { useEffect, useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import {
  onLocalPersistenceNoticeChange,
  getLocalPersistenceNotice,
  dismissLocalPersistenceNotice,
  type LocalPersistenceNotice as NoticeState,
} from '@services/localPersistenceEvents.js';

function useLocalPersistenceNotice(): NoticeState | null {
  const [notice, setNotice] = useState<NoticeState | null>(() => getLocalPersistenceNotice());
  useEffect(() => onLocalPersistenceNoticeChange(setNotice), []);
  return notice;
}

export function LocalPersistenceNotice() {
  const notice = useLocalPersistenceNotice();
  if (!notice) return null;

  if (notice.kind === 'connection_force_closed') {
    return (
      <Modal onClose={() => {}}>
        <Card style={{ maxWidth: 420, width: '100%' }}>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            ⚠ This tab needs to reload
          </div>
          <div style={{ color: C.dim, fontSize: 11, marginBottom: 16 }}>
            Another tab updated the app&apos;s local database. This tab&apos;s connection to it was closed to avoid a conflict — reload to continue.
          </div>
          <Button variant="primary" size="sm" onClick={() => window.location.reload()}>
            🔄 Reload
          </Button>
        </Card>
      </Modal>
    );
  }

  const isQuota = notice.errorKind === 'quota_exceeded';

  return (
    <Modal onClose={dismissLocalPersistenceNotice}>
      <Card style={{ maxWidth: 420, width: '100%' }}>
        <div style={{ color: C.red, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
          ❌ Couldn&apos;t save your changes
        </div>
        <div style={{ color: C.dim, fontSize: 11, marginBottom: 16 }}>
          {isQuota
            ? 'Your device’s storage is full, so recent changes could not be saved. Free up storage space on this device, then continue — retrying now will not succeed until you do.'
            : `A local save failed and could not be completed (${notice.source}): ${notice.message}`}
        </div>
        <Button variant="secondary" size="sm" onClick={dismissLocalPersistenceNotice}>
          Dismiss
        </Button>
      </Card>
    </Modal>
  );
}
