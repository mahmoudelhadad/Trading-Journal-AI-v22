/**
 * components/charts/MonthlyRChart.tsx
 *
 * "📅 Monthly R" bar chart.
 *
 * Migrated VERBATIM from the corresponding block inside the original
 * DashboardTab.
 *
 * Data prep (mData) happens in the caller (pages/Dashboard.tsx)
 * exactly as it did inline in the original DashboardTab.
 *
 * NOTE: This component is intentionally similar to the Strategy
 * page's day-of-week chart but is NOT shared with it in Phase 6 —
 * the original app also duplicated this chart pattern rather than
 * sharing a component. Preserved as-is per "no redesign" instruction.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';

// ─── Types ───────────────────────────────────────────────────

export interface MonthlyRDatum {
  m: string; // e.g. "Jan '24"
  R: number;
}

export interface MonthlyRChartProps {
  data:    MonthlyRDatum[];
  height?: number;
}

// ─── Component ───────────────────────────────────────────────

export function MonthlyRChart({ data, height = 180 }: MonthlyRChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ bottom: 18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis
          dataKey="m"
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          angle={-30}
          textAnchor="end"
          axisLine={{ stroke: C.border }}
        />
        <YAxis stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey="R" radius={[4, 4, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.R >= 0 ? C.green : C.red} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
