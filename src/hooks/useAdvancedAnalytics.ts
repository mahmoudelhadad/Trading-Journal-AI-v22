/**
 * hooks/useAdvancedAnalytics.ts
 *
 * Phase 8 - Analytics Engine hook.
 *
 * Wires together the new calculation modules (analytics.ts, drawdown.ts,
 * streaks.ts, rolling.ts) into a single memoised hook, following the same
 * pattern established by useAnalytics.ts (Phase 2B) and useTrades.ts
 * (Phase 2B): pure computation, memoised on the trades array reference.
 *
 * This hook is ADDITIVE - it does not replace or modify useAnalytics.ts,
 * which remains available for basic summary stats. useAdvancedAnalytics
 * is intended for future pages (Equity - Phase 9, Strategy - Phase 11,
 * Insights - Phase 12) that need the full metrics surface from the
 * approved migration plan's "Advanced Analytics" section.
 *
 * No existing hook, page, or component is modified to consume this yet -
 * per Phase 8 instructions ("do not redesign any UI"), wiring it into
 * actual pages is deferred to the phases that build those pages.
 */

import { useMemo } from 'react';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import { computeCoreAnalytics, withRecoveryFactor, type CoreAnalytics } from '@calculations/analytics.js';
import { computeDrawdownFromTrades, type DrawdownResult } from '@calculations/drawdown.js';
import {
  computeStreaks, getAllStreaks, getAverageStreaks, getLongestStreaks,
  type StreakResult, type StreakRun, type AverageStreaks, type LongestStreaks,
} from '@calculations/streaks.js';
import {
  aggregateByPeriod, getTradeFrequency, getStandardRollingWindows,
  type PeriodStats, type TradeFrequency,
} from '@calculations/rolling.js';

// Types

export interface AdvancedAnalytics {
  core:       CoreAnalytics;
  drawdown:   DrawdownResult;
  streaks:    StreakResult;
  allStreaks: StreakRun[];
  averageStreaks: AverageStreaks;
  longestStreaks: LongestStreaks;
  frequency:  TradeFrequency;
  daily:      PeriodStats[];
  weekly:     PeriodStats[];
  monthly:    PeriodStats[];
  rolling:    { last30: PeriodStats; last90: PeriodStats; last365: PeriodStats };
}

/**
 * useAdvancedAnalytics
 *
 * @param trades - Enriched trades (already filtered as needed by the caller)
 * @param startingCapital - Starting capital for drawdown/equity calculations
 */
export function useAdvancedAnalytics(
  trades: EnrichedTrade[],
  startingCapital: number,
): AdvancedAnalytics {
  return useMemo<AdvancedAnalytics>(() => {
    const drawdown = computeDrawdownFromTrades(trades, startingCapital);
    const coreBase = computeCoreAnalytics(trades);
    const core = withRecoveryFactor(coreBase, drawdown.maxDrawdownDollar);

    return {
      core,
      drawdown,
      streaks: computeStreaks(trades),
      allStreaks: getAllStreaks(trades),
      averageStreaks: getAverageStreaks(trades),
      longestStreaks: getLongestStreaks(trades),
      frequency: getTradeFrequency(trades),
      daily:   aggregateByPeriod(trades, 'day'),
      weekly:  aggregateByPeriod(trades, 'week'),
      monthly: aggregateByPeriod(trades, 'month'),
      rolling: getStandardRollingWindows(trades),
    };
  }, [trades, startingCapital]);
}
