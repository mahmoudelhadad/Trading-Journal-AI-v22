/**
 * hooks/useBacktests.ts
 *
 * Backtesting Foundation — CRUD hook over stored backtest results.
 *
 * Follows the exact same hook pattern established by
 * useAdvancedFilters.ts (Phase 14): lazy-init from storage.js, persist
 * via useEffect on change, expose typed CRUD functions. Not consumed by
 * any page in this phase — same "build and validate the capability,
 * wire it into a page with separate approval in a future phase" pattern
 * useAdvancedAnalytics (Phase 8) and useAdvancedFilters (Phase 14) both
 * used.
 *
 * runBacktest() computes via calculations/backtest.ts's
 * computeBacktestResult() (pure) and is the only place that persists a
 * result — the engine itself never touches storage.
 *
 * Caps creation at 50 saved results. At or above the cap, creation is
 * rejected before computation; existing historical results are never
 * trimmed or evicted.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import { computeBacktestResult } from '@calculations/backtest.js';
import type { FilterGroup } from '@calculations/filterEngine.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { BacktestResult } from '@apptypes/backtest.js';

export const MAX_STORED_BACKTEST_RESULTS = 50;

export const canAddBacktestResult = (count: number): boolean =>
  count < MAX_STORED_BACKTEST_RESULTS;

export type RunBacktestResult =
  | { success: true; result: BacktestResult }
  | { success: false; reason: 'limit_reached' }
  | { success: false; reason: 'calculation_unavailable' };

export function createBacktestResultWithinLimit(
  count: number,
  createResult: () => BacktestResult | null,
): RunBacktestResult {
  if (!canAddBacktestResult(count)) return { success: false, reason: 'limit_reached' };
  const result = createResult();
  return result === null
    ? { success: false, reason: 'calculation_unavailable' }
    : { success: true, result };
}

export interface UseBacktestsReturn {
  backtestResults: BacktestResult[];
  runBacktest: (
    filterGroup: FilterGroup,
    trades: EnrichedTrade[],
    startingCapital: number,
    name?: string,
  ) => RunBacktestResult;
  deleteBacktestResult: (id: string) => void;
  renameBacktestResult: (id: string, newName: string) => void;
}

export function useBacktests(): UseBacktestsReturn {
  const { storage } = useUserStorage();
  const [backtestResults, setBacktestResults] = useState<BacktestResult[]>(
    () => storage.loadBacktestResults() as BacktestResult[],
  );
  const resultsRef = useRef(backtestResults);

  useEffect(() => {
    storage.saveBacktestResults(backtestResults);
  }, [storage, backtestResults]);

  const runBacktest = useCallback((
    filterGroup: FilterGroup,
    trades: EnrichedTrade[],
    startingCapital: number,
    name?: string,
  ): RunBacktestResult => {
    const outcome = createBacktestResultWithinLimit(
      resultsRef.current.length,
      () => computeBacktestResult(filterGroup, trades, startingCapital, name),
    );
    if (!outcome.success) return outcome;
    const result = outcome.result;
    const next = [...resultsRef.current, result];
    resultsRef.current = next;
    setBacktestResults(next);
    return { success: true, result };
  }, []);

  const deleteBacktestResult = useCallback((id: string) => {
    const next = resultsRef.current.filter((r) => r.id !== id);
    resultsRef.current = next;
    setBacktestResults(next);
  }, []);

  const renameBacktestResult = useCallback((id: string, newName: string) => {
    const next = resultsRef.current.map((r) => (r.id === id ? { ...r, name: newName || r.name } : r));
    resultsRef.current = next;
    setBacktestResults(next);
  }, []);

  return { backtestResults, runBacktest, deleteBacktestResult, renameBacktestResult };
}
