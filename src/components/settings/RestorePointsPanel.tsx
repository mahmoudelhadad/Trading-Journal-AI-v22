/**
 * components/settings/RestorePointsPanel.tsx
 *
 * Phase 18 — Restore Points UI.
 *
 * NEW component — lets the user create a named restore point (a
 * full-app-state snapshot), view existing ones, restore to one, or
 * delete one. Sits alongside BackupPanel.tsx (Phase 16) as a related
 * but distinct safety feature: BackupPanel downloads/uploads a file;
 * this panel keeps snapshots inside the app itself. Reuses Card,
 * Button, Input, Badge, EmptyState UI atoms (Phase 3) — no new visual
 * language introduced. Contains zero snapshot logic of its own — see
 * useRestorePoints.ts / services/backupService.ts for where that lives.
 *
 * SCOPE NOTE: not wired into any existing page in this phase.
 *
 * v1.5 — Restore Integrity. Restore used to fire on a single click, and
 * afterwards the running React tree kept its PRE-restore snapshot while
 * storage held the restored data. Because every hook re-persists its own
 * state on change, the next ordinary mutation wrote that stale snapshot
 * back over the restore. Restoring now requires an app-owned
 * ConfirmDialog, and a SUCCESSFUL restore reloads the application so the
 * restored storage is reacquired through normal hydration. Cancel and
 * failure never reload. See BackupPanel.tsx — the file-backup path has
 * the same defect, the same shape of fix, and the same reasoning.
 */

import React, { useState, useRef } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Badge } from '@components/ui/Badge.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { ConfirmDialog } from '@components/ui/ConfirmDialog.js';
import { MAX_RESTORE_POINTS } from '@calculations/recoveryBin.js';
import type { RestorePoint } from '@calculations/recoveryBin.js';
import type { RestoreResult } from '@services/backupService.js';

// ─── Types ───────────────────────────────────────────────────

export interface RestorePointsPanelProps {
  restorePoints: RestorePoint[];
  onCreate:      (label: string) => Promise<void>;
  onRestore:     (id: string) => Promise<RestoreResult>;
  onDelete:      (id: string) => void;
}

// ─── Component ───────────────────────────────────────────────

export function RestorePointsPanel({ restorePoints, onCreate, onRestore, onDelete }: RestorePointsPanelProps) {
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  /**
   * The id captured when Restore was clicked. Non-null is exactly "a
   * confirmation is open" — the payload and the open state are one
   * value, so the dialog can never be showing for a different point
   * than the one that will be restored. Sorting or list changes
   * underneath cannot re-target it, because nothing re-derives the id
   * from a position.
   */
  const [pendingRestoreId, setPendingRestoreId] = useState<string | null>(null);
  /** Same same-tick double-click authority as BackupPanel — see there. */
  const restoreInFlightRef = useRef(false);

  // Phase 6g-1: onCreate/onRestore are now async (§3.4 — the resolver-
  // backed sections require it). Both handlers await and report failure
  // the same way a validation failure was already reported.
  async function handleCreate() {
    try {
      await onCreate(label.trim() || 'Restore Point');
      setLabel('');
    } catch (err) {
      setMessage({ text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true });
    }
  }

  /** Cancel — and the ConfirmDialog backdrop click, via its onCancel. */
  function handleCancelRestore() {
    setPendingRestoreId(null);
  }

  function handleConfirmRestore() {
    if (restoreInFlightRef.current) return;
    const id = pendingRestoreId;
    if (id === null) return;
    // Both happen BEFORE anything is awaited — see BackupPanel.tsx.
    restoreInFlightRef.current = true;
    setPendingRestoreId(null);
    void handleRestore(id);
  }

  async function handleRestore(id: string) {
    try {
      const result = await onRestore(id);
      if (result.success) {
        // Reload is the fix: storage was replaced underneath a React
        // tree still holding the pre-restore snapshot, and hydration is
        // what reacquires it. No success notice — it would only flash,
        // and its old wording ("Reload the app to see restored data")
        // is now false.
        window.location.reload();
        return;
      }
      restoreInFlightRef.current = false;
      setMessage({ text: `❌ ${result.error}`, isError: true });
    } catch (err) {
      restoreInFlightRef.current = false;
      setMessage({ text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true });
    }
  }

  const sorted = [...restorePoints].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📍 Restore Points</div>
      <div style={{ color: C.dim, fontSize: 11, marginBottom: 12 }}>
        {`Save a snapshot of your entire app state to revert to later, without leaving the app. Keeps the last ${MAX_RESTORE_POINTS} points.`}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <Input value={label} onChange={setLabel} placeholder="Label (e.g. Before bulk import)..." />
        <Button variant="primary" size="sm" onClick={handleCreate}>+ Create Restore Point</Button>
      </div>

      {message && (
        <div style={{
          background: message.isError ? `${C.red}22` : `${C.green}22`,
          border: `1px solid ${(message.isError ? C.red : C.green)}44`,
          borderRadius: 7, padding: '8px 12px', fontSize: 11, marginBottom: 12,
          color: message.isError ? C.red : C.green,
        }}>
          {message.text}
        </div>
      )}

      {sorted.length === 0 ? (
        <EmptyState message="No restore points yet." padding={16} fontSize={11} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sorted.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: C.row, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: C.white, fontWeight: 700, fontSize: 12 }}>{p.label}</div>
                <div style={{ color: C.dim, fontSize: 10 }}>{new Date(p.createdAt).toLocaleString()}</div>
              </div>
              {p.label.startsWith('Auto: ') && <Badge color={C.blue}>Auto</Badge>}
              <button onClick={() => setPendingRestoreId(p.id)} style={{ background: `${C.blue}22`, border: `1px solid ${C.blue}44`, color: C.blue, borderRadius: 6, padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                Restore
              </button>
              <button onClick={() => onDelete(p.id)} style={{ background: 'none', border: 'none', color: C.red, fontSize: 14, cursor: 'pointer', padding: '0 4px' }} title="Delete">
                🗑
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingRestoreId !== null && (
        <ConfirmDialog
          title="Restore from this point?"
          message="This will replace your current journal data with this restore point."
          confirmLabel="Restore This Point"
          onConfirm={handleConfirmRestore}
          onCancel={handleCancelRestore}
        />
      )}
    </Card>
  );
}
