/**
 * components/settings/BackupPanel.tsx
 *
 * Phase 16 — Settings: Backup & Restore panel.
 *
 * NEW component — no original-app equivalent, explicitly pre-approved
 * in the original migration plan's SETTINGS section ("Backup, Restore").
 * Contains ZERO backup/restore logic of its own — every operation goes
 * through services/backupService.ts, which itself contains zero new
 * persistence logic (it composes the EXISTING load / save pairs from
 * services/storage.js). This component is a thin UI wrapper only.
 *
 * v1.5 — Restore Integrity. Restoring a backup file used to start the
 * moment the file was chosen, and afterwards the running React tree kept
 * its PRE-restore snapshot while storage held the restored data. Every
 * hook re-persists its own state on change, so the next ordinary
 * mutation wrote that stale snapshot back over the restore — silently
 * destroying restored records (no tombstone, no Recovery Bin entry, no
 * error) and resurrecting records the restore had removed. Two changes,
 * both local to this component:
 *
 *   1. Selecting a file no longer restores. The payload is held in
 *      component state until an app-owned ConfirmDialog is confirmed.
 *   2. A SUCCESSFUL restore reloads the application, so state is
 *      reacquired through the normal hydration path before the user can
 *      mutate anything. Cancel and failure never reload.
 *
 * Nothing about backupService.ts changes: parsing, validation, the
 * 12-section surface, all-or-nothing pre-write validation, read-back
 * verification and RestoreResult are untouched. This component decides
 * only WHEN a restore is authorised and WHEN the app re-reads storage.
 */

import React, { useState, useRef, useMemo } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { ConfirmDialog } from '@components/ui/ConfirmDialog.js';
import { createBackupService } from '@services/backupService.js';
import { useUserStorage } from '@contexts/UserStorageContext.js';

// ─── Component ───────────────────────────────────────────────

export function BackupPanel() {
  const { storage, database } = useUserStorage();
  const backup = useMemo(() => createBackupService(storage, database), [storage, database]);
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * The chosen backup's text, held from file selection until the user
   * confirms. Non-null is exactly "a confirmation is open", matching the
   * caller-conditional render model ConfirmDialog was built for — there
   * is no separate open flag to get out of step with the payload.
   */
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  /**
   * Authority for "a restore is already under way". State alone is not
   * enough: two clicks landing in the same tick share one render's
   * closure and would both pass a state check, because the re-render
   * that unmounts the dialog has not happened yet. A ref changes
   * synchronously, so the second click loses.
   */
  const restoreInFlightRef = useRef(false);

  // Phase 6g-1: downloadBackup()/restoreBackupFromJSON() are now async
  // (§3.4 — the resolver-backed sections require it). Both handlers
  // await and report failure the same way a validation failure was
  // already reported, rather than leaving an unhandled rejection.
  async function handleBackup() {
    try {
      await backup.downloadBackup();
      setMessage({ text: '✅ Backup downloaded successfully.', isError: false });
    } catch (err) {
      setMessage({ text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true });
    }
  }

  function handleRestoreClick() {
    fileInputRef.current?.click();
  }

  // v1.5: reading the file is not restoring it. FileReader touches no
  // storage, so holding the text until Confirm keeps the confirm path a
  // single await and leaves zero restore calls on the selection path.
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPendingRestore(ev.target?.result as string);
    };
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file later
  }

  /** Cancel — and the ConfirmDialog backdrop click, via its onCancel. */
  function handleCancelRestore() {
    setPendingRestore(null);
  }

  function handleConfirmRestore() {
    if (restoreInFlightRef.current) return;
    const text = pendingRestore;
    if (text === null) return;
    // Both of these happen BEFORE anything is awaited: the ref shuts the
    // door on a same-tick second click, and clearing the payload closes
    // the dialog so no later click can reach this path at all.
    restoreInFlightRef.current = true;
    setPendingRestore(null);
    void runRestore(text);
  }

  async function runRestore(text: string) {
    try {
      const result = await backup.restoreBackupFromJSON(text);
      if (result.success) {
        // The restore rewrote storage underneath a React tree still
        // holding the pre-restore snapshot. Reloading is the whole fix:
        // every hook re-hydrates from the restored storage before the
        // user can mutate anything. Nothing is shown first — a success
        // notice would only flash, and its old wording ("Reload the app
        // to see restored data") is now false.
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

  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>💾 Backup & Restore</div>
      <div style={{ color: C.dim, fontSize: 11, marginBottom: 12 }}>
        Download a complete backup of your journal data, settings, filters, checklists, Recovery Bin, and saved Backtest Results as one file, or restore from a previous backup.
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: message ? 10 : 0 }}>
        <Button variant="primary" size="sm" onClick={handleBackup}>⬇ Download Backup</Button>
        <Button variant="secondary" size="sm" onClick={handleRestoreClick}>⬆ Restore from File</Button>
        <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileChange} style={{ display: 'none' }} />
      </div>

      {message && (
        <div style={{
          background: message.isError ? `${C.red}22` : `${C.green}22`,
          border: `1px solid ${(message.isError ? C.red : C.green)}44`,
          borderRadius: 7, padding: '8px 12px', fontSize: 11,
          color: message.isError ? C.red : C.green,
        }}>
          {message.text}
        </div>
      )}

      {pendingRestore !== null && (
        <ConfirmDialog
          title="Restore this backup?"
          message="This will replace your current journal data with the selected backup."
          confirmLabel="Restore Backup"
          onConfirm={handleConfirmRestore}
          onCancel={handleCancelRestore}
        />
      )}
    </Card>
  );
}
