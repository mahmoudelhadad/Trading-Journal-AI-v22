/**
 * components/ui/FormField.tsx
 *
 * Label + children wrapper used throughout the Trade Form.
 * Matches original FF(p) function exactly:
 *   h("div", { style: { marginBottom: 7 } },
 *     h("div", { style: { color: C.dim, fontSize: 9, marginBottom: 2,
 *                         textTransform: "uppercase", letterSpacing: "0.06em" } }, p.label),
 *     p.children
 *   )
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface FormFieldProps {
  label:        string;
  children:     React.ReactNode;
  marginBottom?: number;
  style?:       React.CSSProperties;
}

export function FormField({ label, children, marginBottom = 7, style }: FormFieldProps) {
  return (
    <div style={{ marginBottom, ...style }}>
      <div
        style={{
          color:          C.dim,
          fontSize:       9,
          marginBottom:   2,
          textTransform:  'uppercase',
          letterSpacing:  '0.06em',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
