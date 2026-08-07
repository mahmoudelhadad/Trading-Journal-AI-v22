/**
 * hooks/useTrades.ts
 *
 * Phase 2B hook — manages raw trade state and CRUD operations.
 *
 * Replicates EXACTLY the trade-related state and functions from the
 * original App component. Every function is a direct extraction;
 * no logic has been changed.
 *
 * Original state in App:
 *   var rs = useState([]); var raw = rs[0], setRaw = rs[1];
 *
 * Original persistence:
 *   useEffect(() => { var r = LS.get('fxj_v4_trades'); if (r && Array.isArray(r)) setRaw(r); }, []);
 *   useEffect(() => { LS.set('fxj_v4_trades', raw); }, [raw]);
 *
 * Original CRUD functions extracted verbatim:
 *   saveTrade(t)       → addTrade / updateTrade (split for clarity, same logic)
 *   delTrade(id)       → deleteTrade
 *   delAllTrades()     → deleteAllTrades
 *   importTrades(arr)  → importTrades
 *
 * The hook also exposes enrichTrades() from calculations/tradeCalc.ts
 * so callers can derive EnrichedTrade[] when accounts are available.
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same LocalStorage key: 'fxj_v4_trades'
 * - Same _tid generation: Date.now()
 * - Same trade spread logic on save
 * - Same filter logic (Array.isArray guard on load)
 *
 * Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 2): the
 * Phase 4 cloud write-through layer (services/cloudSync.ts) and its
 * hydrate-once-after-migration logic have been removed. This hook is
 * pure local-storage read/write again — no network calls, no auth
 * dependency. Cross-device sync is offline until the new Sync Engine
 * is wired in (§13 Step 5); this is an explicitly sanctioned
 * intermediate state, not a regression.
 *
 * §13 Step 3 follow-up: importTrades() stamps every incoming trade via
 * stampIncomingRecord() — a trade that already carries sync identity
 * (re-importing app-originated data) is refreshed in place, same
 * syncId; a genuinely external trade (CSV/Excel, via importService.ts)
 * is treated as brand-new and given fresh sync metadata. Without this,
 * an imported trade would have no syncStatus at all until the next
 * app reload's stamping pass, leaving it invisible to the pending
 * queue in the meantime. addTrade() stamps new trades the same way,
 * via createSyncMetadata() directly (§6.1's "User creates a record"
 * -> `dirty`) — a new trade is sync-eligible immediately.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import { enrichTrades } from '@calculations/tradeCalc.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';
import { createSyncMetadata, stampIncomingRecord, refreshForLocalWrite } from '@sync/record.js';
import { notifyLocalMutation } from '@sync/syncEngine.js';
import { reportLocalPersistenceFailure } from '@services/localPersistenceEvents.js';
import type { RawTrade, RawTradeContent } from '@apptypes/trade.js';

// Phase 20 — Architecture Cleanup: RawTrade is now defined in
// types/trade.ts (the architecturally correct location). Re-exported
// here so every existing `import type { RawTrade } from
// '@hooks/useTrades.js'` call site continues to work unchanged. See
// types/trade.ts for the full rationale.
//
// Phase 5a: `RawTrade` now formally includes SyncMetadata (decision 4);
// `RawTradeContent` (the pre-stamp, business-only shape) is re-exported
// alongside it for the same reason — TradeForm.tsx/importService.ts
// need it for values that don't have sync identity yet.
export type { RawTrade, RawTradeContent };

// ─── Types ───────────────────────────────────────────────────

export interface UseTradesReturn {
  /**
   * Raw trades, filtered per §3.2/§9.2: a trade with `deletedAt` set
   * (a pending tombstone, awaiting push) is excluded here, immediately,
   * regardless of `syncStatus` — never just on eventual purge. The
   * underlying storage (and what the Sync Engine's Push Manager sees
   * via services/syncStores.ts) still has it; this is a read-path-only
   * filter, not a delete.
   */
  rawTrades: RawTrade[];
  /**
   * All enriched trades (no filters applied).
   * Recomputed only when rawTrades or accounts change.
   * Matches original: var allTrades = useMemo(() => enrich(raw, accounts), [raw, accounts])
   */
  allTrades: EnrichedTrade[];
  /** False until the initial async load has completed (Phase 6f). See the hook body. */
  hydrated: boolean;
  /**
   * Add a new trade.
   * Matches original else-branch of saveTrade():
   *   setRaw(p => p.concat([{ ...t, _tid: Date.now() }]))
   */
  addTrade: (trade: Omit<RawTradeContent, '_tid'>) => void;
  /**
   * Update an existing trade by _tid.
   * Matches original if-branch of saveTrade():
   *   setRaw(p => p.map(x => x._tid === editT._tid ? { ...t, _tid: editT._tid } : x))
   */
  updateTrade: (trade: RawTrade) => void;
  /**
   * Delete a single trade by _tid.
   * Matches original delTrade(id):
   *   setRaw(p => p.filter(t => t._tid !== id))
   * Note: window.confirm() is handled by the UI layer, not here.
   */
  deleteTrade: (tid: number) => void;
  /**
   * Delete all trades.
   * Matches original delAllTrades():
   *   setRaw([])
   */
  deleteAllTrades: () => void;
  /**
   * Append imported trades.
   * Matches original importTrades(newTrades):
   *   setRaw(p => p.concat(newTrades))
   */
  importTrades: (trades: RawTradeContent[]) => void;
}

