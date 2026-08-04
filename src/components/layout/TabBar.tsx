/**
 * components/layout/TabBar.tsx
 *
 * Horizontal tab navigation bar.
 *
 * Matches the original inline tabs block inside App():
 *
 *   h("div", { style: { background:C.card, borderBottom:"1px solid "+C.border,
 *     padding:"0 16px", display:"flex", gap:2, overflowX:"auto" } },
 *     TABS.map(t => {
 *       var active = tab === t.id;
 *       return h("button", { key:t.id, className:"tab-btn"+(active?" active":""),
 *         onClick:() => setTab(t.id) }, t.l);
 *     })
 *   )
 *
 * The original TABS array (for reference — not hardcoded here,
 * passed in as props so pages can be added/removed without
 * touching this component):
 *
 *   [{id:"dashboard", l:"📊 Dashboard"}, {id:"raw", l:"📋 Raw"},
 *    {id:"daily", l:"📅 Daily"}, {id:"weekly", l:"📆 Weekly"},
 *    {id:"monthly", l:"🗓 Monthly"}, {id:"strategy", l:"🧠 Strategy"},
 *    {id:"calendar", l:"📅 Calendar"}, {id:"insights", l:"🤖 Insights"},
 *    {id:"prop", l:"🏆 Prop"}, {id:"calc", l:"📐 Calc"}]
 *
 * Uses the existing `.tab-btn` / `.tab-btn.active` CSS classes
 * defined in src/index.css (Phase 0) — same visual result as original.
 *
 * Phase 4 — App Shell (layout only).
 * Presentational only — no hooks, no routing logic beyond calling
 * the onChange callback. Active tab state is owned by the parent.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface TabItem {
  /** Unique tab identifier, e.g. 'dashboard', 'raw' */
  id:    string;
  /** Display label including emoji, e.g. '📊 Dashboard' */
  label: string;
}

export interface TabBarProps {
  tabs:        TabItem[];
  activeTab:   string;
  onChange:    (tabId: string) => void;
  style?:      React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────

export function TabBar({ tabs, activeTab, onChange, style }: TabBarProps) {
  return (
    <div
      style={{
        background:   C.card,
        borderBottom: `1px solid ${C.border}`,
        padding:      '0 16px',
        display:      'flex',
        gap:          2,
        overflowX:    'auto',
        ...style,
      }}
    >
      {tabs.map((t) => {
        const active = activeTab === t.id;
        return (
          <button
            key={t.id}
            className={`tab-btn${active ? ' active' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
