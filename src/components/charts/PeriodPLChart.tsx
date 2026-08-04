/**
 * components/charts/PeriodPLChart.tsx
 *
 * Phase 9 — Equity page: Daily / Weekly / Monthly P&L bar chart.
 *
 * NEW component — genuinely generalized (not the original app's style
 * of near-duplicate chart code per period, which is why Phase 6 left
 * MonthlyRChart.tsx as its own file rather than sharing it). Since
 * Daily/Weekly/Monthly P&L are three variants of the exact same chart
 * shape with only the x-axis label format differing, one parameterized
 * component avoids the unnecessary duplication called out by the
 * Phase 9 rules — this is a deliberate exception to the Phase 6
 * "match original's duplication" precedent, justified because this
 * chart has no original-app equivalent to be faithful to.
 *
 * Consumes PeriodStats[] directly from calculations/rolling.ts's
 * aggregateByPeriod() — no data transformation happens in this
 * component beyond formatting the x-axis label.
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';
import type { PeriodStats, PeriodGranularity } from '@calculations/rolling.js';

// ─── Types ───────────────────────────────────────────────────

export interface PeriodPLChartProps {
  data:        PeriodStats[];
  granularity: PeriodGranularity;
  height?:     number;
}

// ─── Label formatting per granularity ──────────────────────────

function formatLabel(key: string, granularity: PeriodGranularity): string {
  if (granularity === 'month') {
    return new Date(`${key}-01`).toLocaleDateString('en', { month: 'short', year: '2-digit' });
  }
  if (granularity === 'week') {
    return new Date(`${key}T12:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }
  // day
  return new Date(`${key}T12:00`).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// ─── Component ───────────────────────────────────────────────

export function PeriodPLChart({ data, granularity, height = 180 }: PeriodPLChartProps) {
  const chartData = data.map((d) => ({
    label:  formatLabel(d.key, granularity),
    netPL:  Math.round(d.netPL * 100) / 100,
    trades: d.trades,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={chartData} margin={{ bottom: 18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis
          dataKey="label"
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          angle={-30}
          textAnchor="end"
          axisLine={{ stroke: C.border }}
        />
        <YAxis
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          axisLine={{ stroke: C.border }}
          tickFormatter={(v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
        />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: number, name: string, p: any) =>
            [`$${v.toFixed(2)} (${p.payload.trades} trades)`, 'Net P/L']
          }
        />
        <Bar dataKey="netPL" radius={[4, 4, 0, 0]}>
          {chartData.map((d, i) => (
            <Cell key={i} fill={d.netPL >= 0 ? C.green : C.red} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