// ─── Hook ────────────────────────────────────────────────────

/**
 * useTrades
 *
 * Provides raw trade state management and enrichment.
 * Requires accounts array to compute running capital per account.
 *
 * Usage:
 *   const { allTrades, addTrade, deleteTrade } = useTrades(accounts);
 */
export function useTrades(accounts: Account[]): UseTradesReturn {
  const { database } = useUserStorage();
  // ── State ────────────────────────────────────────────────
  // `storedTrades` is the FULL local record set, tombstones included —
  // this is what persists to LocalStorage and what the Sync Engine's
  // store layer (services/syncStores.ts) must see in full. `rawTrades`
  // (below) is the read-path-filtered view every UI consumer gets.
  // Matches original: var rs = useState([]); var raw = rs[0], setRaw = rs[1];
  // PHASE 6f — ASYNC HYDRATION. See useSettings.ts for the full
  // rationale; the pattern is identical. Initial state is the empty
  // array the old synchronous initializer produced when storage held
  // nothing; the hydration effect replaces it with whatever was stored.
  const [storedTrades, setStoredTrades] = useState<RawTrade[]>([]);
  const [hydrated, setHydrated] = useState(false);
  /** Audit Issue #1 — see useSettings.ts for the full rationale. */
  const [loadFailed, setLoadFailed] = useState(false);

  // Cancellation only, no "already started" ref guard — see useSettings.ts
  // for why a ref guard would deadlock hydration under <React.StrictMode>.
  // Read-failure handling (audit Issue #1) also mirrors useSettings.ts.
  useEffect(() => {
    let cancelled = false;
    database.loadTrades()
      .then((saved) => {
        if (cancelled) return;
        // Matches original: if (r && Array.isArray(r)) setRaw(r)
        if (Array.isArray(saved)) setStoredTrades(saved as RawTrade[]);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadFailed(true);
        reportLocalPersistenceFailure('trades', err);
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => { cancelled = true; };
  }, [database]);

  // ── Persistence ──────────────────────────────────────────
  // Never before hydration finishes (see useSettings.ts) — otherwise the
  // empty initial array would overwrite real stored trades on every
  // app start. `loadFailed` blocks it for the same reason in the one
  // case where hydration completed WITHOUT the stored data: writing the
  // empty array then would erase every trade the user has. Matches
  // original: useEffect(() => LS.set('fxj_v4_trades', raw), [raw])
  useEffect(() => {
    if (!hydrated || loadFailed) return;
    // Phase 6g-1 (BD-1): a rejected save must not become a silent,
    // unhandled promise rejection — §3.4 requires it be surfaced to the
    // user as a distinct, blocking notice. See localPersistenceEvents.ts.
    database.saveTrades(storedTrades).catch((err) => reportLocalPersistenceFailure('trades', err));
  }, [database, storedTrades, hydrated, loadFailed]);

  // ── Read-path filtering (§3.2, §9.2) ──────────────────────
  // A tombstoned trade (deletedAt set) is excluded here, immediately,
  // regardless of syncStatus — before enrichTrades() ever sees it, so
  // calculations/tradeCalc.ts needs no changes at all.
  const rawTrades = useMemo(
    () => storedTrades.filter((t) => t.deletedAt === null),
    [storedTrades],
  );

  // ── Enrichment ───────────────────────────────────────────
  // Matches original: var allTrades = useMemo(() => enrich(raw, accounts), [raw, accounts])
  const allTrades = useMemo<EnrichedTrade[]>(
    () => enrichTrades(rawTrades, accounts),
    [rawTrades, accounts],
  );

  // ── CRUD operations ──────────────────────────────────────

  /**
   * Add a new trade with a generated _tid.
   * Matches original else-branch of saveTrade():
   *   setRaw(p => p.concat([Object.assign({}, t, { _tid: Date.now() })]))
   */
  const addTrade = useCallback((trade: Omit<RawTradeContent, '_tid'>) => {
    const newTrade = { ...createSyncMetadata(), ...trade, _tid: Date.now() };
    setStoredTrades((prev) => [...prev, newTrade]);
    notifyLocalMutation('trades');
  }, []);

  /**
   * Update an existing trade (matched by _tid).
   * Matches original if-branch of saveTrade():
   *   setRaw(p => p.map(x => x._tid === editT._tid ? { ...t, _tid: editT._tid } : x))
   * §5.1/§6.1 "user edits" -> `dirty`: refreshForLocalWrite() marks the
   * record dirty with a fresh localUpdatedAt, preserving syncId/
   * baseUpdatedAt/backoff state exactly as record.ts's own contract
   * requires — never reset here, only on a push success.
   */
  const updateTrade = useCallback((trade: RawTrade) => {
    const withEdits: RawTrade = { ...trade, _tid: trade._tid };
    const updated: RawTrade = { ...withEdits, ...refreshForLocalWrite(withEdits) };
    setStoredTrades((prev) =>
      prev.map((t) => (t._tid === trade._tid ? updated : t)),
    );
    notifyLocalMutation('trades');
  }, []);

  /**
   * Delete a single trade by _tid — §9.2 lifecycle:
   *   - Never synced (baseUpdatedAt === null): nothing to tombstone
   *     remotely — purge locally immediately, no network call (step 2).
   *   - Otherwise: set deletedAt + mark pending_delete (steps 1/3),
   *     kept in storage until the Push Manager's tombstone push
   *     succeeds (§9.2 step 4 purges it then, not here).
   * Matches original's OUTCOME (the trade disappears from every read
   * path immediately, via the filter above) even though the local
   * record itself is no longer necessarily removed on the spot.
   */
  const deleteTrade = useCallback((tid: number) => {
    const now = new Date().toISOString();
    setStoredTrades((prev) => {
      const target = prev.find((t) => t._tid === tid);
      if (!target || target.deletedAt !== null) return prev;
      if (target.baseUpdatedAt === null) {
        return prev.filter((t) => t._tid !== tid);
      }
      const withTombstone: RawTrade = { ...target, deletedAt: now };
      const tombstoned: RawTrade = { ...withTombstone, ...refreshForLocalWrite(withTombstone, now) };
      return prev.map((t) => (t._tid === tid ? tombstoned : t));
    });
    notifyLocalMutation('trades');
  }, []);

  /**
   * Delete all trades — the same §9.2 per-record lifecycle as
   * deleteTrade(), applied to every trade, NOT a wholesale
   * `setRaw([])`. The visible outcome is unchanged (every trade
   * disappears from every read path immediately, via the filter
   * above) — only the underlying persistence differs, so previously-
   * synced trades still propagate their deletion to the cloud.
   */
  const deleteAllTrades = useCallback(() => {
    const now = new Date().toISOString();
    setStoredTrades((prev) =>
      prev.reduce<RawTrade[]>((acc, t) => {
        if (t.deletedAt !== null) {
          acc.push(t); // already pending_delete — leave as-is
          return acc;
        }
        if (t.baseUpdatedAt === null) {
          return acc; // §9.2 step 2 — never synced, purge immediately
        }
        const withTombstone: RawTrade = { ...t, deletedAt: now };
        acc.push({ ...withTombstone, ...refreshForLocalWrite(withTombstone, now) });
        return acc;
      }, []),
    );
    notifyLocalMutation('trades');
  }, []);

  /**
   * Append imported trades.
   * Matches original: setRaw(p => p.concat(newTrades))
   */
  const importTrades = useCallback((trades: RawTradeContent[]) => {
    const now = new Date().toISOString();
    const stamped = trades.map((t) => stampIncomingRecord(t, now));
    setStoredTrades((prev) => [...prev, ...stamped]);
    notifyLocalMutation('trades');
  }, []);

  return {
    rawTrades,
    allTrades,
    hydrated,
    addTrade,
    updateTrade,
    deleteTrade,
    deleteAllTrades,
    importTrades,
  };
}
