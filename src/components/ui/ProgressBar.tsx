/**
 * components/ui/ProgressBar.tsx
 *
 * Progress / limit bar used in Prop Firm Tracker.
 * Matches the inline ProgressBar function inside PropTab:
 *
 *   var pct = Math.min(pp.pct, 100);
 *   var barColor = pp.inverted
 *     ? (pct < 50 ? C.green : pct < 80 ? C.gold : C.red)
 *     : (pct < 50 ? C.blue  : pct < 80 ? C.gold : C.green);
 *
 *   h("div", { style: { marginBottom:10 } },
 *     h("div", { style: { display:"flex", justifyContent:"space-between", marginBottom:3 } },
 *       h("span", { style: { color:C.dim, fontSize:10 } }, pp.label),
 *       h("span", { style: { color: pp.inverted && pct>80 ? C.red : C.text,
 *                             fontSize:10, fontWeight:700 } }, pp.valueStr)
 *     ),
 *     h("div", { style: { background:C.bg, borderRadius:4, height:8, overflow:"hidden" } },
 *       h("div", { style: { width:pct+"%", height:"100%", background:barColor,
 *                             borderRadius:4, transition:"width 0.3s" } })
 *     )
 *   )
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface ProgressBarProps {
  /** Percentage 0–100 */
  pct:       number;
  label?:    string;
  valueStr?: string;
  /**
   * When true: color goes green→gold→red as pct rises (loss/drawdown limits).
   * When false: color goes blue→gold→green as pct rises (profit progress).
   * Matches original app exactly.
   */
  inverted?: boolean;
  height?:   number;
  style?:    React.CSSProperties;
}

export function ProgressBar({
  pct,
  label,
  valueStr,
  inverted = false,
  height   = 8,
  style,
}: ProgressBarProps) {
  const clamped = Math.min(Math.max(pct, 0), 100);

  // Bar color — matches original logic exactly
  const barColor = inverted
    ? clamped < 50 ? C.green : clamped < 80 ? C.gold : C.red
    : clamped < 50 ? C.blue  : clamped < 80 ? C.gold : C.green;

  // Value text color — matches original: inverted && pct > 80 ? C.red : C.text
  const valueColor = inverted && clamped > 80 ? C.red : C.text;

  return (
    <div style={{ marginBottom: 10, ...style }}>
      {(label || valueStr) && (
        <div
          style={{
            display:        'flex',
            justifyContent: 'space-between',
            marginBottom:   3,
          }}
        >
          {label && (
            <span style={{ color: C.dim, fontSize: 10 }}>{label}</span>
          )}
          {valueStr && (
            <span style={{ color: valueColor, fontSize: 10, fontWeight: 700 }}>
              {valueStr}
            </span>
          )}
        </div>
      )}

      <div
        style={{
          background:   C.bg,
          borderRadius: 4,
          height,
          overflow:     'hidden',
        }}
      >
        <div
          style={{
            width:        `${clamped}%`,
            height:       '100%',
            background:   barColor,
            borderRadius: 4,
            transition:   'width 0.3s ease',
          }}
        />
      </div>
    </div>
  );
}
