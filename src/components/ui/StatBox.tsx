/**
 * components/ui/StatBox.tsx
 *
 * Compact stat display used in Strategy tab time-stats row and Insights.
 * Matches original StatBox(p) function:
 *   h("div", { style: { background:"#162035", border:"1px solid "+C.border,
 *     borderRadius:10, padding:"10px 16px", textAlign:"center", flex:1, minWidth:110 } },
 *     h("div", { style: { color:C.dim, fontSize:9, textTransform:"uppercase",
 *       letterSpacing:"0.05em", marginBottom:4 } }, p.label),
 *     h("div", { style: { color:p.color||C.green, fontSize:14, fontWeight:800 } }, p.value)
 *   )
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface StatBoxProps {
  label:     string;
  value:     React.ReactNode;
  color?:    string;
  minWidth?: number;
  style?:    React.CSSProperties;
}

export function StatBox({ label, value, color, minWidth = 110, style }: StatBoxProps) {
  return (
    <div
      style={{
        background:    '#162035',
        border:        `1px solid ${C.border}`,
        borderRadius:  10,
        padding:       '10px 16px',
        textAlign:     'center',
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
          marginBottom:  4,
        }}
      >
        {label}
      </div>

      <div
        style={{
          color:      color ?? C.green,
          fontSize:   14,
          fontWeight: 800,
        }}
      >
        {value}
      </div>
    </div>
  );
}
