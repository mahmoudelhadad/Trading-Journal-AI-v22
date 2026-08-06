/**
 * pages/Backtest.tsx
 *
 * Backtesting UI — Backtest page.
 *
 * NEW page — no original-app equivalent. Wires the Backtesting
 * Foundation (calculations/backtest.ts + hooks/useBacktests.ts, both
 * already complete and tested) into a reachable tab.
 *
 * The page owns useBacktests() and performs the run. BacktestRunner
 * only defines the strategy and delegates upward via onRun — it never
 * touches the hook. This keeps the single storage-writing path in one
 * place, matching how every other page in this codebase owns its data
 * concerns and passes results down to presentational children.
 *
 * useBacktests() is called page-locally rather than lifted into
 * App.jsx because backtest results are Class B, unsynced, local-only
 * data (AD-014) with no consumer on any other tab.
 *
 * TRADE SET — this page is deliberately the ONE page that does NOT
 * receive the globally-filtered `trades` array every other page takes.
 * It receives the UNFILTERED `allTrades` instead, because a stored
 * result's `filterGroup` is the complete strategy definition (see
 * types/backtest.ts). Pre-filtering by the global account/market bar
 * would make a stored result not self-describing — it would have been
 * run against a narrower set than its own filterGroup records. The
 * prop is named `allTrades` so this difference is visible at the call
 * site in App.jsx rather than hidden behind a shared prop name.
 *
 * `accounts` is carried for the starting-capital default only.
 */

import React, { useMemo, useState } from 'react';
import { EmptyState } from '@components/ui/EmptyState.js';
import { BacktestRunner } from '@components/backtest/BacktestRunner.js';
import { BacktestResultsList } from '@components/backtest/BacktestResultsList.js';
import { BacktestResultView } from '@components/backtest/BacktestResultView.js';
import { BacktestComparison } from '@components/backtest/BacktestComparison.js';
import { useBacktests } from '@hooks/useBacktests.js';
import type { EquityCurvePoint } from '@components/charts/EquityCurveChart.js';
import type { BacktestComparisonPoint } from '@components/charts/BacktestComparisonChart.js';
import type { BacktestResult } from '@apptypes/backtest.js';
import type { FilterGroup } from '@calculations/filterEngine.js';
import {
  finiteOrNull, isFiniteNumber,
  type EnrichedTrade,
} from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface BacktestPageProps {
  /** UNFILTERED enriched trades — see file header for why this differs from every other page */
  allTrades: EnrichedTrade[];
  accounts:  Account[];
}

// ─── Component ───────────────────────────────────────────────

