/**
 * components/sync/SyncConflictReview.tsx
 *
 * Phase 5e — SYNC_ARCHITECTURE_SPEC.md §8.2, §5.3. Rebuilds the inert
 * placeholder left by the sync architecture rewrite (§13 Step 2) into
 * the real Tier 2 manual-review dialog, wired to the Sync Engine built
 * across Phases 5a-5d. See src/sync/tier2Resolution.ts for the actual
 * "Upload Local Data" / "Use Cloud Data" algorithms — this file is UI
 * plus the orchestration of calling them then `resolveTierTwoReview`.
 *
 * LEADER TAB: shows the interactive dialog whenever the Scheduler
 * reports one or more tables in `needs_structural_review` (§8.2),
 * offering the four specified actions. Per rule 2's "every table that
 * contributed at least one conflict" scope, ALL currently-escalated
 * tables are shown and resolved together in one dialog, by one click of
 * "Upload Local Data" or "Use Cloud Data" — not per-table (approved
 * scope).
 *
 * FOLLOWER TAB: never shows the interactive dialog (§5.3: "Follower
 * tabs... show a lightweight, non-interactive... indicator — never
 * their own independent review dialog"). Listens for the leader's
 * `broadcastTier2State` messages instead, via the already-built
 * `onTier2StateChange`.
 *
 * REACTIVITY, DISCLOSED: neither `SchedulerCore` nor `crossTabCoordinator`
 * expose a subscription for "this tab's own leader/escalation state
 * changed" — and BroadcastChannel never delivers a tab's own messages
 * back to itself, so the leader tab cannot rely on the broadcast it
 * just sent to know its own state. This component therefore polls
 * `getScheduler()` at a short, fixed interval for its OWN leader-tab
 * state — a narrow mechanism scoped to this one dialog's visibility,
 * not a general store-to-React subscription system (that remains
 * explicitly out of scope this phase — MIGRATION_NOTES.md AN-015 item
 * 1). Follower tabs use the broadcast listener instead of polling.
 *
 * "USE CLOUD DATA" AND THE REST OF THE APP'S UI (per explicit
 * direction): this component does not force a page reload after a
 * successful "Use Cloud Data". It closes the dialog and shows a
 * message telling the user their local data was replaced and that the
 * rest of the UI (trades/accounts/lists/settings screens, still plain
 * `useState` today — AN-015 item 1) will catch up on next reload, or
 * automatically once a future phase adds that reactivity.
 *
 * NOT IN SCOPE THIS PHASE (per explicit direction — do not extend
 * without separate approval): no React subscription system, no
 * LocalStorage namespacing changes, no §3.5 sign-out step 1 (abort
 * in-flight requests). See MIGRATION_NOTES.md AN-015.
 */

import React, { useEffect, useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Modal } from '@components/ui/Modal.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { getScheduler } from '@sync/syncEngine.js';
import { isLeader, onTier2StateChange, type Tier2State } from '@sync/crossTabCoordinator.js';
import type { SyncTableName, TierTwoRule, TierTwoEscalation } from '@sync/scheduler.js';
import { createAllLocalStores, createAllTier2ResolutionStores } from '@services/syncStores.js';
import { createAllTransports } from '@services/syncTransport.js';
import { resolveUploadLocalData, resolveUseCloudData } from '@sync/tier2Resolution.js';
import { downloadBackup } from '@services/backupService.js';

const POLL_INTERVAL_MS = 2000;

const TABLE_LABELS: Record<SyncTableName, string> = {
  trades: 'Trades',
  accounts: 'Accounts',
  lists: 'Lists',
  settings: 'Settings',
};

const RULE_LABELS: Record<TierTwoRule, string> = {
  1: 'first sync on this device',
  2: 'a large number of changes on another device',
  3: 'this device has been offline too long',
  4: 'the same record keeps conflicting',
};

const indicatorStyle: React.CSSProperties = {
  position:     'fixed',
  bottom:       16,
  right:        16,
  zIndex:       250,
  background:   C.card,
  border:       `1px solid ${C.border}`,
  borderRadius: 8,
  padding:      '8px 12px',
  fontSize:     11,
  color:        C.dim,
  maxWidth:     320,
};

// ─── Leader-tab state (polled — see file header) ──────────────────────

function useLeaderEscalations() {
  const [isLeaderTab, setIsLeaderTab] = useState(false);
  const [escalations, setEscalations] = useState<TierTwoEscalation[]>([]);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      if (cancelled) return;
      const leader = isLeader();
      setIsLeaderTab(leader);
      setEscalations(leader ? (getScheduler()?.getTablesNeedingReview() ?? []) : []);
    }
    poll();
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, []);

  return { isLeaderTab, escalations };
}

// ─── Follower-tab passive indicator (broadcast-driven, §5.3) ──────────

function useFollowerReviewTables(isLeaderTab: boolean): Set<string> {
  const [reviewTables, setReviewTables] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isLeaderTab) return;
    const unsubscribe = onTier2StateChange((state: Tier2State) => {
      if (!state.table) return;
      const table = state.table;
      setReviewTables((prev) => {
        const next = new Set(prev);
        if (state.status === 'needs_review') next.add(table);
        else next.delete(table);
        return next;
      });
    });
    return unsubscribe;
  }, [isLeaderTab]);

  return reviewTables;
}

