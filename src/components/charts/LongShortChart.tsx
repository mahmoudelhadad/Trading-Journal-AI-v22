/**
 * components/charts/LongShortChart.tsx
 *
 * Long vs Short comparison bar chart.
 *
 * Migrated VERBATIM from the "📊 Long vs Short" block inside the
 * original DashboardTab, including the custom BSTooltip function.
 *
 * Data prep (bsData) happens in the caller (pages/Dashboard.tsx)
 * exactly as it did inline in the original DashboardTab.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Cell } from 'recharts';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface LongShortDatum {
  name:  string; // "Long (Buy)" | "Short (Sell)"
  count: number;
  R:     number;
  pct:   number | string;
}

export interface LongShortChartProps {
  data:    LongShortDatum[];
  height?: number;
}

// ─── Custom tooltip — matches original BSTooltip(tp) exactly ──

function BSTooltip(props: any) {
  const { active, payload } = props;
  if (!active || !payload || !payload.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  return (
    <div style={{ background: '#1A2535', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 10, color: C.text }}>
      <div style={{ fontWeight: 700, color: C.white }}>{d.name}</div>
      <div>{`Count: ${d.count} (${d.pct}% of trades)`}</div>
      <div style={{ color: d.R >= 0 ? C.green : C.red }}>{`Total R: ${d.R.toFixed(2)}`}</div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

export function LongShortChart({ data, height = 180 }: LongShortChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} barCategoryGap="40%">
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis dataKey="name" stroke={C.dim} tick={{ fontSize: 10 }} axisLine={{ stroke: C.border }} />
        <YAxis stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <Tooltip content={<BSTooltip />} />
        <Bar dataKey="count" radius={[6, 6, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.name.indexOf('Long') >= 0 ? C.green : C.red} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
