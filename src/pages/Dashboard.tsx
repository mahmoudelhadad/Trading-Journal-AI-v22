/**
 * pages/Dashboard.tsx
 *
 * Dashboard page — KPI row + 4 chart rows + Rating Gauge + Setup Type panel.
 *
 * Migrated VERBATIM from the original DashboardTab(props) function.
 * Every derived-data computation (equity curve, monthly R, symbol R,
 * long/short split, hourly R, outcome pie, average rating, setup-type
 * breakdown) is copied exactly, formula-for-formula, from the original
 * inline logic. Only the JSX rendering was split into the chart
 * components created in this same phase.
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same KPI values and formulas (Total Trades, Avg R, Win Rate,
 *   Net P/L, Total R, Capital)
 * - Same equity curve starting-capital logic (per accFilter: 'all' sums
 *   every account's capital; otherwise uses the single selected account)
 * - Same monthly/symbol/hourly aggregation logic
 * - Same Long/Short split logic
 * - Same outcome pie percentage-in-name logic
 * - Same average rating calculation (ignores trades with empty rating)
 * - Same Setup Type panel (A+/A/B/C avg R)
 *
 * Data flow (Phase 6 scope):
 * This page receives `trades` (already filtered by global account/market
 * filters, matching the original `trades` useMemo in App) and `accounts`
 * and `accFilter` as props — mirroring exactly how the original
 * `h(DashboardTab, { trades, accounts, accFilter })` was invoked.
 */

import React, { useMemo } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { KPI } from '@components/ui/KPI.js';
import { Card } from '@components/ui/Card.js';
import { EmptyState } from '@components/ui/EmptyState.js';
import { fr } from '@calculations/formatters.js';
import { summarizeTrades } from '@calculations/rolling.js';
import {
  EquityCurveChart, OutcomePieChart, LongShortChart,
  HourlyRChart, MonthlyRChart, SymbolRChart, RatingGauge,
} from '@components/charts/index.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface DashboardPageProps {
  trades:    EnrichedTrade[];
  accounts:  Account[];
  /** 'all' or a specific account ID — matches original accFilter prop */
  accFilter: string;
}

// ─── Component ───────────────────────────────────────────────

