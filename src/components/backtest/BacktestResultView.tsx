/**
 * components/backtest/BacktestResultView.tsx
 *
 * Backtesting UI — a single stored backtest result.
 *
 * PURELY PRESENTATIONAL. Every number rendered here is read directly
 * off the stored BacktestResult or arrives already shaped as a prop.
 * This component computes nothing: no filtering, no equity building,
 * no analytics, no persistence.
 *
 * Stored scalars (summary / drawdown / core) are displayed AS STORED
 * and are never recomputed — they are the historically accurate record
 * of what the run produced. `currentEquity` is the one derived value,
 * and it is derived by the page (see pages/Backtest.tsx), not here.
 *
 * `unresolvedCount` reports how many matchedTradeIds no longer resolve
 * to a live trade (edited or deleted since the run). It is surfaced
 * rather than hidden, because when it is non-zero the rebuilt equity
 * curve covers fewer trades than the stored scalars describe.
 *
 * KPI formatting follows the existing page conventions verbatim:
 * `wr` is a 0–1 fraction rendered as a percentage (pages/Dashboard.tsx),
 * the drawdown pair mirrors pages/Equity.tsx, and '—' is the codebase
 * null placeholder.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { KPI } from '@components/ui/KPI.js';
import { Badge } from '@components/ui/Badge.js';
import { StatBox } from '@components/ui/StatBox.js';
import { TableHeader, TableCell } from '@components/ui/Table.js';
import { fr, getSignColor } from '@calculations/formatters.js';
import { EquityCurveChart } from '@components/charts/EquityCurveChart.js';
import { DrawdownChart } from '@components/charts/DrawdownChart.js';
import type { EquityCurvePoint } from '@components/charts/EquityCurveChart.js';
import type { BacktestResult } from '@apptypes/backtest.js';

// ─── Types ───────────────────────────────────────────────────

export interface BacktestResultViewProps {
  result:          BacktestResult;
  /** Already shaped by the page — see pages/Backtest.tsx's equity memo */
  equityData:      EquityCurvePoint[];
  /** Derived by the page from the resolvable matched trades */
  currentEquity:   number;
  /** matchedTradeIds that no longer resolve to a live trade */
  unresolvedCount: number;
  legacy?:          boolean;
}

// ─── Display helper ──────────────────────────────────────────

/**
 * Null-safe plain-number rendering for ratios and scores.
 *
 * calculations/formatters.ts's `fr` bundle covers R (fr.r), USD
 * (fr.usd) and fractions (fr.pct), all of which are reused below —
 * but every `fr` variant prefixes a sign, which reads wrong on a
 * ratio ("+1.80" payoff ratio). This is display formatting only.
 */
const num = (v: number | null): string => (v === null ? '—' : v.toFixed(2));

// ─── Component ───────────────────────────────────────────────

