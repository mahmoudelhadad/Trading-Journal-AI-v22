/**
 * components/charts/DrawdownChart.tsx
 *
 * Phase 9 — Equity page: Drawdown-from-peak area chart.
 *
 * NEW component — no original-app equivalent (the original app never
 * visualized drawdown). Styled to match the existing chart components
 * from Phase 6 (same color tokens, same tooltip theme, same axis
 * styling) for visual consistency — no new design language introduced.
 *
 * Consumes the `rollingDrawdown` series produced by
 * calculations/drawdown.ts's computeDrawdown() — this component does
 * NOT compute drawdown itself, it only renders already-computed data,
 * consistent with every other chart component in this codebase (charts
 * are presentational; calculations live in calculations/).
 */

import React from 'react';
import { ResponsiveContainer, AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip } from 'recharts';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface DrawdownChartDatum {
  index: number;
  /** Drawdown in dollars, always >= 0 (0 = at peak, no drawdown) */
  drawdownDollar: number;
  drawdownPercent: number;
}

export interface DrawdownChartProps {
  data:    DrawdownChartDatum[];
  height?: number;
}

// ─── Custom tooltip ──────────────────────────────────────────

function DDTooltip(props: any) {
  const { active, payload, label } = props;
  if (!active || !payload || !payload.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  return (
    <div style={{ background: '#1A2535', border: `1px solid ${C.border}`, borderRadius: 6, padding: '8px 12px', fontSize: 10, color: C.text }}>
      <div>{`Trade #${label}`}</div>
      <div style={{ color: C.red, fontWeight: 700 }}>
        {`-$${d.drawdownDollar.toFixed(2)} (-${d.drawdownPercent.toFixed(2)}%)`}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────

/**
 * Renders drawdown-from-peak as a filled area chart, plotted as a
 * NEGATIVE value (below the zero line) so it visually reads as "how
 * far underwater" the account is at each point — matches the common
 * convention used by most trading-platform drawdown charts.
 */
export function DrawdownChart({ data, height = 160 }: DrawdownChartProps) {
  // Plot as negative so the fill hangs below a zero baseline
  const plotData = data.map((d) => ({ ...d, negDrawdown: -d.drawdownDollar }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={plotData}>
        <defs>
          <linearGradient id="gDrawdown" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={C.red} stopOpacity={0.05} />
            <stop offset="95%" stopColor={C.red} stopOpacity={0.4} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1E2D42" vertical={false} />
        <XAxis dataKey="index" stroke={C.dim} tick={{ fontSize: 9 }} axisLine={{ stroke: C.border }} />
        <YAxis
          stroke={C.dim}
          tick={{ fontSize: 9 }}
          axisLine={{ stroke: C.border }}
          tickFormatter={(v: number) => `$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
        />
        <Tooltip content={<DDTooltip />} />
        <Area
          type="monotone"
          dataKey="negDrawdown"
          stroke={C.red}
          strokeWidth={1.5}
          fill="url(#gDrawdown)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
