/**
 * components/backtest/BacktestComparison.tsx
 *
 * Backtesting UI — two stored backtest results, side by side.
 *
 * PURELY PRESENTATIONAL. Every KPI is a direct property read off the
 * stored BacktestResult records, displayed AS STORED and never
 * recomputed. `data` is the BacktestComparisonPoint[] already shaped
 * by pages/Backtest.tsx and is forwarded to the chart untouched — this
 * component never maps, filters, reduces, sorts, slices or re-derives
 * it, because the page owns all comparison shaping.
 *
 * Column colors match the chart's series colors (A = blue, B = gold)
 * so a reader can tell which line belongs to which column without a
 * second lookup.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { KPI } from '@components/ui/KPI.js';
import { Button } from '@components/ui/Button.js';
import { BacktestComparisonChart } from '@components/charts/BacktestComparisonChart.js';
import type { BacktestComparisonPoint } from '@components/charts/BacktestComparisonChart.js';
import { fr } from '@calculations/formatters.js';
import type { BacktestResult } from '@apptypes/backtest.js';

// ─── Types ───────────────────────────────────────────────────

export interface BacktestComparisonProps {
  resultA: BacktestResult;
  resultB: BacktestResult;
  legacyA?: boolean;
  legacyB?: boolean;
  /** Already shaped by the page — forwarded to the chart untouched */
  data:    BacktestComparisonPoint[];
  onClose: () => void;
}

const colStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };

// ─── Component ───────────────────────────────────────────────

export function BacktestComparison({ resultA, resultB, legacyA, legacyB, data, onClose }: BacktestComparisonProps) {
  return (
    <Card>
      {/* ── Header ───────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, color: C.text, fontSize: 11, fontWeight: 700 }}>⚖️ Comparison</div>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>

      {/* ── Side-by-side KPIs ────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Result A */}
        <div style={colStyle}>
          <div style={{ color: C.blue, fontSize: 12, fontWeight: 700 }}>{resultA.name}</div>
          {legacyA && <div style={{ color: C.dim, fontSize: 10 }}>Legacy series — reconstructed from current journal trades.</div>}
          <KPI label="Net P&L"      value={fr.usd(resultA.summary.netPL)} color={C.blue} />
          <KPI label="Win Rate"     value={fr.pct(resultA.summary.wr)} color={C.blue} sub={`${resultA.summary.green}W / ${resultA.summary.red}L`} />
          <KPI label="Profit Factor" value={resultA.core.profitFactor !== null ? resultA.core.profitFactor.toFixed(2) : '—'} color={C.blue} />
          <KPI label="Max Drawdown" value={`-$${resultA.drawdown.maxDrawdownDollar.toFixed(0)}`} color={C.blue} sub={`-${resultA.drawdown.maxDrawdownPercent.toFixed(1)}%`} />
          <KPI label="Trades"       value={resultA.tradeCount} color={C.blue} sub={`Start: $${resultA.startingCapital.toLocaleString()}`} />
        </div>

        {/* Result B */}
        <div style={colStyle}>
          <div style={{ color: C.gold, fontSize: 12, fontWeight: 700 }}>{resultB.name}</div>
          {legacyB && <div style={{ color: C.dim, fontSize: 10 }}>Legacy series — reconstructed from current journal trades.</div>}
          <KPI label="Net P&L"      value={fr.usd(resultB.summary.netPL)} color={C.gold} />
          <KPI label="Win Rate"     value={fr.pct(resultB.summary.wr)} color={C.gold} sub={`${resultB.summary.green}W / ${resultB.summary.red}L`} />
          <KPI label="Profit Factor" value={resultB.core.profitFactor !== null ? resultB.core.profitFactor.toFixed(2) : '—'} color={C.gold} />
          <KPI label="Max Drawdown" value={`-$${resultB.drawdown.maxDrawdownDollar.toFixed(0)}`} color={C.gold} sub={`-${resultB.drawdown.maxDrawdownPercent.toFixed(1)}%`} />
          <KPI label="Trades"       value={resultB.tradeCount} color={C.gold} sub={`Start: $${resultB.startingCapital.toLocaleString()}`} />
        </div>
      </div>

      {/* ── Overlaid return curves ───────────────────────────── */}
      {/* `data` is forwarded exactly as received — no reshaping here. */}
      <div style={{ marginTop: 14 }}>
        <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>📈 Return Comparison</div>
        <BacktestComparisonChart data={data} labelA={resultA.name} labelB={resultB.name} />
      </div>
    </Card>
  );
}
