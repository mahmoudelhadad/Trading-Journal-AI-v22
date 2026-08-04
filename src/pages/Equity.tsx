/**
 * pages/Equity.tsx
 *
 * Phase 9 — Equity page.
 *
 * NEW page — no direct original-app equivalent (the original app only
 * had an inline equity curve on the Dashboard, computed relative to
 * starting capital across all filtered trades — see Dashboard.tsx,
 * Phase 6). This page provides a DEDICATED, deeper view: Equity Curve,
 * Drawdown Curve, Daily/Weekly/Monthly P&L, and the drawdown/recovery
 * metrics from Phase 8's Analytics Engine.
 *
 * REUSE, NOT DUPLICATION (per Phase 9 rule 3):
 * - Equity curve rendering reuses the EXACT SAME <EquityCurveChart>
 *   component built in Phase 6 for the Dashboard page — not a new
 *   equity-chart component. Only the data-shaping (buildEquitySequence
 *   -> EquityCurvePoint[]) differs, done inline in this page, matching
 *   the established pattern where pages own their own data prep
 *   (see Dashboard.tsx, Phase 6).
 * - Drawdown analysis reuses calculations/drawdown.ts's
 *   computeDrawdownFromTrades() via the useAdvancedAnalytics() hook
 *   (Phase 8) — this is the FIRST page to actually consume that hook,
 *   which was built ahead of any page needing it.
 * - Daily/Weekly/Monthly P&L reuse calculations/rolling.ts's
 *   aggregateByPeriod() — the same function, called three times with
 *   different granularity, not three separate aggregation
 *   implementations.
 * - KPI, Card, EmptyState are the exact Phase 3 UI atoms, unmodified.
 *
 * "Balance Curve" (from the migration plan's Equity Analytics list) is
 * NOT rendered as a separate chart in this page. This app's data model
 * has no concept of an open position's floating/unrealized P&L
 * (EnrichedTrade only has a single, final _netPL per trade — there is
 * no "currently open, still moving" state tracked anywhere in the
 * codebase). Balance (realized-only) and Equity (realized + floating)
 * are therefore mathematically IDENTICAL in this app today. Rather
 * than rendering a second, visually-identical chart under a different
 * label, this page renders one Equity Curve and documents this
 * equivalence here — see the Phase 9 report for a suggested handling
 * of this if/when floating P&L is ever introduced.
 *
 * "Monthly Returns" / "Cumulative Returns" (both %, not $) ARE new,
 * small derivations computed inline in this page (dividing existing
 * $ figures by starting capital) — not extracted to a shared
 * calculation module, since each is a single division with no
 * reusable complexity, consistent with how Dashboard.tsx (Phase 6)
 * already computes its own simple derived percentages inline.
 */

import React, { useMemo } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { KPI } from '@components/ui/KPI.js';
import { Card } from '@components/ui/Card.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { EquityCurveChart, DrawdownChart, PeriodPLChart } from '@components/charts/index.js';
import type { EquityCurvePoint } from '@components/charts/EquityCurveChart.js';
import { useAdvancedAnalytics } from '@hooks/useAdvancedAnalytics.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface EquityPageProps {
  trades:    EnrichedTrade[];
  accounts:  Account[];
  /** 'all' or a specific account ID — same convention as DashboardPageProps */
  accFilter: string;
}

const sectionTitle: React.CSSProperties = { color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 };

// ─── Component ───────────────────────────────────────────────

