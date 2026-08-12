/**
 * components/trade/RecoveryBinPanel.tsx
 *
 * Phase 18 — Recovery Bin UI.
 *
 * NEW component — displays soft-deleted items with Restore and
 * Permanently Delete actions, plus an Empty Bin action. Generic over
 * item type; the caller supplies how to render each item's summary via
 * `renderItem`. Reuses Card, Button, Badge, EmptyState UI atoms
 * (Phase 3) — no new visual language introduced.
 *
 * SCOPE NOTE: not wired into any existing page in this phase — see
 * calculations/recoveryBin.ts's file header for the full rationale.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Badge } from '@components/ui/Badge.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { ConfirmDialog } from '@components/ui/ConfirmDialog.js';
import { RECOVERY_BIN_RETENTION_MS } from '@calculations/recoveryBin.js';
import type { RecoveryBinEntry } from '@calculations/recoveryBin.js';

// ─── Types ───────────────────────────────────────────────────

export interface RecoveryBinPanelProps<T> {
  entries:            RecoveryBinEntry<T>[];
  onRestore:          (id: string) => void;
  /**
   * "Restore All" — restores every currently-listed entry in one
   * operation. This component owns the single confirmation dialog for
   * this action ("Restore all deleted trades?" — delivered by
   * ConfirmDialog since v1.4, previously the browser's native dialog),
   * matching how other bulk actions elsewhere in the app (e.g.
   * TradeTable's bulk delete) keep their confirm next to their own
   * button rather than pushing it up to the caller. onRestoreAll
   * itself performs the restore only — it is called after the user
   * has already confirmed.
   */
  onRestoreAll:       () => void;
  onPermanentlyDelete: (id: string) => void;
  onEmptyBin:         () => void;
}

// ─── Helpers ─────────────────────────────────────────────────

function daysRemaining(deletedAt: number): number {
  const elapsed = Date.now() - deletedAt;
  const remaining = RECOVERY_BIN_RETENTION_MS - elapsed;
  return Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
}

// ─── Component ───────────────────────────────────────────────

export function RecoveryBinPanel<T>({
  entries, onRestore, onRestoreAll, onPermanentlyDelete, onEmptyBin,
}: RecoveryBinPanelProps<T>) {
  // ── v1.4 confirmation state ──────────────────────────────
  // Each of the three actions below used to gate on window.confirm.
  // The decision now lives in ordinary React state and is rendered by
  // ConfirmDialog; every confirmed callback, and every Cancel path, is
  // otherwise unchanged. `pendingPurgeId` holds the EXACT Recovery
  // entry id the user clicked, and that same captured id — never a
  // re-derived one — is what onPermanentlyDelete receives.
  const [pendingRestoreAll, setPendingRestoreAll] = useState(false);
  const [pendingPurgeId, setPendingPurgeId]       = useState<string | null>(null);
  const [pendingEmptyBin, setPendingEmptyBin]     = useState(false);

  function handleRestoreAllClick() {
    setPendingRestoreAll(true);
  }

  function handlePermanentlyDeleteClick(id: string) {
    setPendingPurgeId(id);
  }

  function handleEmptyBinClick() {
    setPendingEmptyBin(true);
  }

  // Each confirm handler clears its own pending state FIRST, which
  // unmounts the dialog, then invokes the existing callback exactly
  // once. Cancel clears the same state and invokes nothing — none of
  // these paths touches active trades in either direction.
  function confirmRestoreAll() {
    setPendingRestoreAll(false);
    onRestoreAll();
  }

  function confirmPermanentlyDelete() {
    const id = pendingPurgeId;
    if (id === null) return;
    setPendingPurgeId(null);
    onPermanentlyDelete(id);
  }

  function confirmEmptyBin() {
    setPendingEmptyBin(false);
    onEmptyBin();
  }

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700 }}>🗑 Recovery Bin</div>
        {entries.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleRestoreAllClick} style={{ background: 'none', border: `1px solid ${C.green}44`, color: C.green, borderRadius: 6, padding: '3px 10px', fontSize: 10, cursor: 'pointer' }}>
              Restore All
            </button>
            <button onClick={handleEmptyBinClick} style={{ background: 'none', border: `1px solid ${C.red}44`, color: C.red, borderRadius: 6, padding: '3px 10px', fontSize: 10, cursor: 'pointer' }}>
              Empty Bin
            </button>
          </div>
        )}
      </div>

      {entries.length === 0 ? (
        <EmptyState message="Recovery bin is empty." padding={16} fontSize={11} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {entries.map((entry) => (
            <div key={entry.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.row, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{entry.label}</div>
                <div style={{ color: C.dim, fontSize: 10 }}>
                  {`Deleted ${new Date(entry.deletedAt).toLocaleString()}`}
                </div>
              </div>
              <Badge color={daysRemaining(entry.deletedAt) <= 3 ? C.gold : C.dim}>
                {`${daysRemaining(entry.deletedAt)}d left`}
              </Badge>
              <button onClick={() => onRestore(entry.id)} style={{ background: `${C.green}22`, border: `1px solid ${C.green}44`, color: C.green, borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                Restore
              </button>
              <button onClick={() => handlePermanentlyDeleteClick(entry.id)} style={{ background: 'none', border: 'none', color: C.red, fontSize: 14, cursor: 'pointer', padding: '0 4px' }} title="Delete permanently">
                🗑
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Restore All confirmation ─────────────────────────── */}
      {/* Additive, not destructive — hence the primary confirm button
          rather than danger. Historical wording, verbatim. */}
      {pendingRestoreAll && (
        <ConfirmDialog
          title="Restore all deleted trades?"
          confirmLabel="Restore All"
          confirmVariant="primary"
          onConfirm={confirmRestoreAll}
          onCancel={() => setPendingRestoreAll(false)}
        />
      )}

      {/* ── Permanent delete confirmation ────────────────────── */}
      {/* title + message reconstruct the frozen Phase 31 string. */}
      {pendingPurgeId !== null && (
        <ConfirmDialog
          title="Permanently delete this Recovery Bin entry?"
          message="This action cannot be undone through the Recovery Bin."
          confirmLabel="Delete Permanently"
          confirmVariant="danger"
          onConfirm={confirmPermanentlyDelete}
          onCancel={() => setPendingPurgeId(null)}
        />
      )}

      {/* ── Empty Bin confirmation ───────────────────────────── */}
      {/* title + message reconstruct the frozen Phase 31 string.
          No count, no typed confirmation. */}
      {pendingEmptyBin && (
        <ConfirmDialog
          title="Permanently delete ALL Recovery Bin entries?"
          message="This action cannot be undone through the Recovery Bin."
          confirmLabel="Empty Bin"
          confirmVariant="danger"
          onConfirm={confirmEmptyBin}
          onCancel={() => setPendingEmptyBin(false)}
        />
      )}
    </Card>
  );
}
