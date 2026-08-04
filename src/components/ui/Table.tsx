/**
 * components/ui/Table.tsx
 *
 * Table primitives: TableHeader (Th) and TableCell (Td).
 * Matches original Th(p) and Td(p) functions exactly:
 *
 *   function Th(p) {
 *     var s = { background:"#0A1020", color:C.dim, fontSize:9, fontWeight:600,
 *       textTransform:"uppercase", padding:"7px 8px", textAlign:"center",
 *       borderBottom:"1px solid "+C.border, whiteSpace:"nowrap" };
 *     if (p.s) Object.keys(p.s).forEach(k => s[k] = p.s[k]);
 *     return h("th", { style: s }, p.children);
 *   }
 *
 *   function Td(p) {
 *     var s = { color:C.text, fontSize:11, padding:"6px 8px", textAlign:"center",
 *       borderBottom:"1px solid #151E2E", whiteSpace:"nowrap" };
 *     if (p.s) Object.keys(p.s).forEach(k => s[k] = p.s[k]);
 *     return h("td", { style: s }, p.children);
 *   }
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── TableHeader (Th) ────────────────────────────────────────

export interface TableHeaderProps {
  children:  React.ReactNode;
  style?:    React.CSSProperties;
}

export function TableHeader({ children, style }: TableHeaderProps) {
  return (
    <th
      style={{
        background:    '#0A1020',
        color:         C.dim,
        fontSize:      9,
        fontWeight:    600,
        textTransform: 'uppercase',
        padding:       '7px 8px',
        textAlign:     'center',
        borderBottom:  `1px solid ${C.border}`,
        whiteSpace:    'nowrap',
        ...style,
      }}
    >
      {children}
    </th>
  );
}

// ─── TableCell (Td) ──────────────────────────────────────────

export interface TableCellProps {
  children:  React.ReactNode;
  style?:    React.CSSProperties;
  colSpan?:  number;
}

export function TableCell({ children, style, colSpan }: TableCellProps) {
  return (
    <td
      colSpan={colSpan}
      style={{
        color:        C.text,
        fontSize:     11,
        padding:      '6px 8px',
        textAlign:    'center',
        borderBottom: '1px solid #151E2E',
        whiteSpace:   'nowrap',
        ...style,
      }}
    >
      {children}
    </td>
  );
}
