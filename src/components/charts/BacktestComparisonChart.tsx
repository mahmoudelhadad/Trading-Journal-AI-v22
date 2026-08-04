/**
 * components/charts/BacktestComparisonChart.tsx
 *
 * Backtesting UI — two backtest results overlaid for comparison.
 *
 * NEW component. It lives here rather than in components/backtest/
 * because this codebase keeps every chart in components/charts/, and
 * charts are presentational only: they render already-computed data
 * and never derive it (see DrawdownChart.tsx's file header). The
 * caller shapes BacktestComparisonPoint[]; this component only draws.
 *
 * SINGLE Y-AXIS: both series are percentage return relative to their
 * OWN starting capital, so two runs with different starting capitals
 * are directly comparable on one scale. This is why the caller
 * normalizes rather than passing raw dollar equity — a dual-axis
 * dollar chart would make the two lines visually comparable while
 * being numerically unrelated.
 *
 * NULL POINTS: two results rarely have the same trade count. The
 * shorter series carries nulls past its end and simply stops — nulls
 * are NOT bridged (connectNulls is left at its default of false), so
 * the chart never implies data that does not exist.
 *
 * Series colors are blue/gold rather than green/red, which carry
 * win/loss meaning elsewhere in this app and would misread as
 * outcome coloring here.
 */

import React from 'react';
import {
  ResponsiveContainer, LineChart, Line,
  CartesianGrid, XAxis, YAxis, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface BacktestComparisonPoint {
  /** Trade sequence index, 0 = before any trade */
  x: number;
  /** Result A's percentage return vs its own starting capital */
  a: number | null;
  /** Result B's percentage return vs its own starting capital */
  b: number | null;
}

export interface BacktestComparisonChartProps {
  data:    BacktestComparisonPoint[];
  labelA:  string;
  labelB:  string;
  height?: number;
}

// ─── Custom tooltip ──────────────────────────────────────────
// Same `props: any` custom-content pattern EquityCurveChart and
// DrawdownChart already use — chartTheme.ts's TOOLTIP_STYLE is for
// charts that do NOT supply fully custom tooltip content.

function CmpTooltip(props: any) {
  const { active, payload, label, labelA, labelB } = props;
  if (!active || !payload || !payload.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${v.toFixed(2)}%`);

  return (
    <div style={{ background: '#1A2535', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 10, color: C.text }}>
      <div>{`Trade #${label}`}</div>
      <div style={{ color: C.blue }}>{`${labelA}: ${pct(d.a)}`}</div>
      <div style={{ color: C.gold }}>{`${labelB}: ${pct(d.b)}`}</div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

export function BacktestComparisonChart({ data, labelA, labelB, height = 185 }: BacktestComparisonChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis
          dataKey="x"
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          axisLine={{ stroke: C.border }}
        />
        <YAxis
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          axisLine={{ stroke: C.border }}
          width={58}
          tickFormatter={(v: number) => `${v.toFixed(0)}%`}
        />
        <Tooltip content={<CmpTooltip labelA={labelA} labelB={labelB} />} />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 9, color: C.text }} />
        <ReferenceLine y={0} stroke="#6B82A0" strokeDasharray="4 4" strokeWidth={1} />
        <Line
          type="monotone"
          dataKey="a"
          name={labelA}
          stroke={C.blue}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: C.blue }}
        />
        <Line
          type="monotone"
          dataKey="b"
          name={labelB}
          stroke={C.gold}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: C.gold }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
