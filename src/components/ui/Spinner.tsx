/**
 * components/ui/Spinner.tsx
 *
 * Loading indicator.
 * The original app used a plain text loading message
 * (see initApp() failure fallback and the root #root placeholder
 * in index.html: "⏳ Loading..."). This component formalises
 * that pattern as a reusable, animated component.
 *
 * New in Phase 3 — no direct original equivalent, but required
 * for future async operations (import, backup/restore, etc.)
 * without introducing new UI behavior into existing pages yet.
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface SpinnerProps {
  size?:    number;
  color?:   string;
  message?: string;
  style?:   React.CSSProperties;
}

export function Spinner({ size = 24, color = C.blue, message, style }: SpinnerProps) {
  return (
    <div
      style={{
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        gap:            10,
        padding:        20,
        ...style,
      }}
    >
      <div
        style={{
          width:        size,
          height:       size,
          border:       `3px solid ${color}33`,
          borderTop:    `3px solid ${color}`,
          borderRadius: '50%',
          animation:    'tj-spin 0.8s linear infinite',
        }}
      />
      {message && (
        <div style={{ color: C.dim, fontSize: 11 }}>{message}</div>
      )}

      {/* Inline keyframes — avoids requiring a separate CSS import */}
      <style>{`
        @keyframes tj-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
