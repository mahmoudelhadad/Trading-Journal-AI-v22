/**
 * components/layout/Sidebar.tsx
 *
 * Optional vertical navigation sidebar.
 *
 * IMPORTANT — Architectural note:
 * The original single-file app does NOT use a sidebar; it uses a
 * horizontal TabBar (see TabBar.tsx) for all navigation. This
 * component exists only to fulfil the approved Phase migration plan
 * ("components/layout/Sidebar.jsx") and to keep the architecture
 * future-proof for a possible layout redesign in a later phase.
 *
 * This component is NOT wired into AppShell's default layout and
 * does NOT change any current UI behavior. AppShell renders the
 * Header + FilterBar + TabBar exactly as the original app does.
 *
 * Phase 4 — App Shell (layout only).
 * Presentational only — no hooks, no business logic.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface SidebarItem {
  id:    string;
  label: string;
  icon?: React.ReactNode;
}

export interface SidebarProps {
  items:       SidebarItem[];
  activeId:    string;
  onChange:    (id: string) => void;
  /** Width in pixels — default matches typical dashboard sidebar sizing */
  width?:      number;
  collapsed?:  boolean;
  style?:      React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────

export function Sidebar({
  items,
  activeId,
  onChange,
  width     = 220,
  collapsed = false,
  style,
}: SidebarProps) {
  return (
    <div
      style={{
        width:        collapsed ? 60 : width,
        background:   C.card,
        borderRight:  `1px solid ${C.border}`,
        display:      'flex',
        flexDirection:'column',
        padding:      '10px 8px',
        gap:          2,
        flexShrink:   0,
        transition:   'width 0.15s ease',
        ...style,
      }}
    >
      {items.map((item) => {
        const active = activeId === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onChange(item.id)}
            title={item.label}
            style={{
              display:      'flex',
              alignItems:   'center',
              gap:          10,
              background:   active ? '#1A3A6B' : 'none',
              color:        active ? '#60A5FA' : C.dim,
              border:       'none',
              borderRadius: 7,
              padding:      collapsed ? '10px' : '9px 12px',
              fontSize:     12,
              fontWeight:   600,
              cursor:       'pointer',
              textAlign:    'left',
              justifyContent: collapsed ? 'center' : 'flex-start',
              fontFamily:   'inherit',
            }}
          >
            {item.icon && <span style={{ lineHeight: 1 }}>{item.icon}</span>}
            {!collapsed && <span>{item.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
