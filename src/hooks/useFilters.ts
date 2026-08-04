/**
 * hooks/useFilters.ts
 *
 * Phase 2B hook — manages the global filter state shown in FilterBar.
 *
 * Replicates EXACTLY the filter state and filtering logic from the
 * original App component:
 *
 *   var af = useState('all'); var accFilter = af[0], setAccFilter = af[1];
 *   var mf = useState('all'); var mktFilter = mf[0], setMktFilter = mf[1];
 *
 *   var trades = useMemo(function() {
 *     return allTrades.filter(function(t) {
 *       var passAcc = accFilter === 'all' || t.accountId === accFilter;
 *       var passMkt = mktFilter === 'all'
 *         || (mktFilter === 'futures' && t._isFutures)
 *         || (mktFilter === 'forex'   && !t._isFutures);
 *       return passAcc && passMkt;
 *     });
 *   }, [allTrades, accFilter, mktFilter]);
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same default values: 'all' for both filters
 * - Same filter logic: passAcc && passMkt
 * - Same market values: 'all' | 'forex' | 'futures'
 * - Filter state is NOT persisted (matches original — in-memory only)
 */

import { useState, useCallback, useMemo } from 'react';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { FilterGroup } from '@calculations/filterEngine.js';
import {
  selectVisibleTrades,
  type AccountFilter, type MarketFilter,
} from '@calculations/visibleTrades.js';

// ─── Types ───────────────────────────────────────────────────
//
// Phase 22 — AccountFilter/MarketFilter now live in
// calculations/visibleTrades.ts, next to the predicate that consumes
// them. They are imported above and used throughout this file exactly
// as before; they are deliberately NOT re-exported, since they had no
// importer outside this module.

/**
 * The saved filter currently acting as the global lens, or null.
 *
 * `group` is a SNAPSHOT taken when the filter was applied — deleting or
 * editing the source SavedFilter afterwards does not change what the
 * user is currently viewing. `sourceId` records which SavedFilter it
 * came from.
 */
export interface ActiveFilter {
  sourceId: string;
  name:     string;
  group:    FilterGroup;
}

export interface UseFiltersReturn {
  /** Current account filter — 'all' or account ID */
  accFilter: AccountFilter;
  /** Current market filter */
  mktFilter: MarketFilter;
  /**
   * Set the account filter.
   * Matches original: setAccFilter(id)
   */
  setAccFilter: (id: AccountFilter) => void;
  /**
   * Set the market filter.
   * Matches original: setMktFilter(market)
   */
  setMktFilter: (market: MarketFilter) => void;
  /**
   * Apply the current filters to an enriched trades array.
   * Returns the filtered subset.
   *
   * Phase 22: delegates to selectVisibleTrades()
   * (calculations/visibleTrades.ts), which holds the account/market
   * predicate this hook used to own plus the active-filter group.
   * The signature is unchanged, so every existing caller is unaffected.
   *
   * @param allTrades - The full enriched trades array
   * @returns Filtered trades
   */
  applyFilters: (allTrades: EnrichedTrade[]) => EnrichedTrade[];
  /** The saved filter acting as the global lens, or null when none */
  activeFilter: ActiveFilter | null;
  /** Set the global lens — the caller supplies the group snapshot */
  setActiveFilter: (filter: ActiveFilter) => void;
  /** Clear the global lens. Does NOT touch accFilter/mktFilter. */
  clearActiveFilter: () => void;
}

// ─── Hook ────────────────────────────────────────────────────

/**
 * useFilters
 *
 * Provides global filter state (account + market).
 * Filters are in-memory only — not persisted to LocalStorage.
 *
 * Usage:
 *   const { accFilter, mktFilter, setAccFilter, setMktFilter, applyFilters } = useFilters();
 *   const trades = useMemo(() => applyFilters(allTrades), [allTrades, accFilter, mktFilter]);
 */
export function useFilters(): UseFiltersReturn {
  // Matches original:
  //   var af = useState('all'); var accFilter = af[0], setAccFilter = af[1];
  //   var mf = useState('all'); var mktFilter = mf[0], setMktFilter = mf[1];
  const [accFilter, setAccFilter] = useState<AccountFilter>('all');
  const [mktFilter, setMktFilter] = useState<MarketFilter>('all');

  // Phase 22 — the global lens. In-memory only, exactly like the two
  // filters above: not persisted, resets to null on reload.
  const [activeFilter, setActiveFilter] = useState<ActiveFilter | null>(null);

  /**
   * Phase 22 — the account/market predicate that used to live here was
   * MOVED VERBATIM into calculations/visibleTrades.ts, which now also
   * composes the active-filter group. This hook keeps the state and
   * delegates the decision; it no longer decides anything itself.
   *
   * `activeFilter` MUST stay in the dependency array: App.jsx's trades
   * memo depends on this callback's identity, so a stale identity would
   * freeze the visible set and make applying a filter appear to do
   * nothing.
   */
  const applyFilters = useCallback(
    (allTrades: EnrichedTrade[]): EnrichedTrade[] =>
      selectVisibleTrades(allTrades, accFilter, mktFilter, activeFilter?.group ?? null),
    [accFilter, mktFilter, activeFilter],
  );

  const clearActiveFilter = useCallback(() => setActiveFilter(null), []);

  return {
    accFilter, mktFilter, setAccFilter, setMktFilter, applyFilters,
    activeFilter, setActiveFilter, clearActiveFilter,
  };
}
