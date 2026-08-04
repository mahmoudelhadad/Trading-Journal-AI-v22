/**
 * components/charts/OutcomePieChart.tsx
 *
 * Win / Loss / Breakeven pie chart with percentage labels.
 *
 * Migrated VERBATIM from the "🥧 Win / Loss / BE" block inside the
 * original DashboardTab.
 *
 * Data prep (pieD with embedded percentage in the `name` string)
 * happens in the caller (pages/Dashboard.tsx) exactly as it did
 * inline in the original DashboardTab.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';

// ─── Types ───────────────────────────────────────────────────

export interface OutcomePieDatum {
  /** Pre-formatted label including count and %, e.g. "Green 12 (60%)" */
  name:  string;
  value: number;
  color: string;
}

export interface OutcomePieChartProps {
  data:              OutcomePieDatum[];
  /** Total of green+red+be — used for the in-slice label percentage */
  totalClosedTrades: number;
  height?:           number;
}

// ─── Component ───────────────────────────────────────────────

export function OutcomePieChart({ data, totalClosedTrades, height = 185 }: OutcomePieChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="45%"
          innerRadius={38}
          outerRadius={62}
          paddingAngle={3}
          dataKey="value"
          label={(entry: any) =>
            `${((entry.value / totalClosedTrades) * 100).toFixed(0)}%`
          }
          labelLine={false}
          style={{ fontSize: 9, fontWeight: 700 }}
        >
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
        </Pie>
        <Tooltip
          {...TOOLTIP_STYLE}
          formatter={(val: number, name: string) => [`${val} trades`, name]}
        />
        <Legend iconType="circle" wrapperStyle={{ fontSize: 9, color: C.text }} />
      </PieChart>
    </ResponsiveContainer>
  );
}
