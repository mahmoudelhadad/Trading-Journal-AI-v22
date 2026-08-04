/**
 * components/charts/DayOfWeekRChart.tsx
 *
 * Phase 11 — Strategy page: Total R + Avg R by Day of Week bar chart.
 *
 * Migrated verbatim from the "Avg R by Day of Week" chart block inside
 * the original StrategyTab. Two bars per day (Total R colored by sign,
 * Avg R semi-transparent colored by sign), same tooltip formatter, same
 * styling tokens as every other Phase 6/9 chart component.
 *
 * Not merged with MonthlyRChart.tsx (Phase 6) despite visual similarity
 * — that component renders a SINGLE bar series; this one renders TWO
 * (Total R + Avg R together), a genuinely different data shape. Forcing
 * them into one parameterised component would require a large prop
 * surface for little gain, so they remain separate per-purpose
 * components, consistent with the Phase 6 precedent (MonthlyRChart,
 * HourlyRChart, SymbolRChart are also kept separate despite similarity).
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';

// ─── Types ───────────────────────────────────────────────────

export interface DayOfWeekRDatum {
  name:   string; // 'Mon', 'Tue', ...
  totalR: number;
  avgR:   number;
  n:      number;
}

export interface DayOfWeekRChartProps {
  data:    DayOfWeekRDatum[];
  height?: number;
}

// ─── Component ───────────────────────────────────────────────

export function DayOfWeekRChart({ data, height = 160 }: DayOfWeekRChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis dataKey="name" stroke={C.dim} tick={{ fontSize: 10 }} axisLine={{ stroke: C.border }} />
        <YAxis stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: number, name: string) => [`${v >= 0 ? '+' : ''}${v.toFixed(2)}R`, name]}
        />
        <Bar dataKey="totalR" name="Total R" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.totalR >= 0 ? C.green : C.red} />
          ))}
        </Bar>
        <Bar dataKey="avgR" name="Avg R" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.avgR >= 0 ? '#22C55E88' : '#EF444488'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
