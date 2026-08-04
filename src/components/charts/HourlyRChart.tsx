/**
 * components/charts/HourlyRChart.tsx
 *
 * "Open Time — R by Hour" bar chart.
 *
 * Migrated VERBATIM from the corresponding block inside the original
 * DashboardTab.
 *
 * Data prep (hourData) happens in the caller (pages/Dashboard.tsx)
 * exactly as it did inline in the original DashboardTab.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';

// ─── Types ───────────────────────────────────────────────────

export interface HourlyRDatum {
  hr: string; // e.g. "09:00"
  R:  number;
  n:  number;
}

export interface HourlyRChartProps {
  data:    HourlyRDatum[];
  height?: number;
}

// ─── Component ───────────────────────────────────────────────

export function HourlyRChart({ data, height = 180 }: HourlyRChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barCategoryGap="30%">
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis dataKey="hr" stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <YAxis stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(v: number, _n: string, p: any) =>
            [`${v.toFixed(2)} R (${p.payload.n} trades)`, 'Hour']
          }
        />
        <Bar dataKey="R" radius={[5, 5, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.R >= 0 ? C.green : C.red} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
