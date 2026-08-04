/**
 * components/charts/EntrySetupWinRateChart.tsx
 *
 * Phase 11 — Strategy page: Total R + Win% by Entry Setup bar chart.
 *
 * Migrated verbatim from the "R & Win Rate by Entry Setup" chart block
 * inside the original StrategyTab. Total R bar colored by sign; Win%
 * bar rendered with a single fixed color (C.blue + alpha), NOT per-cell
 * colored by any threshold — this matches the original exactly (the
 * original app never colored the win-rate bar by a "good/bad" threshold,
 * it is always the same blue regardless of value).
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';

// ─── Types ───────────────────────────────────────────────────

export interface EntrySetupWinRateDatum {
  name:   string;
  totalR: number;
  wr:     number; // percentage, 0-100
}

export interface EntrySetupWinRateChartProps {
  data:    EntrySetupWinRateDatum[];
  height?: number;
}

// ─── Component ───────────────────────────────────────────────

export function EntrySetupWinRateChart({ data, height = 160 }: EntrySetupWinRateChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis dataKey="name" stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <YAxis stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: number, name: string) =>
            [name === 'wr' ? `${v}%` : `${v.toFixed(2)}R`, name]
          }
        />
        <Bar dataKey="totalR" name="Total R" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.totalR >= 0 ? C.green : C.red} />
          ))}
        </Bar>
        <Bar dataKey="wr" name="Win%" fill={`${C.blue}88`} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
