/**
 * calculations/visibleTrades.ts
 *
 * Phase 22 — Global Strategy Filter: the application's single filtering
 * rule.
 *
 * NEW module. Holds the account/market predicate MOVED VERBATIM from
 * hooks/useFilters.ts's applyFilters (Phase 2B), composed with the
 * existing applyFilterGroup() (Phase 14) so that a saved FilterGroup can
 * act as an active global lens on top of the account/market filters.
 *
 * WHY THIS LIVES IN calculations/: this is business logic, not React
 * state. It mirrors the split this codebase already established —
 * calculations/backtest.ts holds the rule, hooks/useBacktests.ts holds
 * the state. useFilters() now owns only the filter state and delegates
 * every decision about what the app displays to this function, which is
 * the single source of truth for that decision.
 *
 * COMPOSITION ORDER is fixed: account → market → group. The three are a
 * pure conjunction, so the result is order-independent; the order is
 * fixed for determinism and so the cheap account/market narrowing runs
 * before the more expensive per-condition evaluation.
 *
 * BEHAVIOR PRESERVATION: with activeGroup === null this function returns
 * exactly what the pre-phase applyFilters returned, including the
 * both-'all' early return that hands back the SAME array reference
 * rather than a copy. That early return now additionally requires
 * activeGroup === null, since an active group must still be applied even
 * when both account and market are 'all'.
 *
 * 'all' SENTINEL: AccountFilter/MarketFilter use 'all' to mean "this
 * control is unset" — a presentation convention that moves here with the
 * predicate that consumes it. See the phase definition's Recorded
 * Tradeoff for why the alternative (a nullable domain signature plus a
 * translation layer in the hook) was rejected.
 */

import { applyFilterGroup, type FilterGroup } from './filterEngine.js';
import type { EnrichedTrade } from './tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

/** Market filter values — matches FilterBar in original app */
export type MarketFilter = 'all' | 'forex' | 'futures';

/** Account filter value — 'all' or a specific account ID */
export type AccountFilter = 'all' | string;

// ─── The filtering rule ──────────────────────────────────────

/**
 * Select the trades the application should display.
 *
 * FORMULA (account/market portion copied verbatim from the original
 * useFilters.applyFilters):
 *   passAcc = accFilter === 'all' || t.accountId === accFilter
 *   passMkt = mktFilter === 'all'
 *          || (mktFilter === 'futures' && t._isFutures)
 *          || (mktFilter === 'forex'   && !t._isFutures)
 * then, when activeGroup is non-null, the surviving trades are passed
 * through the existing applyFilterGroup() unchanged.
 *
 * @param trades      - The full enriched trades array
 * @param accFilter   - 'all' or an account id
 * @param mktFilter   - 'all' | 'forex' | 'futures'
 * @param activeGroup - The active saved-filter group, or null when none
 * @returns The trades that pass every active filter
 */
export function selectVisibleTrades(
  trades: EnrichedTrade[],
  accFilter: AccountFilter,
  mktFilter: MarketFilter,
  activeGroup: FilterGroup | null,
): EnrichedTrade[] {
  // Early return — no filtering needed when both are 'all'
  if (accFilter === 'all' && mktFilter === 'all' && activeGroup === null) return trades;

  const byAccountAndMarket = trades.filter((t) => {
    const passAcc =
      accFilter === 'all' || t.accountId === accFilter;

    const passMkt =
      mktFilter === 'all' ||
      (mktFilter === 'futures' && t._isFutures) ||
      (mktFilter === 'forex'   && !t._isFutures);

    return passAcc && passMkt;
  });

  return activeGroup === null
    ? byAccountAndMarket
    : applyFilterGroup(byAccountAndMarket, activeGroup);
}
