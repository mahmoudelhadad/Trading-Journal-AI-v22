/**
 * components/ui/Divider.tsx
 *
 * Horizontal rule / separator.
 * Matches original Divider() function:
 *   h("div", { style: { height:1, background:C.border, margin:"14px 0" } })
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface DividerProps {
  margin?: number;
  style?:  React.CSSProperties;
}

export function Divider({ margin = 14, style }: DividerProps) {
  return (
    <div
      style={{
        height:     1,
        background: C.border,
        margin:     `${margin}px 0`,
        ...style,
      }}
    />
  );
}
