/**
 * components/ui/Select.tsx
 *
 * Reusable select/dropdown component.
 * Matches original Sel(p) function:
 *   h("select", { value, onChange, style: { width } }, h("option", {value:""}, placeholder), opts.map(...))
 *
 * Supports both string[] and { value, label }[] options.
 * Phase 3 — presentational only.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

export type SelectOption =
  | string
  | { value: string; label: string };

export interface SelectProps {
  value:        string;
  onChange:     (value: string) => void;
  options:      SelectOption[];
  placeholder?: string;
  disabled?:    boolean;
  width?:       string | number;
  style?:       React.CSSProperties;
  id?:          string;
}

function getOptionValue(opt: SelectOption): string {
  return typeof opt === 'string' ? opt : opt.value;
}

function getOptionLabel(opt: SelectOption): string {
  return typeof opt === 'string' ? opt : opt.label;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = '—',
  disabled    = false,
  width       = '100%',
  style,
  id,
}: SelectProps) {
  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background:   C.bg,
        color:        C.text,
        border:       `1px solid ${C.border}`,
        borderRadius: 6,
        padding:      '5px 8px',
        fontSize:     11,
        outline:      'none',
        fontFamily:   'inherit',
        width,
        opacity:      disabled ? 0.5 : 1,
        cursor:       disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
    >
      <option value="">{placeholder}</option>
      {options.map((opt) => {
        const v = getOptionValue(opt);
        const l = getOptionLabel(opt);
        return <option key={v} value={v}>{l}</option>;
      })}
    </select>
  );
}
