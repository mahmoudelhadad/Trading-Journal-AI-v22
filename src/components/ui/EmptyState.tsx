/**
 * components/ui/EmptyState.tsx
 *
 * No-data placeholder — used whenever a chart or table has no data.
 * Matches the original inline noData pattern:
 *   h("div", { style: { color:C.dim, fontSize:11, padding:30, textAlign:"center" } },
 *     "Add trades to see data")
 *
 * Extended with optional icon and action button for richer empty states.
 *
 * Used in:
 *   - Dashboard charts (equity, monthly R, symbol R, etc.)
 *   - Strategy tables (not enough data)
 *   - Raw tab (no trades yet)
 *   - All period tabs (Daily, Weekly, Monthly)
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface EmptyStateAction {
  label:   string;
  onClick: () => void;
}

export interface EmptyStateProps {
  /** Main message — defaults to original app text */
  message?:  string;
  /** Optional emoji or text icon above the message */
  icon?:     string;
  /** Optional CTA button */
  action?:   EmptyStateAction;
  padding?:  number;
  fontSize?: number;
  style?:    React.CSSProperties;
}

export function EmptyState({
  message  = 'Add trades to see data',
  icon,
  action,
  padding  = 30,
  fontSize = 11,
  style,
}: EmptyStateProps) {
  return (
    <div
      style={{
        color:      C.dim,
        fontSize,
        padding,
        textAlign:  'center',
        lineHeight: 1.6,
        ...style,
      }}
    >
      {icon && (
        <div style={{ fontSize: 28, marginBottom: 10 }}>{icon}</div>
      )}

      <div>{message}</div>

      {action && (
        <button
          onClick={action.onClick}
          style={{
            marginTop:    12,
            background:   C.blue,
            color:        '#fff',
            border:       'none',
            borderRadius: 7,
            padding:      '6px 16px',
            fontSize:     11,
            fontWeight:   700,
            cursor:       'pointer',
            fontFamily:   'inherit',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
