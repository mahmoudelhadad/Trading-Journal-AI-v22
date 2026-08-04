/**
 * components/ui/SectionHeader.tsx
 *
 * Colored section divider used inside forms and panels.
 * Matches original SH(p) function exactly:
 *   h("div", { style: { fontSize:9, fontWeight:700, textTransform:"uppercase",
 *     letterSpacing:"0.1em", color:p.c, background:p.c+"22",
 *     padding:"3px 8px", borderRadius:4, margin:"10px 0 6px" } }, p.label)
 *
 * Phase 3 — presentational only.
 */

import React from 'react';

export interface SectionHeaderProps {
  label:   string;
  color:   string;
  style?:  React.CSSProperties;
}

export function SectionHeader({ label, color, style }: SectionHeaderProps) {
  return (
    <div
      style={{
        fontSize:      9,
        fontWeight:    700,
        textTransform: 'uppercase',
        letterSpacing: '0.1em',
        color,
        background:    `${color}22`,
        padding:       '3px 8px',
        borderRadius:  4,
        margin:        '10px 0 6px',
        ...style,
      }}
    >
      {label}
    </div>
  );
}
