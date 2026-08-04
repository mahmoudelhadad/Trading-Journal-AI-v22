/**
 * components/ui/Badge.tsx
 *
 * Colored pill/tag for outcomes, market types, status labels.
 * Matches original Badge(p) function:
 *   h("span", { style: { color:p.c, fontWeight:700, fontSize:10,
 *     background:p.c+"22", padding:"2px 7px", borderRadius:4 } }, p.children)
 *
 * Used for:
 *   - Trade outcome: Green / Red / Breakeven
 *   - Market type:   FX / Fut
 *   - Prop status:   PASSED / FAILED / IN PROGRESS
 *
 * Phase 3 — presentational only.
 */

import React from 'react';

export interface BadgeProps {
  children:  React.ReactNode;
  /** Hex color — sets both text and background (at 13% opacity) */
  color:     string;
  fontSize?: number;
  style?:    React.CSSProperties;
}

export function Badge({ children, color, fontSize = 10, style }: BadgeProps) {
  return (
    <span
      style={{
        color,
        fontWeight:   700,
        fontSize,
        background:   `${color}22`,
        padding:      '2px 7px',
        borderRadius: 4,
        display:      'inline-block',
        lineHeight:   1.4,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
