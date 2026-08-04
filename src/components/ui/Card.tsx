/**
 * components/ui/Card.tsx
 *
 * Styled container with dark background, border, and border-radius.
 * Matches original Card(p) function:
 *   h("div", { style: { background:C.card, borderRadius:10,
 *     border:"1px solid "+C.border, padding:14, marginBottom:14, ...p.style } }, p.children)
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface CardProps {
  children:      React.ReactNode;
  padding?:      number;
  marginBottom?: number;
  style?:        React.CSSProperties;
  /** Click handler — makes the card interactive */
  onClick?:      () => void;
}

export function Card({
  children,
  padding      = 14,
  marginBottom = 14,
  style,
  onClick,
}: CardProps) {
  return (
    <div
      onClick={onClick}
      style={{
        background:    C.card,
        borderRadius:  10,
        border:        `1px solid ${C.border}`,
        padding,
        marginBottom,
        cursor:        onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
