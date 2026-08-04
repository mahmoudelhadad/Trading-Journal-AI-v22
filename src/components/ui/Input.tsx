/**
 * components/ui/Input.tsx
 *
 * Reusable input component.
 * Matches original Inp(p) function:
 *   h("input", { type, value, placeholder, step:"any", onChange, style: { width } })
 *
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export interface InputProps {
  value:        string | number;
  onChange:     (value: string) => void;
  type?:        'text' | 'number' | 'date' | 'time' | 'email' | 'url' | 'password';
  placeholder?: string;
  disabled?:    boolean;
  width?:       string | number;
  style?:       React.CSSProperties;
  /** Passed through to native input for number inputs */
  min?:         string | number;
  max?:         string | number;
  step?:        string | number;
  autoFocus?:   boolean;
  id?:          string;
}

export function Input({
  value,
  onChange,
  type        = 'text',
  placeholder = '',
  disabled    = false,
  width       = '100%',
  style,
  min,
  max,
  step        = 'any',
  autoFocus,
  id,
}: InputProps) {
  return (
    <input
      id={id}
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background:  C.bg,
        color:       C.text,
        border:      `1px solid ${C.border}`,
        borderRadius: 6,
        padding:     '5px 8px',
        fontSize:    11,
        outline:     'none',
        fontFamily:  'inherit',
        width,
        opacity:     disabled ? 0.5 : 1,
        cursor:      disabled ? 'not-allowed' : 'text',
        ...style,
      }}
    />
  );
}
