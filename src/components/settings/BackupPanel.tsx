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
 */

import React, { useState, useRef } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { downloadBackup, restoreBackupFromJSON } from '@services/backupService.js';

// ─── Component ───────────────────────────────────────────────

export function BackupPanel() {
  const [message, setMessage] = useState<{ text: string; isError: boolean } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Phase 6g-1: downloadBackup()/restoreBackupFromJSON() are now async
  // (§3.4 — the resolver-backed sections require it). Both handlers
  // await and report failure the same way a validation failure was
  // already reported, rather than leaving an unhandled rejection.
  async function handleBackup() {
    try {
      await downloadBackup();
      setMessage({ text: '✅ Backup downloaded successfully.', isError: false });
    } catch (err) {
      setMessage({ text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true });
    }
  }

  function handleRestoreClick() {
    fileInputRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const text = ev.target?.result as string;
      try {
        const result = await restoreBackupFromJSON(text);
        if (result.success) {
          setMessage({ text: `✅ Restored ${result.restoredKeys?.length ?? 0} section(s). Reload the app to see restored data.`, isError: false });
        } else {
          setMessage({ text: `❌ ${result.error}`, isError: true });
        }
      } catch (err) {
        setMessage({ text: `❌ ${err instanceof Error ? err.message : String(err)}`, isError: true });
      }
    };
    reader.readAsText(file);
    e.target.value = ''; // allow re-selecting the same file later
  }

  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>💾 Backup & Restore</div>
      <div style={{ color: C.dim, fontSize: 11, marginBottom: 12 }}>
        Download a complete backup of all your data (trades, accounts, lists, settings, filters, checklists) as one file, or restore from a previous backup.
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
    </Card>
  );
}
