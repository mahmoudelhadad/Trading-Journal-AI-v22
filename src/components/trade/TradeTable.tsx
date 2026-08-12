/**
 * components/trade/TradeTable.tsx
 *
 * Full trades table: filter bar (symbol/outcome/account/account-type),
 * bulk selection, bulk delete, delete-all, and the table itself.
 *
 * Migrated VERBATIM from the original RawTab(props) function.
 * Every filter, every piece of state, and every workflow are preserved
 * exactly. Only the underlying primitives were swapped for the
 * Phase 3 UI atoms (Select, TableHeader, TableCell, EmptyState) and
 * the new TradeRow component — visual output and behavior are identical.
 *
 * Original workflows preserved exactly:
 *   1. Filter by symbol / outcome / account / account type
 *      (filtered = trades matching all 4 — AND logic)
 *   2. Checkbox column: click header checkbox to select/deselect
 *      all CURRENTLY FILTERED rows (matches toggleAll() exactly)
 *   3. "🗑 Delete N" button appears only when selectedCount > 0
 *      (matches original conditional rendering exactly)
 *   4. Exactly one confirmation before bulk delete, and one before
 *      delete-all (v1.4: delivered by ConfirmDialog rather than the
 *      browser's native dialog — the decision, not the semantics,
 *      changed. See components/ui/ConfirmDialog.tsx)
 *   5. "🗑 Delete ALL" always visible, top-right, muted red
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same 28 columns in same order
 * - Same filter logic (AND across all 4 filters)
 * - Same Delete ALL confirmation text (v1.4 splits the historical
 *   single string across ConfirmDialog's title + message, which
 *   reconstruct it exactly, and still shows NO trade count)
 * - Same minWidth:1800 horizontal scroll behavior
 *
 * ONE INTENTIONAL COPY CORRECTION (v1.4, authorized): the bulk-delete
 * confirmation used to end "This cannot be undone.", which was false —
 * onBulkDeleteTrade routes to softDeleteTrade, so the trades land in
 * the Recovery Bin and ARE restorable. It now says so.
 */

import React, { useState, useMemo, useCallback } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { FX_SYMBOLS, FUT_SYMBOLS } from '@constants/symbols.js';
import { Select } from '@components/ui/Select.js';
import { TableHeader } from '@components/ui/Table.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { ConfirmDialog } from '@components/ui/ConfirmDialog.js';
import { TradeRow } from './TradeRow.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface TradeTableProps {
  trades:      EnrichedTrade[];
  accounts:    Account[];
  onEdit:      (trade: EnrichedTrade) => void;
  /** Used for SINGLE-row delete only (TradeRow's Del button). May show its own confirmation. */
  onDelete:    (tid: number) => void;
  /**
   * Used for BULK delete only (this component's own "Delete N" button).
   * MUST be the raw delete action with no additional confirmation —
   * deleteSelected() below already shows its own single confirm dialog
   * covering the whole batch. Added to fix a real bug: onDelete (see
   * above) is shared with the single-row path in Raw.tsx, where it is
   * wrapped in its own per-trade "Delete this trade?" confirmation.
   * Reusing onDelete for bulk delete meant every selected trade
   * triggered its own extra confirmation dialog on top of this
   * component's bulk confirm — N+1 dialogs for N selected trades —
   * which silently blocked deletion for any trade whose surprise
   * second dialog wasn't explicitly accepted. onDelete itself and the
   * single-row path are unchanged.
   */
  onBulkDeleteTrade: (tid: number) => void;
  onDeleteAll: () => void;
  onAdd:       () => void;
}

// ─── Column headers — matches original hdrs array exactly ─────
const COLUMN_HEADERS = [
  '☐', '#', 'Mkt', 'Symbol', 'Date', 'Day', 'Session', 'Account',
  'Dir', 'Size', 'Entry', 'SL', 'Target', 'Exit', 'R', 'Pts',
  'P/L', 'Net P/L', 'PlanR', 'Outcome', 'Setup', '★', 'Plan',
  'Risk$', 'Risk%', 'Dur', 'Chart', 'Edit',
];

const ALL_SYMBOLS = [...FX_SYMBOLS, ...FUT_SYMBOLS];
const OUTCOME_OPTIONS = ['Green', 'Red', 'Breakeven'];

// ─── Component ───────────────────────────────────────────────