export function BacktestResultView({ result, equityData, currentEquity, unresolvedCount, legacy }: BacktestResultViewProps) {
  const { summary, drawdown, core, streaks, averageStreaks, longestStreaks, startingCapital } = result;

  // Label/value pairs for the core analytics table. Every value is a
  // stored field passed through a formatter — no derivation.
  const coreRows: Array<[string, string]> = [
    ['Expectancy (R)',      fr.r(core.expectancyR)],
    ['Expectancy ($)',      fr.usd(core.expectancyDollar)],
    ['Recovery Factor',     num(core.recoveryFactor)],
    ['Payoff Ratio',        num(core.payoffRatio)],
    ['SQN',                 num(core.sqn)],
    ['Expectancy Score',    num(core.expectancyScore)],
    ['Consistency Score',   num(core.consistencyScore)],

    ['Avg Winner ($)',      fr.usd(core.avgWinnerDollar)],
    ['Avg Loser ($)',       fr.usd(core.avgLoserDollar)],
    ['Avg Win (R)',         fr.r(core.avgWinR)],
    ['Avg Loss (R)',        fr.r(core.avgLossR)],
    ['Avg Planned R',       fr.r(core.avgPlannedR)],
    ['Avg Actual R',        fr.r(core.avgActualR)],
    ['Avg Risk ($)',        fr.usd(core.avgRiskDollar)],
    ['Avg Reward ($)',      fr.usd(core.avgRewardDollar)],
    ['Avg R:R',             num(core.avgRR)],

    ['Largest Winner ($)',  fr.usd(core.largestWinnerDollar)],
    ['Largest Loser ($)',   fr.usd(core.largestLoserDollar)],
    ['Best Day',            core.largestWinningDay ? `${core.largestWinningDay.date} (${fr.usd(core.largestWinningDay.netPL)})` : '—'],
    ['Worst Day',           core.largestLosingDay  ? `${core.largestLosingDay.date} (${fr.usd(core.largestLosingDay.netPL)})`  : '—'],

    ['Win % (all trades)',       fr.pct(core.winPct)],
    ['Loss % (all trades)',      fr.pct(core.lossPct)],
    ['Breakeven % (all trades)', fr.pct(core.bePct)],

    ['Net Profit',          fr.usd(core.netProfit)],
    ['Gross Profit',        fr.usd(core.grossProfit)],
    ['Gross Loss',          fr.usd(core.grossLoss)],

    ['Kelly %',             fr.pct(core.kellyPercent)],
    ['Risk of Ruin',        core.riskOfRuinPercent === null ? '—' : `${core.riskOfRuinPercent.toFixed(1)}%`],

    ['Avg Holding (min)',         num(core.avgHoldingMins)],
    ['Avg Winning Hold (min)',    num(core.avgWinningHoldingMins)],
    ['Avg Losing Hold (min)',     num(core.avgLosingHoldingMins)],
    ['Avg Commission',            fr.usd(core.avgCommission)],
    ['Commission % of Gross',     fr.pct(core.commissionPct)],
  ];

  return (
    <Card>
      {/* ── Header ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: C.white, fontSize: 12, fontWeight: 700 }}>{result.name}</div>
          <div style={{ color: C.dim, fontSize: 10 }}>{new Date(result.createdAt).toLocaleString()}</div>
        </div>
        {unresolvedCount > 0 && (
          <Badge color={C.gold}>
            {`${unresolvedCount} trade${unresolvedCount === 1 ? '' : 's'} no longer available`}
          </Badge>
        )}
      </div>

      {legacy && (
        <div style={{ marginBottom: 10 }}>
          <Badge color={C.gold}>
            Legacy result — Equity Curve and Ending Equity are reconstructed from current journal trades and are not part of the historical snapshot. All other metrics are stored snapshot values.
          </Badge>
        </div>
      )}

      {/* ── KPI row ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <KPI
          label="Net P&L"
          value={`${summary.netPL >= 0 ? '+' : '-'}$${Math.abs(summary.netPL).toFixed(0)}`}
          color={getSignColor(summary.netPL)}
        />
        <KPI
          label="Win Rate (W/L only)"
          value={summary.wr !== null ? `${(summary.wr * 100).toFixed(1)}%` : '—'}
          color={C.blue}
          sub={`${summary.green}W / ${summary.red}L`}
        />
        <KPI
          label="Profit Factor"
          value={core.profitFactor !== null ? core.profitFactor.toFixed(2) : '—'}
          color={C.purple}
        />
        <KPI
          label="Max Drawdown"
          value={`-$${drawdown.maxDrawdownDollar.toFixed(0)}`}
          color={C.red}
          sub={`-${drawdown.maxDrawdownPercent.toFixed(1)}%`}
        />
        <KPI
          label="Trades"
          value={result.tradeCount}
          color={C.dim}
          sub={`Total R: ${summary.totalR.toFixed(2)}`}
        />
        <KPI
          label="Ending Equity"
          value={`$${Math.round(currentEquity).toLocaleString()}`}
          color={C.gold}
          sub={`Start: $${startingCapital.toLocaleString()}`}
        />
      </div>

      {/* ── Equity curve ─────────────────────────────────────── */}
      {/* Fed straight from the prepared prop — the exact same chart
          component pages/Dashboard.tsx and pages/Equity.tsx render. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📈 Equity Curve</div>
        <EquityCurveChart
          data={equityData}
          totalCap={startingCapital}
          curCap={currentEquity}
        />
      </div>

      {/* ── Drawdown curve ───────────────────────────────────── */}
      {/* rollingDrawdown is stored by computeBacktestResult() in the
          EXACT shape DrawdownChart consumes ({index, drawdownDollar,
          drawdownPercent}), so it is passed straight through — no
          adapter, no reshaping, no recomputation. Unlike the equity
          curve, this is the stored historical record and does NOT
          change when underlying trades are later edited or deleted. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📉 Drawdown</div>
        <DrawdownChart data={drawdown.rollingDrawdown} />
      </div>

      {/* ── Streaks ──────────────────────────────────────────── */}
      {/* Every value below is read straight off the stored record —
          streaks / averageStreaks / longestStreaks were computed by
          computeBacktestResult() at run time. Nothing here iterates
          trades or re-derives a streak. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>🔥 Streaks</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <StatBox
            label="Current Streak"
            value={streaks.type === '' ? '—' : `${streaks.current} ${streaks.type === 'W' ? 'wins' : 'losses'}`}
            color={streaks.type === 'W' ? C.green : streaks.type === 'L' ? C.red : C.dim}
          />
          <StatBox
            label="Longest Win Streak"
            value={`${longestStreaks.longestWinStreak} wins`}
            color={C.green}
          />
          <StatBox
            label="Longest Loss Streak"
            value={`${longestStreaks.longestLossStreak} losses`}
            color={C.red}
          />
          <StatBox
            label="Avg Win Streak"
            value={averageStreaks.avgWinStreak !== null ? averageStreaks.avgWinStreak.toFixed(2) : '—'}
            color={C.green}
          />
          <StatBox
            label="Avg Loss Streak"
            value={averageStreaks.avgLossStreak !== null ? averageStreaks.avgLossStreak.toFixed(2) : '—'}
            color={C.red}
          />
        </div>
      </div>

      {/* ── Core analytics ───────────────────────────────────── */}
      {/* Every row reads a stored field off result.core, computed by
          computeBacktestResult() at run time. Nothing here derives a
          statistic or touches the matched trades. Profit Factor is
          omitted — it is already shown in the KPI row above.

          SCALING (verified against calculations/analytics.ts, not
          assumed): winPct / lossPct / bePct / commissionPct /
          kellyPercent are 0–1 FRACTIONS, so they use fr.pct, which
          multiplies by 100. riskOfRuinPercent is already on a 0–100
          scale, so it is formatted directly. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📊 Core Analytics</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <TableHeader style={{ textAlign: 'left' }}>Metric</TableHeader>
              <TableHeader style={{ textAlign: 'right' }}>Value</TableHeader>
            </tr>
          </thead>
          <tbody>
            {coreRows.map(([label, value], i) => (
              <tr key={label} style={{ background: i % 2 === 0 ? C.row : C.rowAlt }}>
                <TableCell style={{ textAlign: 'left', color: C.dim }}>{label}</TableCell>
                <TableCell style={{ textAlign: 'right' }}>{value}</TableCell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
