/**
 * components/ui/Button.tsx
 *
 * Reusable button component.
 * Covers all button usages in the original app:
 *   - Primary action (blue)     → variant="primary"
 *   - Danger / delete (red)     → variant="danger"
 *   - Secondary / neutral       → variant="secondary"
 *   - Ghost / text-only         → variant="ghost"
 *
 * Phase 3 — presentational only. No hooks. No business logic.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
export type ButtonSize    = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  children:   React.ReactNode;
  onClick?:   (e: React.MouseEvent<HTMLButtonElement>) => void;
  variant?:   ButtonVariant;
  size?:      ButtonSize;
  disabled?:  boolean;
  fullWidth?: boolean;
  type?:      'button' | 'submit' | 'reset';
  style?:     React.CSSProperties;
  /** Optional icon rendered before children */
  icon?:      React.ReactNode;
}

// ─── Style maps ──────────────────────────────────────────────

const BG: Record<ButtonVariant, string> = {
  primary:   C.blue,
  success:   C.green,
  danger:    '#3A1A1A',
  secondary: C.border,
  ghost:     'none',
};

const FG: Record<ButtonVariant, string> = {
  primary:   '#ffffff',
  success:   '#ffffff',
  danger:    C.red,
  secondary: C.text,
  ghost:     C.dim,
};

const BORDER: Record<ButtonVariant, string> = {
  primary:   'none',
  success:   'none',
  danger:    `1px solid ${C.red}44`,
  secondary: 'none',
  ghost:     'none',
};

const PADDING: Record<ButtonSize, string> = {
  sm: '3px 10px',
  md: '6px 14px',
  lg: '9px 22px',
};

const FONT_SIZE: Record<ButtonSize, number> = {
  sm: 10,
  md: 11,
  lg: 13,
};

// ─── Component ───────────────────────────────────────────────

export function Button({
  children,
  onClick,
  variant   = 'secondary',
  size      = 'md',
  disabled  = false,
  fullWidth = false,
  type      = 'button',
  style,
  icon,
}: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        background:    BG[variant],
        color:         FG[variant],
        border:        BORDER[variant],
        borderRadius:  7,
        padding:       PADDING[size],
        fontSize:      FONT_SIZE[size],
        fontWeight:    700,
        cursor:        disabled ? 'not-allowed' : 'pointer',
        opacity:       disabled ? 0.5 : 1,
        width:         fullWidth ? '100%' : undefined,
        display:       'inline-flex',
        alignItems:    'center',
        justifyContent:'center',
        gap:           icon ? 6 : 0,
        transition:    'opacity 0.12s',
        fontFamily:    'inherit',
        ...style,
      }}
    >
      {icon && <span style={{ lineHeight: 1 }}>{icon}</span>}
      {children}
    </button>
  );
}