export function TradeTable({
  trades,
  accounts,
  onEdit,
  onDelete,
  onBulkDeleteTrade,
  onDeleteAll,
  onAdd,
}: TradeTableProps) {
  // ── Filter state — matches original: fSym, fOut, fAcc0, fAccT0 ──
  const [fSym, setFSym]   = useState('');
  const [fOut, setFOut]   = useState('');
  const [fAcc0, setFAcc]  = useState('');
  const [fAccT0, setFAccT] = useState('');

  // ── Selection state — matches original: selected (object map) ──
  const [selected, setSelected] = useState<Record<number, boolean>>({});

  // ── Collect unique account types from trades ──
  // Matches original: accTypes = useMemo(...)
  const accTypes = useMemo(() => {
    const s = new Set<string>();
    trades.forEach((t) => {
      if (t.account && t.account.trim()) s.add(t.account.trim());
    });
    return Array.from(s).sort();
  }, [trades]);

  // ── Filtered trades — AND logic across all 4 filters ──
  // Matches original filter predicate exactly
  const filtered = useMemo(() => {
    return trades.filter((t) =>
      (!fSym || t.symbol === fSym) &&
      (!fOut || t._outcome === fOut) &&
      (!fAcc0 || t.accountId === fAcc0) &&
      (!fAccT0 || t.account === fAccT0),
    );
  }, [trades, fSym, fOut, fAcc0, fAccT0]);

  const selectedCount = Object.keys(selected).filter((k) => selected[k as unknown as number]).length;
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((t) => selected[t._tid]);

  // ── Selection handlers ──

  const toggleOne = useCallback((tid: number) => {
    setSelected((prev) => ({ ...prev, [tid]: !prev[tid] }));
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = { ...prev };
      const targetState = !allFilteredSelected;
      filtered.forEach((t) => { next[t._tid] = targetState; });
      return next;
    });
  }, [filtered, allFilteredSelected]);

  // ── v1.4 confirmation state ──────────────────────────────
  // `pendingBulkIds` is the SNAPSHOT of exactly which trades the user
  // was shown when they opened the bulk-delete confirmation. Both the
  // displayed count and the acted-upon set read from this one array —
  // see deleteSelected/confirmBulkDelete below for why that matters.
  // `pendingDeleteAll` deliberately carries NO context at all.
  const [pendingBulkIds, setPendingBulkIds]   = useState<number[] | null>(null);
  const [pendingDeleteAll, setPendingDeleteAll] = useState(false);

  const deleteSelected = useCallback(() => {
    // NOTE: Object.keys() always returns string[] at runtime, even though
    // `selected` is typed Record<number, boolean> (t._tid is a number).
    // This exact mismatch exists in the ORIGINAL app too — Object.keys()
    // there also stringifies the numeric _tid keys. This was preserved as
    // a dormant bug (documented as KI-001 in MIGRATION_NOTES.md) through
    // the initial migration. Fixed here, deliberately, as an approved
    // deviation from the original app's behavior — not a silent change:
    // Number(id) below converts each stringified key back to a real
    // number.
    //
    // SECOND, INDEPENDENT BUG found and fixed in the same pass: the loop
    // below calls onBulkDeleteTrade (not onDelete). onDelete is shared
    // with TradeRow's single-row delete button, and in Raw.tsx it is
    // wrapped in its own "Delete this trade?" confirmation — correct
    // for a single delete, but when reused here it meant every trade in
    // a bulk selection triggered its OWN extra confirmation dialog on
    // top of the one line below, i.e. N+1 dialogs for N selected trades,
    // silently blocking deletion for any trade whose surprise second
    // dialog wasn't explicitly accepted. onBulkDeleteTrade is the raw,
    // un-confirmed delete action — this function's own confirm below is
    // the only one needed for the bulk path. onDelete, TradeRow's
    // single-row path, and deleteTrade's own logic are all untouched.
    const ids = Object.keys(selected).filter((k) => selected[k as unknown as number]);
    // Preserved exactly: an empty selection never opens a confirmation.
    if (!ids.length) return;
    // v1.4 — SNAPSHOT AT OPEN TIME. window.confirm blocked the thread,
    // so the confirmed count and the deleted set could not diverge. A
    // React dialog does not block, so the id list is frozen here, at
    // the moment the user is shown "Delete N selected trades?", and
    // confirmBulkDelete acts on that same array rather than re-reading
    // `selected`. The Number() conversion (Object.keys stringifies the
    // numeric _tid keys — the KI-001 fix) now happens at snapshot time
    // instead of inside the loop; the values handed to
    // onBulkDeleteTrade are identical.
    setPendingBulkIds(ids.map(Number));
  }, [selected]);

  // Cancel clears the snapshot ONLY. onBulkDeleteTrade is not called,
  // and `selected` is deliberately NOT cleared — matching the early
  // `return` this replaced, which left the selection badge intact.
  const cancelBulkDelete = useCallback(() => {
    setPendingBulkIds(null);
  }, []);

  const confirmBulkDelete = useCallback(() => {
    if (!pendingBulkIds) return;
    const ids = pendingBulkIds;
    setPendingBulkIds(null);
    // ONE confirmation for the whole batch, then the original loop
    // semantics unchanged. onBulkDeleteTrade is the raw, un-confirmed
    // delete action (see this component's props doc): reusing onDelete
    // here is what used to produce N+1 dialogs. That fix stands.
    ids.forEach((id) => onBulkDeleteTrade(id));
    setSelected({});
  }, [pendingBulkIds, onBulkDeleteTrade]);

  // Delete ALL captures NOTHING — no ids, no count, no population.
  // The Phase 29 contract says the population is every active RawTrade,
  // resolved downstream in App.jsx's handleSoftDeleteAllTrades, NOT the
  // filtered rows this component happens to be rendering. Holding no
  // trade context here is what makes that impossible to get wrong, and
  // is why the confirmation copy carries no count.
  const deleteAll = useCallback(() => {
    setPendingDeleteAll(true);
  }, []);

  const cancelDeleteAll = useCallback(() => {
    setPendingDeleteAll(false);
  }, []);

  const confirmDeleteAll = useCallback(() => {
    setPendingDeleteAll(false);
    onDeleteAll();
    setSelected({});
  }, [onDeleteAll]);

  return (
    <div>
      {/* ── Filter / action bar ─────────────────────────────── */}
      <div style={{ display: 'flex', gap: 7, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          onClick={onAdd}
          style={{
            background: C.blue, color: '#fff', border: 'none', borderRadius: 8,
            padding: '7px 14px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          + Add Trade
        </button>

        <Select value={fSym} onChange={setFSym} options={ALL_SYMBOLS} placeholder="All Symbols" width="135px" />
        <Select value={fOut} onChange={setFOut} options={OUTCOME_OPTIONS} placeholder="All Outcomes" width="125px" />

        {/* Native selects — matches original exactly */}
        <select
          value={fAcc0}
          onChange={(e) => setFAcc(e.target.value)}
          style={{ width: 130, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}
        >
          <option value="">All Accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        <select
          value={fAccT0}
          onChange={(e) => setFAccT(e.target.value)}
          style={{ width: 120, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}
        >
          <option value="">All Acc Types</option>
          {accTypes.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <span style={{ color: C.dim, fontSize: 11 }}>{filtered.length} trades</span>

        {selectedCount > 0 && (
          <div
            style={{
              display: 'flex', gap: 6, alignItems: 'center',
              background: '#1A2A1A', border: `1px solid ${C.green}44`,
              borderRadius: 8, padding: '4px 10px', marginLeft: 4,
            }}
          >
            <span style={{ color: C.gold, fontSize: 11, fontWeight: 700 }}>
              {selectedCount} selected
            </span>
            <button
              onClick={deleteSelected}
              style={{
                background: C.red, border: 'none', color: '#fff', borderRadius: 6,
                padding: '3px 12px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              🗑 Delete {selectedCount}
            </button>
            <button
              onClick={() => setSelected({})}
              style={{
                background: C.border, color: C.dim, border: 'none', borderRadius: 6,
                padding: '3px 9px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              ✕ Clear
            </button>
          </div>
        )}

        <div style={{ marginLeft: 'auto' }}>
          <button
            onClick={deleteAll}
            style={{
              background: 'none', border: `1px solid ${C.red}44`, color: `${C.red}99`,
              borderRadius: 7, padding: '4px 12px', fontSize: 10, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            🗑 Delete ALL
          </button>
        </div>
      </div>

      {/* ── Table ────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto', borderRadius: 10, border: `1px solid ${C.border}` }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1800 }}>
          <thead>
            <tr>
              {COLUMN_HEADERS.map((hd, i) => {
                if (i === 0) {
                  return (
                    <th
                      key="chk"
                      onClick={toggleAll}
                      style={{
                        background: '#0A1020', padding: '7px 8px',
                        borderBottom: `1px solid ${C.border}`, textAlign: 'center',
                        width: 28, cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleAll}
                        style={{ cursor: 'pointer', accentColor: C.blue }}
                      />
                    </th>
                  );
                }
                return <TableHeader key={hd}>{hd}</TableHeader>;
              })}
            </tr>
          </thead>

          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={COLUMN_HEADERS.length}>
                  <EmptyState message='No trades yet — click "+ Add Trade"' padding={50} fontSize={13} />
                </td>
              </tr>
            ) : (
              filtered.map((t, i) => (
                <TradeRow
                  key={t._tid}
                  trade={t}
                  accounts={accounts}
                  isSelected={!!selected[t._tid]}
                  rowIndex={i}
                  onToggleSelect={toggleOne}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ── Bulk delete confirmation ─────────────────────────── */}
      {/* Count comes from the SNAPSHOT, never from `selected` or
          `filtered`, so the number the user confirms is exactly the
          number deleted. Copy corrected in v1.4: the old text said
          "This cannot be undone.", which was false — this path routes
          to softDeleteTrade, so the trades ARE recoverable. */}
      {pendingBulkIds !== null && (
        <ConfirmDialog
          title={`Delete ${pendingBulkIds.length} selected trades?`}
          message="They will be moved to the Recovery Bin and can be restored from there."
          confirmLabel={`Delete ${pendingBulkIds.length}`}
          confirmVariant="danger"
          onConfirm={confirmBulkDelete}
          onCancel={cancelBulkDelete}
        />
      )}

      {/* ── Delete ALL confirmation ──────────────────────────── */}
      {/* NO COUNT — deliberately. title + message reconstruct the
          historical Phase 29 string exactly. */}
      {pendingDeleteAll && (
        <ConfirmDialog
          title="Delete ALL active trades?"
          message="They will be moved to the Recovery Bin and can be restored from there."
          confirmLabel="Delete ALL"
          confirmVariant="danger"
          onConfirm={confirmDeleteAll}
          onCancel={cancelDeleteAll}
        />
      )}
    </div>
  );
}
