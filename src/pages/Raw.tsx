/**
 * pages/Raw.tsx
 *
 * Raw trades page — wires useTrades / useAccounts / useLists to
 * TradeTable and TradeForm.
 *
 * Migrated VERBATIM from the Raw-tab-related state and handlers in
 * the original App() component:
 *
 *   var et = useState(null); var editT = et[0], setEditT = et[1];
 *   var fs = useState(false); var showForm = fs[0], setShowForm = fs[1];
 *
 *   function saveTrade(t) {
 *     if (editT) setRaw(p => p.map(x => x._tid===editT._tid ? {...t,_tid:editT._tid} : x));
 *     else setRaw(p => p.concat([{...t, _tid: Date.now()}]));
 *     setShowForm(false); setEditT(null);
 *   }
 *   function delTrade(id) {
 *     if (window.confirm("Delete this trade?")) setRaw(p => p.filter(t => t._tid !== id));
 *   }
 *   function openEdit(t) { setEditT(t); setShowForm(true); }
 *   function openAdd()   { setEditT(null); setShowForm(true); }
 *
 *   tab==="raw" && h(RawTab, { trades, accounts, onEdit:openEdit,
 *     onDelete:delTrade, onDeleteAll:delAllTrades, onAdd:openAdd })
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same LocalStorage key: 'fxj_v4_trades' (via useTrades)
 * - Same single-delete confirm(): "Delete this trade?"
 * - Same save logic: edit merges by _tid, add appends with new _tid
 * - Same "trades" prop = filtered-by-global-filters enriched trades
 *   (accountId/market filtering is applied by the caller via useFilters,
 *   matching the original App component's `trades` useMemo)
 *
 * NOTE ON SCOPE (Phase 5):
 * This page receives `trades` (already filtered) and `accounts` as
 * props from the parent (which will be App.tsx in a later phase, once
 * the full application is reassembled). This keeps Raw.tsx testable
 * in isolation and matches the original data flow: App owns global
 * filter state, RawTab/Raw page only renders what it's given.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { TradeTable } from '@components/trade/TradeTable.js';
import { TradeForm } from '@components/trade/TradeForm.js';
import { ConfirmDialog } from '@components/ui/ConfirmDialog.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { RawTrade, RawTradeContent } from '@hooks/useTrades.js';
import type { Account } from '@hooks/useAccounts.js';
import type { ListsState } from '@hooks/useLists.js';

// ─── Types ───────────────────────────────────────────────────

export interface RawPageProps {
  /** Enriched trades — already filtered by global account/market filters */
  trades:        EnrichedTrade[];
  accounts:      Account[];
  lists:         ListsState;
  /** Default account ID for new trades — matches original defaultAccId logic */
  defaultAccId:  string;

  /** Trade writes passed in by the parent that owns the hook */
  addTrade:       (trade: Omit<RawTradeContent, '_tid'>) => void;
  updateTrade:    (trade: RawTrade) => void;
  /** Recovery capture followed by the existing Delete ALL lifecycle */
  softDeleteAllTrades: () => void;

  /**
   * Recovery Bin wiring: replaces the raw deleteTrade prop this page
   * used to receive directly. softDeleteTrade(tid) is a composite
   * function owned by the parent (App.jsx) that captures the trade,
   * calls the existing Recovery Bin's softDelete(), THEN calls the
   * existing, unchanged useTrades().deleteTrade() — so both call sites
   * below (single delete's handleDelete, and the bulk path's
   * onBulkDeleteTrade) now soft-delete before removing. Neither this
   * page's own confirm dialogs nor TradeTable's bulk confirm/selection
   * logic changed — only which delete function they ultimately call.
   */
  softDeleteTrade: (tid: number) => void;

  /**
   * External trigger to open the Add Trade form, for the global
   * "+ New Trade" header button (Raw owns the form/modal state itself,
   * with no other exposed imperative "open" mechanism).
   *
   * REVISED from an earlier increment-a-counter + "skip the first
   * effect firing" design: that approach counted effect INVOCATIONS
   * ("is this the first time this has run since mount?"), which is
   * fragile — since RawPage fully unmounts/remounts on every tab
   * switch, and any scenario with more than one effect pass on mount
   * (e.g. React 18 StrictMode, which main.jsx wraps the whole app in)
   * can desynchronize an invocation-counting guard from the intended
   * behavior. This version is purely VALUE-driven instead: `pending`
   * is a plain boolean. When true, Raw calls its own existing,
   * unchanged openAdd() and immediately calls `onAddSignalHandled()`
   * to tell the parent to reset it back to false. This is correct
   * regardless of how many times or in what order the effect fires —
   * a true flag always triggers exactly the intended action once
   * (calling openAdd() an extra time on the same value is harmless,
   * since it just re-sets the same state to the same values); a
   * false/undefined flag never triggers it, whether on the first
   * render or any later one. Both fully optional — omitting them (or
   * never setting `openAddTrigger`) leaves Raw's behavior completely
   * unaffected.
   */
  openAddTrigger?: boolean;
  onAddSignalHandled?: () => void;
}

// ─── Component ───────────────────────────────────────────────

