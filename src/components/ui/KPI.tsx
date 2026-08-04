/**
 * components/ui/KPI.tsx
 *
 * Key Performance Indicator card — used in Dashboard header row.
 * Matches original KPI(p) function:
 *   h("div", { style: { background:C.card, border:"1px solid "+p.color+"55",
 *     borderRadius:10, padding:"10px 14px", flex:1, minWidth:100 } },
 *     h("div", { style: { color:C.dim, fontSize:9, textTransform:"uppercase",
 *       letterSpacing:"0.05em" } }, p.label),
 *     h("div", { style: { color:p.color, fontSize:15, fontWeight:800, marginTop:3 } }, p.value),
 *     p.sub && h("div", { style: { color:C.dim, fontSize:9, marginTop:2 } }, p.sub)
 *   )
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface KPIProps {
  label:     string;
  value:     React.ReactNode;
  color:     string;
  sub?:      string;
  minWidth?: number;
  style?:    React.CSSProperties;
}

export function KPI({ label, value, color, sub, minWidth = 100, style }: KPIProps) {
  return (
    <div
      style={{
        background:    C.card,
        border:        `1px solid ${color}55`,
        borderRadius:  10,
        padding:       '10px 14px',
        flex:          1,
        minWidth,
        ...style,
      }}
    >
      <div
        style={{
          color:         C.dim,
          fontSize:      9,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>

      <div
        style={{
          color,
          fontSize:   15,
          fontWeight: 800,
          marginTop:  3,
        }}
      >
        {value}
      </div>

      {sub && (
        <div style={{ color: C.dim, fontSize: 9, marginTop: 2 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