// ─── Component ─────────────────────────────────────────────────────────

export function SyncConflictReview() {
  const { isLeaderTab, escalations } = useLeaderEscalations();
  const followerReviewTables = useFollowerReviewTables(isLeaderTab);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const tables = escalations.map((e) => e.table);
  const escalationKey = [...tables].sort().join(',');

  // Drop a stale error once the underlying escalation set actually
  // changes (e.g. a table resolves, or a new one joins).
  useEffect(() => {
    setError(null);
  }, [escalationKey]);

  async function handleUploadLocalData() {
    setBusy(true);
    setError(null);
    try {
      const resolutionStores = createAllTier2ResolutionStores();
      const scheduler = getScheduler();
      for (const table of tables) {
        await resolveUploadLocalData(resolutionStores[table]);
        scheduler?.resolveTierTwoReview(table);
        scheduler?.requestImmediatePush(table);
      }
      setSuccessNotice(
        `✅ Local changes for ${tables.map((t) => TABLE_LABELS[t]).join(', ')} will be uploaded. Sync resumes automatically.`,
      );
      setDismissedKey(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleUseCloudData() {
    setBusy(true);
    setError(null);
    try {
      const resolutionStores = createAllTier2ResolutionStores();
      const localStores = createAllLocalStores();
      const transports = createAllTransports();
      const scheduler = getScheduler();
      const failedTables: SyncTableName[] = [];

      for (const table of tables) {
        const result = await resolveUseCloudData(
          resolutionStores[table],
          localStores[table].pullStore,
          transports[table].pullTransport,
        );
        if (result.success) {
          scheduler?.resolveTierTwoReview(table);
        } else {
          failedTables.push(table);
        }
      }

      if (failedTables.length > 0) {
        setError(
          `Couldn't refresh from the cloud for ${failedTables.map((t) => TABLE_LABELS[t]).join(', ')}. Nothing was lost — try again.`,
        );
      } else {
        setSuccessNotice(
          `✅ Local data for ${tables.map((t) => TABLE_LABELS[t]).join(', ')} was replaced with the cloud's version. ` +
          `The rest of the screen will reflect this after you reload the page, or automatically once a future update adds live sync to the UI.`,
        );
        setDismissedKey(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Phase 6g-1: downloadBackup() is now async (§3.4). Caught rather
  // than left as an unhandled rejection, using this dialog's existing
  // error surface — a failed backup-before-you-decide download is
  // exactly the kind of thing the user needs to see here.
  function handleDownloadBackup() {
    downloadBackup().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }

  function handleCancel() {
    setDismissedKey(escalationKey);
  }

  // ── Follower tab: passive, non-interactive indicator only (§5.3) ──
  if (!isLeaderTab) {
    if (followerReviewTables.size === 0) return null;
    return <div style={indicatorStyle}>⏸ Sync paused pending review in another tab</div>;
  }

  // ── Leader tab, nothing currently needs review ──
  if (escalations.length === 0) {
    if (!successNotice) return null;
    return (
      <div
        style={{ ...indicatorStyle, borderColor: `${C.green}44`, color: C.text, cursor: 'pointer' }}
        onClick={() => setSuccessNotice(null)}
      >
        {successNotice} <span style={{ color: C.dim }}>(dismiss)</span>
      </div>
    );
  }

  // ── Leader tab, user cancelled for this exact escalation set ──
  if (dismissedKey === escalationKey) {
    return (
      <div style={{ ...indicatorStyle, cursor: 'pointer' }} onClick={() => setDismissedKey(null)}>
        ⚠ Sync paused — {tables.map((t) => TABLE_LABELS[t]).join(', ')} need review. Click to resume.
      </div>
    );
  }

  // ── Leader tab, active dialog ──
  const ruleSummary = [...new Set(escalations.map((e) => RULE_LABELS[e.rule]))].join('; ');

  return (
    <Modal onClose={handleCancel}>
      <Card style={{ maxWidth: 480, width: '100%' }}>
        <div style={{ color: C.text, fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
          ⚠ Sync needs your review
        </div>
        <div style={{ color: C.dim, fontSize: 11, marginBottom: 12 }}>
          {tables.map((t) => TABLE_LABELS[t]).join(', ')} — paused because of: {ruleSummary}.
        </div>
        <div style={{ color: C.dim, fontSize: 11, marginBottom: 16 }}>
          Choose which copy of your data to keep. Nothing changes until you pick one.
        </div>

        {error && <div style={{ color: C.red, fontSize: 11, marginBottom: 12 }}>❌ {error}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Button variant="primary" size="sm" onClick={handleUploadLocalData} disabled={busy}>
            ⬆ Upload Local Data — keep what&apos;s on this device
          </Button>
          <Button variant="secondary" size="sm" onClick={handleUseCloudData} disabled={busy}>
            ⬇ Use Cloud Data — replace this device&apos;s data
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDownloadBackup} disabled={busy}>
            💾 Download Local Backup first
          </Button>
          <Button variant="ghost" size="sm" onClick={handleCancel} disabled={busy}>
            Cancel — decide later
          </Button>
        </div>
      </Card>
    </Modal>
  );
}