export function BacktestPage({ allTrades, accounts }: BacktestPageProps) {
  const { backtestResults, runBacktest, renameBacktestResult, deleteBacktestResult } = useBacktests();

  // Selected result — set from the id runBacktest() returns
  // synchronously, or from a click in the results list.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Second result for side-by-side comparison. Added here because the
  // comparison shaping memo below cannot pick a second result without
  // it; the Compare control that sets it is wired in a later step.
  const [comparisonId, setComparisonId] = useState<string | null>(null);

  // The run itself lives in the page, per the approved data flow: the
  // runner defines the strategy and delegates upward, it never touches
  // the hook. `allTrades` is passed UNFILTERED — see file header.
  function handleRun(filterGroup: FilterGroup, startingCapital: number, name: string) {
    const result = runBacktest(filterGroup, allTrades, startingCapital, name);
    if (!result.success) {
      setRunError(result.reason === 'limit_reached'
        ? 'Saved Backtest limit reached. Delete an existing saved result before running another Backtest.'
        : 'Backtest could not be calculated because one or more required numeric calculations were unavailable.');
      return;
    }
    setRunError(null);
    setSelectedId(result.result.id);
  }

  // Deleting the currently-selected result clears the selection, so
  // the page does not keep pointing at a record that no longer exists.
  function handleDelete(id: string) {
    deleteBacktestResult(id);
    if (backtestResults.length <= 50) setRunError(null);
    if (id === selectedId) setSelectedId(null);
  }

  // Toggling: pressing Compare on the row that is already the
  // comparison target clears it, so the page returns to the single
  // result view without needing a separate control.
  function handleCompare(id: string) {
    setComparisonId((prev) => (prev === id ? null : id));
  }

  const selectedResult = useMemo(
    () => backtestResults.find((r) => r.id === selectedId) ?? null,
    [backtestResults, selectedId],
  );

  // ── Trade resolution ─────────────────────────────────────────
  // matchedTradeIds are _tid values captured at RUN time and are not
  // guaranteed to still resolve — the underlying trades may since have
  // been edited away or deleted (see types/backtest.ts). Ids that no
  // longer resolve are dropped and counted, never silently ignored.
  //
  // Keyed off allTrades alone so it is not rebuilt when the selection
  // changes — the map's contents do not depend on which result is
  // selected.
  const tradeMap = useMemo(() => {
    const m = new Map<number, EnrichedTrade>();
    allTrades.forEach((t) => m.set(t._tid, t));
    return m;
  }, [allTrades]);

  const resolved = useMemo(() => {
    if (!selectedResult) return { matched: [] as EnrichedTrade[], unresolvedCount: 0 };

    const matched = selectedResult.matchedTradeIds
      .map((id) => tradeMap.get(id))
      .filter((t): t is EnrichedTrade => t !== undefined);

    return {
      matched,
      unresolvedCount: selectedResult.matchedTradeIds.length - matched.length,
    };
  }, [selectedResult, tradeMap]);

  // ── Equity shaping ───────────────────────────────────────────
  // EquityCurveChart expects {x, eq, above, below, ref} — a shape
  // buildEquitySequence() does not produce (it returns {index, equity})
  // and cannot, since the above/below split is a presentation-time
  // derivation. This rebuilds the running total inline, matching
  // pages/Equity.tsx's existing pattern exactly so both pages' curves
  // stay visually identical. Deliberately NOT extracted to a shared
  // helper — see the Phase Definition's reuse boundary.
  //
  // startingCapital comes from the STORED result, not from accounts:
  // it is what the run was actually executed with.
  const equity = useMemo(() => {
    const startingCapital = selectedResult?.startingCapital ?? 0;
    if (!isFiniteNumber(startingCapital)) return { equityData: null, currentEquity: null };

    if (selectedResult?.equityPath !== undefined) {
      const equityData: EquityCurvePoint[] = [
        { x: 0, eq: startingCapital, above: startingCapital, below: startingCapital, ref: startingCapital },
      ];

      for (let i = 0; i < selectedResult.equityPath.length; i++) {
        const rawEquity = selectedResult.equityPath[i];
        const eq = finiteOrNull(Math.round(rawEquity * 100) / 100);
        if (eq === null) return { equityData: null, currentEquity: null };
        equityData.push({
          x:     i + 1,
          eq,
          above: eq >= startingCapital ? eq : startingCapital,
          below: eq <  startingCapital ? eq : startingCapital,
          ref:   startingCapital,
        });
      }

      return {
        equityData,
        currentEquity: selectedResult.equityPath.length > 0
          ? selectedResult.equityPath[selectedResult.equityPath.length - 1]
          : startingCapital,
      };
    }

    let running: number | null = startingCapital;
    const equityData: EquityCurvePoint[] = [
      { x: 0, eq: startingCapital, above: startingCapital, below: startingCapital, ref: startingCapital },
    ];

    for (let i = 0; i < resolved.matched.length; i++) {
      const t = resolved.matched[i];
      if (isFiniteNumber(t._netPL) && running !== null) running = finiteOrNull(running + t._netPL);
      if (running === null) return { equityData: null, currentEquity: null };
      const eq = finiteOrNull(Math.round(running * 100) / 100);
      if (eq === null) return { equityData: null, currentEquity: null };
      equityData.push({
        x:     i + 1,
        eq,
        above: eq >= startingCapital ? eq : startingCapital,
        below: eq <  startingCapital ? eq : startingCapital,
        ref:   startingCapital,
      });
    }

    return { equityData, currentEquity: running };
  }, [selectedResult, resolved]);

  const comparisonResult = useMemo(
    () => backtestResults.find((r) => r.id === comparisonId) ?? null,
    [backtestResults, comparisonId],
  );

  // ── Comparison shaping ───────────────────────────────────────
  // Each series is normalized to PERCENTAGE RETURN against its own
  // stored startingCapital, so two runs with different capitals share
  // one Y-axis (see BacktestComparisonChart's header).
  //
  // The per-point series is rebuilt from matchedTradeIds because the
  // equity/return curve is deliberately NOT persisted — types/
  // backtest.ts documents it as regenerable from matchedTradeIds +
  // startingCapital. No STORED analytic (summary / drawdown / streaks
  // / core) is recomputed or consulted here.
  //
  // Unresolvable ids are skipped, exactly as the single-result view
  // does. Unequal-length runs are preserved: the shorter series ends
  // and every later point is null, which the chart renders as a stop
  // rather than bridging.
  const comparisonData = useMemo<BacktestComparisonPoint[]>(() => {
    if (selectedResult === null || comparisonResult === null) return [];

    const returnSeries = (result: BacktestResult): (number | null)[] | null => {
      const cap = result.startingCapital;
      if (!isFiniteNumber(cap)) return null;
      if (result.equityPath !== undefined) {
        const series: (number | null)[] = [cap > 0 ? 0 : null];
        for (const equityPoint of result.equityPath) {
          if (!isFiniteNumber(equityPoint)) return null;
          const returnPct = cap > 0 ? finiteOrNull(((equityPoint - cap) / cap) * 100) : null;
          if (cap > 0 && returnPct === null) return null;
          series.push(returnPct);
        }
        return series;
      }
      // cap <= 0 makes a percentage return undefined — emit null
      // rather than Infinity/NaN.
      const series: (number | null)[] = [cap > 0 ? 0 : null];
      let running: number | null = cap;

      result.matchedTradeIds.forEach((id) => {
        const t = tradeMap.get(id);
        if (t === undefined) return;
        if (isFiniteNumber(t._netPL) && running !== null) running = finiteOrNull(running + t._netPL);
        if (running === null) return;
        const returnPct = cap > 0 ? finiteOrNull(((running - cap) / cap) * 100) : null;
        if (cap > 0 && returnPct === null) { running = null; return; }
        series.push(returnPct);
      });

      return running === null ? null : series;
    };

    const a = returnSeries(selectedResult);
    const b = returnSeries(comparisonResult);
    if (a === null || b === null) return [];

    const points: BacktestComparisonPoint[] = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      points.push({ x: i, a: a[i] ?? null, b: b[i] ?? null });
    }
    return points;
  }, [selectedResult, comparisonResult, tradeMap]);

  return (
    <div>
      <BacktestRunner allTrades={allTrades} accounts={accounts} onRun={handleRun} />
      {runError && (
        <div style={{ color: '#EF4444', fontSize: 11, marginTop: 8 }}>{runError}</div>
      )}

      <div style={{ marginTop: 14 }}>
        {backtestResults.length === 0 ? (
          <EmptyState icon="🧪" message="No backtests yet" />
        ) : (
          <BacktestResultsList
            results={backtestResults}
            selectedId={selectedId}
            comparisonId={comparisonId}
            onSelect={setSelectedId}
            onCompare={handleCompare}
            onRename={renameBacktestResult}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* Two results selected → the comparison replaces the single
          result view, per the approved flow. */}
      {selectedResult !== null && comparisonResult !== null ? (
        <div style={{ marginTop: 14 }}>
          <BacktestComparison
            resultA={selectedResult}
            resultB={comparisonResult}
            legacyA={selectedResult.equityPath === undefined}
            legacyB={comparisonResult.equityPath === undefined}
            data={comparisonData}
            onClose={() => setComparisonId(null)}
          />
        </div>
      ) : selectedResult !== null && equity.equityData !== null && equity.currentEquity !== null ? (
        <div style={{ marginTop: 14 }}>
          <BacktestResultView
            result={selectedResult}
            equityData={equity.equityData}
            currentEquity={equity.currentEquity}
            unresolvedCount={resolved.unresolvedCount}
            legacy={selectedResult.equityPath === undefined}
          />
        </div>
      ) : selectedResult !== null ? (
        <div style={{ marginTop: 14 }}><EmptyState message="This Backtest analysis is unavailable." /></div>
      ) : null}
    </div>
  );
}
