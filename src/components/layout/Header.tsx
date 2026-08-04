/**
 * components/layout/Header.tsx
 *
 * Top app bar — logo, title, subtitle, and action buttons.
 *
 * Matches the original inline header block inside App():
 *
 *   h("div", { style: { background:C.card, borderBottom:"1px solid "+C.border,
 *     padding:"9px 16px", display:"flex", alignItems:"center",
 *     justifyContent:"space-between", position:"sticky", top:0, zIndex:100 } },
 *     h("div", ...logo + title + subtitle...),
 *     h("div", ...action buttons...)
 *   )
 *
 * Phase 4 — App Shell (layout only).
 * This component is PURELY presentational:
 *   - No hooks
 *   - No LocalStorage access
 *   - No business logic
 * All dynamic values (trade count, account count, click handlers)
 * are passed in as props by the parent — wiring happens in a later phase.
 *
 * Phase 2.1 — Supabase Authentication: added an optional `userMenu`
 * slot, rendered after the existing action buttons on the right side.
 * When absent (the previous default), the header's markup and layout
 * are completely unchanged. See components/auth/UserMenu.tsx (rendered
 * here by App.jsx) — this file has no auth logic of its own.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface HeaderAction {
  /** Unique key for React list rendering */
  id:       string;
  /** Icon or short label rendered inside the button, e.g. '📂', '💼', '⚙' */
  icon:     React.ReactNode;
  /** Accessible label / tooltip text */
  label:    string;
  onClick:  () => void;
  /**
   * Visual style — matches original app:
   *   'primary'   → blue background (e.g. "+ New Trade")
   *   'secondary' → dark row background with border (icon-only buttons)
   */
  variant?: 'primary' | 'secondary';
}

export interface HeaderProps {
  /** App title — defaults to original "Trading Journal" */
  title?:     string;
  /** Subtitle line under the title, e.g. "90 trades · 3 accounts" */
  subtitle?:  string;
  /** Logo emoji/icon — defaults to original "📈" */
  logoIcon?:  React.ReactNode;
  /** Right-aligned action buttons (New Trade, Import, Accounts, Settings...) */
  actions?:   HeaderAction[];
  /**
   * Optional content rendered after `actions`, furthest right.
   * Added Phase 2.1 for components/auth/UserMenu.tsx — the avatar +
   * dropdown menu. Purely a render slot; Header has no idea what's in it.
   */
  userMenu?:  React.ReactNode;
  /** Sticky positioning — matches original (position: sticky, top: 0) */
  sticky?:    boolean;
  style?:     React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────

export function Header({
  title    = 'Trading Journal',
  subtitle,
  logoIcon = '📈',
  actions  = [],
  userMenu,
  sticky   = true,
  style,
}: HeaderProps) {
  return (
    <div
      style={{
        background:     C.card,
        borderBottom:   `1px solid ${C.border}`,
        padding:        '9px 16px',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'space-between',
        position:       sticky ? 'sticky' : 'static',
        top:            0,
        zIndex:         100,
        ...style,
      }}
    >
      {/* ── Left: logo + title/subtitle ──────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width:          34,
            height:         34,
            borderRadius:   8,
            background:     'linear-gradient(135deg,#1E3A6E,#0D2344)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            fontSize:       18,
          }}
        >
          {logoIcon}
        </div>

        <div>
          <div style={{ fontWeight: 800, fontSize: 14, color: C.white }}>
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 9, color: C.dim }}>{subtitle}</div>
          )}
        </div>
      </div>

      {/* ── Right: action buttons + user menu ────────────── */}
      {(actions.length > 0 || userMenu) && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {actions.length > 0 && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {actions.map((action) => {
                const isPrimary = action.variant === 'primary';
                return (
                  <button
                    key={action.id}
                    onClick={action.onClick}
                    title={action.label}
                    style={{
                      background:   isPrimary ? C.blue : C.row,
                      color:        isPrimary ? '#fff' : C.text,
                      border:       isPrimary ? 'none' : `1px solid ${C.border}`,
                      borderRadius: 7,
                      padding:      isPrimary ? '6px 13px' : '6px 10px',
                      fontSize:     11,
                      fontWeight:   isPrimary ? 700 : 400,
                      cursor:       'pointer',
                      fontFamily:   'inherit',
                    }}
                  >
                    {action.icon}
                    {isPrimary && <span style={{ marginLeft: 4 }}>{action.label}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {userMenu}
        </div>
      )}
    </div>
  );
}
