/**
 * components/backtest/BacktestResultsList.tsx
 *
 * Backtesting UI — saved backtest results, selectable.
 *
 * Presentational only: it receives already-stored BacktestResult
 * records and reports the clicked id upward. It performs no
 * derivation — `name`, `createdAt` and `tradeCount` are all read
 * directly off the stored record, never recomputed.
 *
 * Row layout, timestamp rendering and color tokens follow the
 * existing settings/RestorePointsPanel.tsx list idiom (the closest
 * analogue in this codebase: a list of locally-stored, timestamped
 * records), so no new visual language is introduced.
 *
 * Ordering matches useBacktests(), which appends new results, so the
 * newest sit at the bottom of the stored array; they are shown newest
 * first here, matching RestorePointsPanel's convention.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Modal } from '@components/ui/Modal.js';
import { Input } from '@components/ui/Input.js';
import { Button } from '@components/ui/Button.js';
import type { BacktestResult } from '@apptypes/backtest.js';

// ─── Types ───────────────────────────────────────────────────

export interface BacktestResultsListProps {
  results:      BacktestResult[];
  selectedId:   string | null;
  comparisonId: string | null;
  onSelect:     (id: string) => void;
  onCompare:    (id: string) => void;
  onRename:   (id: string, newName: string) => void;
  onDelete:   (id: string) => void;
}

// ─── Component ───────────────────────────────────────────────

export function BacktestResultsList({ results, selectedId, comparisonId, onSelect, onCompare, onRename, onDelete }: BacktestResultsListProps) {
  const sorted = [...results].sort((a, b) => b.createdAt - a.createdAt);

  // Transient rename-dialog state only: which row's dialog is open and
  // the in-progress text. The authoritative name is never mirrored
  // here — every rendered name below reads results[i].name, so there
  // is no optimistic update and no cached copy to fall out of sync.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draftName, setDraftName]   = useState('');

  function openRename(r: BacktestResult) {
    setRenamingId(r.id);
    setDraftName(r.name);
  }

  function closeRename() {
    setRenamingId(null);
    setDraftName('');
  }

  function submitRename() {
    if (renamingId === null || !draftName.trim()) return;
    onRename(renamingId, draftName.trim());
    closeRename();
  }

  // Same transient-only pattern as rename: this holds which row is
  // pending confirmation, never a copy of the result itself.
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const deletingResult = deletingId === null ? null : (results.find((r) => r.id === deletingId) ?? null);

  function submitDelete() {
    if (deletingId === null) return;
    onDelete(deletingId);
    setDeletingId(null);
  }

  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>
        📁 Saved Backtests
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sorted.map((r) => {
          const isSelected = r.id === selectedId;
          return (
            <div
              key={r.id}
              onClick={() => onSelect(r.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background:   C.row,
                border:       `1px solid ${isSelected ? C.blue : C.border}`,
                borderRadius: 8,
                padding:      '8px 12px',
                cursor:       'pointer',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ color: isSelected ? C.blue : C.white, fontWeight: 700, fontSize: 12 }}>{r.name}</div>
                <div style={{ color: C.dim, fontSize: 10 }}>{new Date(r.createdAt).toLocaleString()}</div>
              </div>
              <div style={{ color: C.dim, fontSize: 10 }}>
                {`${r.tradeCount} ${r.tradeCount === 1 ? 'trade' : 'trades'}`}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onCompare(r.id); }}
                style={{ background: 'none', border: 'none', color: r.id === comparisonId ? C.gold : C.dim, fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
                title="Compare"
              >
                ⚖
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); openRename(r); }}
                style={{ background: 'none', border: 'none', color: C.dim, fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
                title="Rename"
              >
                ✎
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setDeletingId(r.id); }}
                style={{ background: 'none', border: 'none', color: C.red, fontSize: 14, cursor: 'pointer', padding: '0 4px' }}
                title="Delete"
              >
                🗑
              </button>
            </div>
          );
        })}
      </div>

      {/* ── Rename dialog ────────────────────────────────────── */}
      {/* Modal has no title prop, so the header is written here. */}
      {renamingId !== null && (
        <Modal onClose={closeRename}>
          <div style={{ color: C.white, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Rename Backtest</div>
          <Input value={draftName} onChange={setDraftName} placeholder="Backtest name..." autoFocus />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="secondary" size="sm" onClick={closeRename}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={submitRename} disabled={!draftName.trim()}>Save</Button>
          </div>
        </Modal>
      )}

      {/* ── Delete confirmation ──────────────────────────────── */}
      {deletingResult !== null && (
        <Modal onClose={() => setDeletingId(null)}>
          <div style={{ color: C.white, fontSize: 12, fontWeight: 700, marginBottom: 10 }}>Delete Backtest?</div>
          <div style={{ color: C.text, fontSize: 11, marginBottom: 4 }}>{deletingResult.name}</div>
          <div style={{ color: C.dim, fontSize: 10 }}>This cannot be undone.</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
            <Button variant="secondary" size="sm" onClick={() => setDeletingId(null)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={submitDelete}>Delete</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}
