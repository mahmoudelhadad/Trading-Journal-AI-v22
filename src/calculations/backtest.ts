/**
 * calculations/backtest.ts
 *
 * Backtesting Foundation — the L4 engine.
 *
 * Per the approved Phase Definition: computeBacktestResult() introduces
 * no new statistical logic. It is a pure composition of existing L3
 * functions — applyFilterGroup() (filterEngine.ts), summarizeTrades()
 * (rolling.ts), buildEquitySequence()/computeDrawdown() (drawdown.ts),
 * computeStreaks()/getAverageStreaks()/getLongestStreaks() (streaks.ts),
 * and computeCoreAnalytics() (analytics.ts) — run against the subset of
 * trades filterGroup matches.
 *
 * Pure and synchronous: no network I/O, no LocalStorage access, no
 * React. Persistence (services/storage.js) and state (hooks/
 * useBacktests.ts) are separate, later steps layered on top of this
 * function, not part of it.
 *
 * The equity sequence (EquityPoint[]) is computed once, then used both
 * for drawdown and to persist the raw cumulative equity path so saved
 * results remain immutable when underlying trades later change.
 *
 * id/createdAt are generated here, not by the caller — matching
 * filterEngine.ts's own createSavedFilter()/createFilterGroup()
 * precedent for calculations/ factory functions.
 */

import { applyFilterGroup, type FilterGroup } from './filterEngine.js';
import type { EnrichedTrade } from './tradeCalc.js';
import { summarizeTrades } from './rolling.js';
import { buildEquitySequence, computeDrawdown } from './drawdown.js';
import { computeStreaks, getAverageStreaks, getLongestStreaks } from './streaks.js';
import { computeCoreAnalytics, withRecoveryFactor } from './analytics.js';
import { nextId } from './idGenerator.js';
import type { BacktestResult } from '@apptypes/backtest.js';

function containsOnlyFiniteNumbers(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value === null || value === undefined || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(containsOnlyFiniteNumbers);
  return Object.values(value as Record<string, unknown>).every(containsOnlyFiniteNumbers);
}

/**
 * Run a backtest: apply filterGroup to trades, then compute the full
 * stats bundle over the matched subset using only existing, already-
 * verified L3 functions.
 *
 * FORMULA:     matched = applyFilterGroup(trades, filterGroup); every
 *              other field is that same L3 function called directly on
 *              `matched`, with no intermediate transformation.
 * SOURCE:      Composition only — see file header. Every individual
 *              formula is already characterized by tradeCalc.test.ts /
 *              drawdown.test.ts / streaks.test.ts.
 * ASSUMPTIONS: `trades` is already enriched (enrichTrades() has been
 *              called by the caller) — matches every other L3 consumer
 *              in this codebase, which enriches once and passes the
 *              result to whichever analytics functions it needs.
 * EDGE CASES:  An empty `matched` set (including the documented "empty
 *              conditions array matches everything" case applied to an
 *              empty `trades` input) produces the same empty baselines
 *              each underlying L3 function already documents for zero
 *              trades — this function adds no special-casing of its own.
 */
export function computeBacktestResult(
  filterGroup: FilterGroup,
  trades: EnrichedTrade[],
  startingCapital: number,
  name?: string,
): BacktestResult | null {
  const matched = applyFilterGroup(trades, filterGroup);
  const equitySequence = buildEquitySequence(matched, startingCapital);
  if (equitySequence === null) return null;
  const drawdown = computeDrawdown(equitySequence);
  if (drawdown === null) return null;

  const result: BacktestResult = {
    id:        nextId('backtest'),
    name:      name || 'Untitled Backtest',
    createdAt: Date.now(),

    filterGroup,
    startingCapital,

    matchedTradeIds: matched.map((t) => t._tid),
    tradeCount:      matched.length,
    equityPath:      equitySequence.slice(1).map((p) => p.equity),

    summary:        summarizeTrades(matched),
    drawdown,
    streaks:        computeStreaks(matched),
    averageStreaks: getAverageStreaks(matched),
    longestStreaks: getLongestStreaks(matched),
    core:           withRecoveryFactor(computeCoreAnalytics(matched), drawdown.maxDrawdownDollar),
  };

  return containsOnlyFiniteNumbers(result) ? result : null;
}
