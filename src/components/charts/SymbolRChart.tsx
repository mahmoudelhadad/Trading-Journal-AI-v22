/**
 * components/charts/SymbolRChart.tsx
 *
 * "💹 R by Symbol" horizontal bar chart.
 *
 * Migrated VERBATIM from the corresponding block inside the original
 * DashboardTab. Bar color depends on market type AND sign:
 *   futures + positive → orange
 *   futures + negative → '#8B4513' (brown)
 *   forex   + positive → green
 *   forex   + negative → red
 *
 * Data prep (symData, sliced to top 12) happens in the caller
 * (pages/Dashboard.tsx) exactly as it did inline in the original
 * DashboardTab.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';
import { TOOLTIP_STYLE } from './chartTheme.js';

// ─── Types ───────────────────────────────────────────────────

export interface SymbolRDatum {
  s:   string; // symbol
  R:   number;
  mkt: string; // 'forex' | 'futures'
}

export interface SymbolRChartProps {
  data:    SymbolRDatum[];
  height?: number;
}

// ─── Bar color — matches original exactly ──────────────────────
// symData.map(d => Cell fill: d.mkt==="futures" ? (d.R>=0?C.orange:"#8B4513") : (d.R>=0?C.green:C.red))
function getBarColor(d: SymbolRDatum): string {
  if (d.mkt === 'futures') {
    return d.R >= 0 ? C.orange : '#8B4513';
  }
  return d.R >= 0 ? C.green : C.red;
}

// ─── Component ───────────────────────────────────────────────

export function SymbolRChart({ data, height = 180 }: SymbolRChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" horizontal={false} />
        <XAxis type="number" stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <YAxis
          dataKey="s"
          type="category"
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          width={55}
          axisLine={{ stroke: C.border }}
        />
        <Tooltip {...TOOLTIP_STYLE} />
        <Bar dataKey="R" radius={[0, 4, 4, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={getBarColor(d)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
