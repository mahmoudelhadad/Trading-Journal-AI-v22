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
 * Caps stored results at 50, evicting the oldest (by append order,
 * which matches creation order in this hook) on overflow — the
 * storage-growth mitigation from the approved Phase Definition.
 */
import { useState, useEffect, useCallback } from 'react';
import { loadBacktestResults, saveBacktestResults } from '@services/storage.js';
import { computeBacktestResult } from '@calculations/backtest.js';
import type { FilterGroup } from '@calculations/filterEngine.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { BacktestResult } from '@apptypes/backtest.js';

const MAX_STORED_BACKTEST_RESULTS = 50;

export interface UseBacktestsReturn {
  backtestResults: BacktestResult[];
  runBacktest: (
    filterGroup: FilterGroup,
    trades: EnrichedTrade[],
    startingCapital: number,
    name?: string,
  ) => BacktestResult;
  deleteBacktestResult: (id: string) => void;
  renameBacktestResult: (id: string, newName: string) => void;
}

export function useBacktests(): UseBacktestsReturn {
  const [backtestResults, setBacktestResults] = useState<BacktestResult[]>(
    () => loadBacktestResults() as BacktestResult[],
  );

  useEffect(() => {
    saveBacktestResults(backtestResults);
  }, [backtestResults]);

  const runBacktest = useCallback((
    filterGroup: FilterGroup,
    trades: EnrichedTrade[],
    startingCapital: number,
    name?: string,
  ): BacktestResult => {
    const result = computeBacktestResult(filterGroup, trades, startingCapital, name);
    setBacktestResults((prev) => {
      const next = [...prev, result];
      return next.length > MAX_STORED_BACKTEST_RESULTS
        ? next.slice(next.length - MAX_STORED_BACKTEST_RESULTS)
        : next;
    });
    return result;
  }, []);

  const deleteBacktestResult = useCallback((id: string) => {
    setBacktestResults((prev) => prev.filter((r) => r.id !== id));
  }, []);

  const renameBacktestResult = useCallback((id: string, newName: string) => {
    setBacktestResults((prev) => prev.map((r) => (r.id === id ? { ...r, name: newName || r.name } : r)));
  }, []);

  return { backtestResults, runBacktest, deleteBacktestResult, renameBacktestResult };
}
