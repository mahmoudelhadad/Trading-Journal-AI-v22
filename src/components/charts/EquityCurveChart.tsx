/**
 * components/charts/EquityCurveChart.tsx
 *
 * Equity curve chart — green area above starting capital, red area below.
 *
 * Migrated VERBATIM from the "📈 Equity Curve" block inside the
 * original DashboardTab, including the custom EqTooltip function.
 *
 * Data prep (eqCurve → eqColored) happens in the caller (pages/Dashboard.tsx)
 * exactly as it did inline in the original DashboardTab — this component
 * only renders the chart given the already-prepared data.
 *
 * Phase 6 — Dashboard migration. Zero calculation changes.
 */

import React from 'react';
import {
  ResponsiveContainer, ComposedChart, Area, Line,
  CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine,
} from 'recharts';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface EquityCurvePoint {
  x:     number;
  eq:    number;
  above: number;
  below: number;
  ref:   number;
}

export interface EquityCurveChartProps {
  data:     EquityCurvePoint[];
  totalCap: number;
  curCap:   number;
  height?:  number;
}

// ─── Custom tooltip — matches original EqTooltip(tp) exactly ──

function EqTooltip(props: any) {
  const { active, payload, label, totalCap } = props;
  if (!active || !payload || !payload.length) return null;
  const val = payload[0]?.payload?.eq;
  if (val === undefined) return null;
  const diff = val - totalCap;
  const pct  = totalCap > 0 ? (diff / totalCap) * 100 : 0;

  return (
    <div style={{ background: '#1A2535', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 10, color: C.text }}>
      <div>{`Trade #${label}`}</div>
      <div style={{ color: C.white, fontWeight: 700 }}>
        {`$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
      </div>
      <div style={{ color: diff >= 0 ? C.green : C.red }}>
        {`${diff >= 0 ? '+$' : '-$'}${Math.abs(diff).toFixed(0)} (${pct.toFixed(1)}%)`}
      </div>
      <div style={{ color: C.dim, fontSize: 9 }}>
        {`Start: $${totalCap.toLocaleString()}`}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

export function EquityCurveChart({ data, totalCap, curCap, height = 185 }: EquityCurveChartProps) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data}>
        <defs>
          <linearGradient id="gGain" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#22C55E" stopOpacity={0.35} />
            <stop offset="95%" stopColor="#22C55E" stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="gLoss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.02} />
            <stop offset="95%" stopColor="#EF4444" stopOpacity={0.35} />
          </linearGradient>
        </defs>

        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis dataKey="x" stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <YAxis
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          axisLine={{ stroke: C.border }}
          width={68}
          tickFormatter={(v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
        />
        <Tooltip content={<EqTooltip totalCap={totalCap} />} />
        <ReferenceLine y={totalCap} stroke="#6B82A0" strokeDasharray="4 4" strokeWidth={1} />
        <Area type="monotone" dataKey="above" stroke="none" fill="url(#gGain)" baseValue={totalCap} />
        <Area type="monotone" dataKey="below" stroke="none" fill="url(#gLoss)" baseValue={totalCap} />
        <Line
          type="monotone"
          dataKey="eq"
          stroke={curCap >= totalCap ? C.green : C.red}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4, fill: curCap >= totalCap ? C.green : C.red }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