export function RawPage({
  trades,
  accounts,
  lists,
  defaultAccId,
  addTrade,
  updateTrade,
  softDeleteAllTrades,
  softDeleteTrade,
  openAddTrigger,
  onAddSignalHandled,
}: RawPageProps) {
  // Matches original: var et=useState(null); var editT=et[0],setEditT=et[1];
  const [editingTrade, setEditingTrade] = useState<EnrichedTrade | RawTrade | null>(null);
  // Matches original: var fs=useState(false); var showForm=fs[0],setShowForm=fs[1];
  const [showForm, setShowForm] = useState(false);

  // Matches original: function openAdd(){setEditT(null);setShowForm(true);}
  const openAdd = useCallback(() => {
    setEditingTrade(null);
    setShowForm(true);
  }, []);

  // External trigger for the global "+ New Trade" header button. Calls
  // the EXISTING openAdd() above, unchanged, whenever `openAddTrigger`
  // is currently true — then immediately tells the parent it's been
  // handled, via onAddSignalHandled(), so the parent can reset the
  // flag back to false. Purely value-driven: correct regardless of how
  // many times this effect fires (mount, remount, or any React 18
  // StrictMode double-invocation), since a false/undefined value never
  // triggers openAdd(), on the first render or any later one — there is
  // no "is this the first run" state to get out of sync. See
  // RawPageProps' openAddTrigger doc comment for the full rationale.
  useEffect(() => {
    if (openAddTrigger) {
      openAdd();
      onAddSignalHandled?.();
    }
  }, [openAddTrigger, openAdd, onAddSignalHandled]);

  // Matches original: function openEdit(t){setEditT(t);setShowForm(true);}
  const openEdit = useCallback((trade: EnrichedTrade) => {
    setEditingTrade(trade);
    setShowForm(true);
  }, []);

  const closeForm = useCallback(() => {
    setShowForm(false);
    setEditingTrade(null);
  }, []);

  // Matches original saveTrade(t) exactly:
  //   if (editT) → update by _tid
  //   else       → add with new _tid (handled inside addTrade/useTrades)
  //
  // `trade` from TradeForm is RawTradeContent (business fields only —
  // see TradeForm.tsx). For the edit branch, `editingTrade`'s own sync
  // metadata is merged back in before calling updateTrade(), which
  // requires the full RawTrade shape (Phase 5a decision 4).
  //
  // The `as RawTrade` below is the one assertion Phase 5a's type
  // extension could not remove without also touching the frozen
  // calculations/tradeCalc.ts TradeLike/EnrichedTrade types: `TradeLike`
  // is `Partial<Omit<RawTrade, '_tid'>> & {...}` (AN-014 item 4), so
  // EnrichedTrade's inherited sync-metadata fields are typed OPTIONAL
  // even though they are always genuinely present at runtime — every
  // EnrichedTrade is produced by enrichTrades() spreading a real,
  // already-stamped RawTrade (hooks/useTrades.ts). Making this
  // statically provable without a cast would mean widening TradeLike's
  // Partial<> to require SyncMetadata's fields non-optionally, which is
  // a change to a calculations/ file this migration has treated as
  // frozen/off-limits throughout (MIGRATION_NOTES.md AN-001) — out of
  // scope for a type-correctness pass on the sync layer. Flagged in the
  // Phase 5a report rather than silently left as a wider, unexplained
  // cast.
  const handleSave = useCallback(
    (trade: RawTradeContent) => {
      if (editingTrade) {
        // Matches: setRaw(p => p.map(x => x._tid===editT._tid ? {...t,_tid:editT._tid} : x))
        updateTrade({ ...editingTrade, ...trade, _tid: editingTrade._tid } as RawTrade);
      } else {
        // Matches: setRaw(p => p.concat([{...t, _tid: Date.now()}]))
        addTrade(trade);
      }
      setShowForm(false);
      setEditingTrade(null);
    },
    [editingTrade, addTrade, updateTrade],
  );

  // Matches original delTrade(id) — the confirmation still lives HERE,
  // not in TradeTable, and there is still exactly ONE confirmation per
  // single-delete operation.
  //
  // v1.4: the decision moved off window.confirm and onto ConfirmDialog
  // (see components/ui/ConfirmDialog.tsx for why). The confirmed action
  // is byte-identical: softDeleteTrade(tid), which captures + bins the
  // trade then calls the same, unchanged deleteTrade internally. The
  // historical question text is preserved verbatim.
  //
  // `pendingDeleteTid` holds the exact tid the user clicked Del on,
  // which is the same value handed to softDeleteTrade on Confirm — a
  // React dialog is asynchronous where window.confirm was synchronous,
  // so the target is captured rather than re-derived.
  const [pendingDeleteTid, setPendingDeleteTid] = useState<number | null>(null);

  const handleDelete = useCallback((tid: number) => {
    setPendingDeleteTid(tid);
  }, []);

  // Cancel clears pending state and NOTHING else — softDeleteTrade is
  // not called, so no trade is captured, binned, or removed.
  const cancelDelete = useCallback(() => {
    setPendingDeleteTid(null);
  }, []);

  const confirmDelete = useCallback(() => {
    if (pendingDeleteTid === null) return;
    const tid = pendingDeleteTid;
    setPendingDeleteTid(null);
    softDeleteTrade(tid);
  }, [pendingDeleteTid, softDeleteTrade]);

  return (
    <>
      <TradeTable
        trades={trades}
        accounts={accounts}
        onEdit={openEdit}
        onDelete={handleDelete}
        onBulkDeleteTrade={softDeleteTrade}
        onDeleteAll={softDeleteAllTrades}
        onAdd={openAdd}
      />

      {showForm && (
        <TradeForm
          trade={editingTrade as RawTradeContent | null}
          accounts={accounts}
          lists={lists}
          defaultAccId={defaultAccId}
          onSave={handleSave}
          onClose={closeForm}
        />
      )}

      {pendingDeleteTid !== null && (
        <ConfirmDialog
          title="Delete this trade?"
          confirmLabel="Delete Trade"
          confirmVariant="danger"
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}
    </>
  );
}