export function DashboardPage({ trades, accounts, accFilter }: DashboardPageProps) {
  // Phase 17: all derived data below is wrapped in a single useMemo.
  // This is a PURE caching change — every expression inside is copied
  // verbatim from the original (pre-Phase-17) implementation; nothing
  // was rewritten, reordered, or recalculated differently. Previously
  // this entire block re-ran on every render regardless of whether
  // `trades`/`accounts`/`accFilter` had changed; it now only re-runs
  // when one of those three actually changes, matching the "Memoized
  // Calculations" item from the approved migration plan's PERFORMANCE
  // section. See MIGRATION_NOTES.md for the full Phase 17 rationale.
  const derived = useMemo(() => {
const n = trades.length;

  // Phase 20 — Architecture Cleanup (finding H-3): reuses
  // summarizeTrades() (calculations/rolling.ts, Phase 11) instead of
  // re-deriving green/red/be/totalR/avgR/netPL inline a second time.
  // Verified field-for-field identical formulas before this change:
  // summarizeTrades().wr uses the SAME closed-trades-denominator
  // convention Dashboard's own `denom = green+red` used, and
  // .avgR uses the SAME "null-as-0, divide by n" convention already
  // documented in AN-005 (NOT core.avgActualR, which uses a different,
  // incompatible convention — see that note for why this distinction
  // matters). Only the wr STRING formatting (originally a display
  // concern, not a calculation) stays local to this page.
  const summary = summarizeTrades(trades);
  const { green, red, be, totalR } = summary;
  const avgR = summary.avgR;
  const totalNPL = summary.netPL;
  const wr = summary.wr !== null ? `${(summary.wr * 100).toFixed(1)}%` : '—';

  // ── Average personal rating (ignores empty ratings) ────
  const ratings = trades
    .filter((t) => t.personalRating && t.personalRating !== '')
    .map((t) => +(t.personalRating as string));
  const avgRating = ratings.length > 0
    ? ratings.reduce((s, v) => s + v, 0) / ratings.length
    : 0;

  // ── Equity curve ────────────────────────────────────────
  // Matches original exactly:
  //   totalCap = accFilter==="all" ? sum(accounts.capital) : selectedAccount.capital
  const totalCap = accFilter === 'all'
    ? accounts.reduce((s, a) => s + a.capital, 0)
    : (accounts.find((a) => a.id === accFilter)?.capital ?? 0);

  let run = totalCap;
  const eqCurve: { x: number; eq: number }[] = [{ x: 0, eq: totalCap }];
  trades.forEach((t, i) => {
    run += t._netPL || 0;
    eqCurve.push({ x: i + 1, eq: Math.round(run * 100) / 100 });
  });

  const curCap = totalCap + totalNPL;
  const ret = totalCap > 0
    ? `${(((curCap - totalCap) / totalCap) * 100).toFixed(1)}%`
    : '—';

  // Matches original: color equity above/below starting capital
  const eqColored = eqCurve.map((p) => ({
    x:     p.x,
    eq:    p.eq,
    above: p.eq >= totalCap ? p.eq : totalCap,
    below: p.eq <  totalCap ? p.eq : totalCap,
    ref:   totalCap,
  }));

  // ── Monthly R ────────────────────────────────────────────
  const byMo: Record<string, { r: number }> = {};
  trades.forEach((t) => {
    if (!t.date) return;
    const m = t.date.slice(0, 7);
    if (!byMo[m]) byMo[m] = { r: 0 };
    byMo[m].r += t._r || 0;
  });
  const mData = Object.entries(byMo)
    .sort((a, b) => (a[0] > b[0] ? 1 : -1))
    .map(([key, val]) => ({
      m: new Date(`${key}-01`).toLocaleDateString('en', { month: 'short', year: '2-digit' }),
      R: Math.round(val.r * 100) / 100,
    }));

  // ── Symbol R (top 12) ────────────────────────────────────
  const bySym: Record<string, { r: number; mkt: string }> = {};
  trades.forEach((t) => {
    if (!t.symbol) return;
    if (!bySym[t.symbol]) bySym[t.symbol] = { r: 0, mkt: t.market as string };
    bySym[t.symbol].r += t._r || 0;
  });
  const symData = Object.entries(bySym)
    .map(([s, val]) => ({ s, R: Math.round(val.r * 100) / 100, mkt: val.mkt }))
    .sort((a, b) => b.R - a.R)
    .slice(0, 12);

  // ── Long vs Short ────────────────────────────────────────
  const longs  = trades.filter((t) => t.direction === 'Long').length;
  const shorts = trades.filter((t) => t.direction === 'Short').length;
  const longR  = trades.filter((t) => t.direction === 'Long').reduce((s, t) => s + (t._r || 0), 0);
  const shortR = trades.filter((t) => t.direction === 'Short').reduce((s, t) => s + (t._r || 0), 0);
  const bsData = [
    { name: 'Long (Buy)',  count: longs,  R: Math.round(longR  * 100) / 100, pct: n > 0 ? (longs  / n * 100).toFixed(1) : '0' },
    { name: 'Short (Sell)', count: shorts, R: Math.round(shortR * 100) / 100, pct: n > 0 ? (shorts / n * 100).toFixed(1) : '0' },
  ];

  // ── Open Time — R by Hour ────────────────────────────────
  const byHour: Record<number, { r: number; n: number }> = {};
  trades.forEach((t) => {
    if (!t.entryTime) return;
    const hr = parseInt(t.entryTime.split(':')[0], 10);
    if (isNaN(hr)) return;
    if (!byHour[hr]) byHour[hr] = { r: 0, n: 0 };
    byHour[hr].r += t._r || 0;
    byHour[hr].n += 1;
  });
  const hourData = Object.entries(byHour)
    .sort((a, b) => +a[0] - +b[0])
    .map(([key, val]) => {
      const hr = +key;
      const label = `${hr < 10 ? '0' + hr : hr}:00`;
      return { hr: label, R: Math.round(val.r * 100) / 100, n: val.n };
    });

  // ── Outcome pie (with % embedded in name) ────────────────
  const total3 = green + red + be;
  const pieD = [
    { name: `Green ${green} (${total3 > 0 ? ((green / total3) * 100).toFixed(0) : 0}%)`, value: green, color: C.green },
    { name: `Red ${red} (${total3 > 0 ? ((red / total3) * 100).toFixed(0) : 0}%)`,     value: red,   color: C.red },
    { name: `BE ${be} (${total3 > 0 ? ((be / total3) * 100).toFixed(0) : 0}%)`,        value: be,    color: C.gold },
  ].filter((d) => d.value > 0);

  // ── FX/Futures split for Total Trades KPI sub-label ──────
  const fxCount  = trades.filter((t) => !t._isFutures).length;
  const futCount = trades.filter((t) => t._isFutures).length;

    return {
      n, green, red, be, wr, totalNPL, totalR, avgR, avgRating,
      totalCap, curCap, ret, eqColored, mData, symData, bsData, longs, shorts,
      hourData, pieD, fxCount, futCount,
    };
  }, [trades, accounts, accFilter]);

  const {
    n, green, red, be, wr, totalNPL, totalR, avgR, avgRating,
    totalCap, curCap, ret, eqColored, mData, symData, bsData, longs, shorts,
    hourData, pieD, fxCount, futCount,
  } = derived;

  return (
    <div>
      {/* ── KPI row ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <KPI label="Total Trades" value={n} color={C.blue} sub={`FX: ${fxCount} | Fut: ${futCount}`} />
        <KPI label="Avg R" value={avgR !== null ? fr.r(avgR) : '—'} color={(avgR ?? 0) >= 0 ? C.green : C.red} />
        <KPI label="Win Rate (W/L only)" value={wr} color={C.green} sub={`${green}W / ${red}L / ${be}BE`} />
        <KPI label="Net P/L" value={fr.usd(totalNPL)} color={totalNPL >= 0 ? C.green : C.red} sub={`Return: ${ret}`} />
        <KPI label="Total R" value={`${totalR.toFixed(2)}R`} color={totalR >= 0 ? C.green : C.red} />
        <KPI
          label="Capital"
          value={`$${Math.round(curCap).toLocaleString()}`}
          color={C.gold}
          sub={`Start: $${totalCap.toLocaleString()}`}
        />
      </div>

      {/* ── Row 1: Equity + Win/Loss pie ─────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 14, marginBottom: 14 }}>
        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📈 Equity Curve</div>
          {n === 0 ? <EmptyState /> : (
            <EquityCurveChart data={eqColored} totalCap={totalCap} curCap={curCap} />
          )}
        </Card>

        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 8 }}>🥧 Win / Loss / BE</div>
          {pieD.length === 0 ? <EmptyState /> : (
            <OutcomePieChart data={pieD} totalClosedTrades={green + red + be} />
          )}
        </Card>
      </div>

      {/* ── Row 2: Long vs Short + Open Time Hour ────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📊 Long vs Short</div>
          {longs + shorts === 0 ? <EmptyState /> : <LongShortChart data={bsData} />}
        </Card>

        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>⏰ Open Time — R by Hour</div>
          {hourData.length === 0 ? <EmptyState /> : <HourlyRChart data={hourData} />}
        </Card>
      </div>

      {/* ── Row 3: Monthly R + Symbol R ───────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📅 Monthly R</div>
          {mData.length === 0 ? <EmptyState /> : <MonthlyRChart data={mData} />}
        </Card>

        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>💹 R by Symbol</div>
          {symData.length === 0 ? <EmptyState /> : <SymbolRChart data={symData} />}
        </Card>
      </div>

      {/* ── Row 4: Rating gauge + Setup Type panel ────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14 }}>
        <RatingGauge avg={avgRating} />

        <Card>
          <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📊 Avg R per Setup Type</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(['A+', 'A', 'B', 'C'] as const).map((st) => {
              const ts = trades.filter((t) => t.setupType === st);
              const r  = ts.length > 0 ? ts.reduce((s, t) => s + (t._r || 0), 0) / ts.length : null;
              const col = r === null ? C.dim : r > 0 ? C.green : C.red;
              return (
                <div
                  key={st}
                  style={{
                    background: C.row, borderRadius: 8, border: `1px solid ${C.border}`,
                    padding: '10px 16px', textAlign: 'center', flex: 1,
                  }}
                >
                  <div style={{ color: C.dim, fontSize: 10 }}>{`Setup ${st}`}</div>
                  <div style={{ color: col, fontSize: 16, fontWeight: 800, marginTop: 2 }}>
                    {r !== null ? fr.r(r) : '—'}
                  </div>
                  <div style={{ color: C.dim, fontSize: 9 }}>{`${ts.length} trades`}</div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}