export function EquityPage({ trades, accounts, accFilter }: EquityPageProps) {
  // Starting capital — same convention as Dashboard.tsx (Phase 6):
  // 'all' sums every account's capital; otherwise use the single
  // selected account's capital.
  // Phase 17: memoized — this is a pure caching change, every
  // expression below is unchanged from the prior implementation.
  const startingCapital = useMemo(() => (
    accFilter === 'all'
      ? accounts.reduce((s, a) => s + a.capital, 0)
      : (accounts.find((a) => a.id === accFilter)?.capital ?? 0)
  ), [accounts, accFilter]);

  const { drawdown, daily, weekly, monthly } = useAdvancedAnalytics(trades, startingCapital);

  // Phase 17: remaining derived data wrapped in one useMemo — same
  // rationale as Dashboard.tsx (see MIGRATION_NOTES.md Phase 17 entry).
  const derived = useMemo(() => {
    const n = trades.length;
    const netProfit = trades.reduce((s, t) => s + (t._netPL ?? 0), 0);
    const currentEquity = startingCapital + netProfit;

    // ── Map drawdown.ts's equity sequence into EquityCurveChart's shape ──
    // EquityCurveChart (Phase 6) expects {x, eq, above, below, ref} —
    // built here by re-deriving the same sequence via the drawdown
    // module's rollingDrawdown (which already carries index + implied
    // equity via peak - drawdown) is NOT reused for this, since it only
    // stores drawdown, not raw equity. Instead we rebuild the mapping
    // from netPL directly, matching Dashboard.tsx's exact prior pattern
    // (Phase 6) for 1:1 visual consistency between the two pages' charts.
    let running = startingCapital;
    const eqColored: EquityCurvePoint[] = [{ x: 0, eq: startingCapital, above: startingCapital, below: startingCapital, ref: startingCapital }];
    trades.forEach((t, i) => {
      running += t._netPL ?? 0;
      const eq = Math.round(running * 100) / 100;
      eqColored.push({
        x: i + 1,
        eq,
        above: eq >= startingCapital ? eq : startingCapital,
        below: eq <  startingCapital ? eq : startingCapital,
        ref: startingCapital,
      });
    });

    // ── Cumulative return % at the latest point ──
    const cumulativeReturnPct = startingCapital > 0
      ? ((currentEquity - startingCapital) / startingCapital) * 100
      : null;

    return { n, netProfit, currentEquity, eqColored, cumulativeReturnPct };
  }, [trades, startingCapital]);

  const { n, netProfit, currentEquity, eqColored, cumulativeReturnPct } = derived;

  // ── Monthly returns (% of starting capital, non-compounding) ──
  // See file header for why this uses the fixed starting capital as
  // the denominator rather than compounding capital-at-start-of-month.
  // Phase 17: memoized — depends on `monthly` (already memoized inside
  // useAdvancedAnalytics) and startingCapital.
  const monthlyReturns = useMemo(() => monthly.map((m) => ({
    key: m.key,
    returnPct: startingCapital > 0 ? (m.netPL / startingCapital) * 100 : null,
  })), [monthly, startingCapital]);

  const noData = <EmptyState message="Add trades to see equity data" />;

  return (
    <div>
      {/* ── KPI row ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <KPI label="Current Equity" value={`$${Math.round(currentEquity).toLocaleString()}`} color={C.gold} sub={`Start: $${startingCapital.toLocaleString()}`} />
        <KPI label="Cumulative Return" value={cumulativeReturnPct !== null ? `${cumulativeReturnPct >= 0 ? '+' : ''}${cumulativeReturnPct.toFixed(1)}%` : '—'} color={(cumulativeReturnPct ?? 0) >= 0 ? C.green : C.red} />
        <KPI label="Max Drawdown" value={n > 0 ? `-$${drawdown.maxDrawdownDollar.toFixed(0)}` : '—'} color={C.red} sub={n > 0 ? `-${drawdown.maxDrawdownPercent.toFixed(1)}%` : undefined} />
        <KPI label="Current Drawdown" value={n > 0 ? `-$${drawdown.currentDrawdownDollar.toFixed(0)}` : '—'} color={drawdown.currentDrawdownDollar > 0 ? C.gold : C.green} sub={n > 0 ? `-${drawdown.currentDrawdownPercent.toFixed(1)}%` : undefined} />
        <KPI label="Drawdown Duration" value={n > 0 ? `${drawdown.drawdownDurationTrades} trades` : '—'} color={C.dim} />
        <KPI
          label="Recovery Time"
          value={drawdown.recoveryTimeTrades !== null ? `${drawdown.recoveryTimeTrades} trades` : n > 0 ? 'Not yet' : '—'}
          color={drawdown.recoveryTimeTrades !== null ? C.green : C.dim}
        />
      </div>

      {/* ── Equity Curve + Drawdown Curve ─────────────────────── */}
      <Card>
        <div style={sectionTitle}>📈 Equity Curve</div>
        {n === 0 ? noData : (
          <EquityCurveChart data={eqColored} totalCap={startingCapital} curCap={currentEquity} height={200} />
        )}
      </Card>

      <Card>
        <div style={sectionTitle}>📉 Drawdown Curve</div>
        {n === 0 ? noData : (
          <DrawdownChart data={drawdown.rollingDrawdown} height={160} />
        )}
      </Card>

      {/* ── Daily / Weekly / Monthly P&L ──────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
        <Card marginBottom={0}>
          <div style={sectionTitle}>Daily P/L</div>
          {daily.length === 0 ? noData : <PeriodPLChart data={daily} granularity="day" height={160} />}
        </Card>
        <Card marginBottom={0}>
          <div style={sectionTitle}>Weekly P/L</div>
          {weekly.length === 0 ? noData : <PeriodPLChart data={weekly} granularity="week" height={160} />}
        </Card>
        <Card marginBottom={0}>
          <div style={sectionTitle}>Monthly P/L</div>
          {monthly.length === 0 ? noData : <PeriodPLChart data={monthly} granularity="month" height={160} />}
        </Card>
      </div>

      {/* ── Monthly Returns table ─────────────────────────────── */}
      <Card>
        <div style={sectionTitle}>Monthly Returns (% of starting capital)</div>
        {monthlyReturns.length === 0 ? noData : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {monthlyReturns.map((m) => {
              const label = new Date(`${m.key}-01`).toLocaleDateString('en', { month: 'short', year: '2-digit' });
              const color = m.returnPct === null ? C.dim : m.returnPct >= 0 ? C.green : C.red;
              return (
                <div key={m.key} style={{ background: C.row, borderRadius: 8, border: `1px solid ${C.border}`, padding: '8px 14px', textAlign: 'center', flex: '1 1 90px' }}>
                  <div style={{ color: C.dim, fontSize: 9 }}>{label}</div>
                  <div style={{ color, fontWeight: 700, fontSize: 13 }}>
                    {m.returnPct !== null ? `${m.returnPct >= 0 ? '+' : ''}${m.returnPct.toFixed(2)}%` : '—'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
