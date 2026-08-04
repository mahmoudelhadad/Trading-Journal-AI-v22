/**
 * components/layout/FilterBar.tsx
 *
 * Global filter bar shown below the header — account and market filters.
 *
 * Matches the original FilterBar(props) function exactly:
 *
 *   function FilterBar(props) {
 *     return h("div", { style: { display:"flex", gap:8, flexWrap:"wrap",
 *       alignItems:"center", padding:"7px 16px", background:C.card,
 *       borderBottom:"1px solid "+C.border } },
 *       h("span", ..., "Filter:"),
 *       // Account buttons: "All Accounts" + one per account
 *       // Divider
 *       // Market buttons: "All Markets" | "📈 Forex" | "📊 Futures"
 *     );
 *   }
 *
 * Phase 4 — App Shell (layout only).
 * Presentational only — no hooks, no LocalStorage, no business logic.
 * Filter state and account list are passed in as props.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';

// ─── Types ───────────────────────────────────────────────────

export interface FilterAccount {
  id:    string;
  name:  string;
  /** Hex color used for the active-state highlight */
  color: string;
}

export type MarketFilterValue = 'all' | 'forex' | 'futures';

export interface FilterBarProps {
  accounts:      FilterAccount[];
  accFilter:     string;               // 'all' | account id
  setAccFilter:  (id: string) => void;
  mktFilter:     MarketFilterValue;
  setMktFilter:  (v: MarketFilterValue) => void;
  style?:        React.CSSProperties;

  // ── Phase 22 — active global filter chip ──────────────────
  //
  // PROP CONTRACT: whenever `activeFilter` is supplied,
  // `visibleTradeCount` and `totalTradeCount` are expected to be
  // supplied with it — the chip has no meaningful rendering without
  // both. All four stay individually optional so that omitting the
  // whole group reproduces this component's pre-Phase-22 behavior
  // exactly.

  /** The saved filter acting as the global lens, or undefined when none */
  activeFilter?:         { name: string };
  /** Trades visible after account ∩ market ∩ group */
  visibleTradeCount?:    number;
  /** Total unfiltered trades — the chip's denominator */
  totalTradeCount?:      number;
  /** Clears the active group only; account/market filters are untouched */
  onClearActiveFilter?:  () => void;
}

// ─── Market filter option config ─────────────────────────────
// Matches original: [["all","All Markets"],["forex","📈 Forex"],["futures","📊 Futures"]]
const MARKET_OPTIONS: Array<{ value: MarketFilterValue; label: string; color: string }> = [
  { value: 'all',     label: 'All Markets', color: C.dim },
  { value: 'forex',   label: '📈 Forex',    color: C.blue },
  { value: 'futures', label: '📊 Futures',  color: C.orange },
];

// ─── Component ───────────────────────────────────────────────

export function FilterBar({
  accounts,
  accFilter,
  setAccFilter,
  mktFilter,
  setMktFilter,
  style,
  activeFilter,
  visibleTradeCount,
  totalTradeCount,
  onClearActiveFilter,
}: FilterBarProps) {
  return (
    <div
      style={{
        display:      'flex',
        gap:          8,
        flexWrap:     'wrap',
        alignItems:   'center',
        padding:      '7px 16px',
        background:   C.card,
        borderBottom: `1px solid ${C.border}`,
        ...style,
      }}
    >
      <span
        style={{
          color:         C.dim,
          fontSize:      9,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        Filter:
      </span>

      {/* ── Account filter buttons ────────────────────────── */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button
          onClick={() => setAccFilter('all')}
          style={{
            background:   accFilter === 'all' ? `${C.blue}22` : 'none',
            color:        accFilter === 'all' ? C.blue : C.dim,
            border:       `1px solid ${accFilter === 'all' ? C.blue : C.border}`,
            borderRadius: 5,
            padding:      '3px 10px',
            fontSize:     10,
            fontWeight:   600,
            cursor:       'pointer',
            fontFamily:   'inherit',
          }}
        >
          All Accounts
        </button>

        {accounts.map((a) => {
          const active = accFilter === a.id;
          return (
            <button
              key={a.id}
              onClick={() => setAccFilter(a.id)}
              style={{
                background:   active ? `${a.color}22` : 'none',
                color:        active ? a.color : C.dim,
                border:       `1px solid ${active ? a.color : C.border}`,
                borderRadius: 5,
                padding:      '3px 10px',
                fontSize:     10,
                fontWeight:   600,
                cursor:       'pointer',
                fontFamily:   'inherit',
              }}
            >
              {a.name}
            </button>
          );
        })}
      </div>

      {/* ── Divider ───────────────────────────────────────── */}
      <div style={{ width: 1, height: 16, background: C.border }} />

      {/* ── Market filter buttons ─────────────────────────── */}
      <div style={{ display: 'flex', gap: 4 }}>
        {MARKET_OPTIONS.map((opt) => {
          const active = mktFilter === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => setMktFilter(opt.value)}
              style={{
                background:   active ? `${opt.color}22` : 'none',
                color:        active ? opt.color : C.dim,
                border:       `1px solid ${active ? opt.color : C.border}`,
                borderRadius: 5,
                padding:      '3px 10px',
                fontSize:     10,
                fontWeight:   600,
                cursor:       'pointer',
                fontFamily:   'inherit',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* ── Phase 22 — active global filter chip ───────────── */}
      {/* Renders ONLY while a filter is active. The count is labelled
          "N of M trades", not "N matches": it is the result of
          account ∩ market ∩ group, which is a different quantity from
          the group's own match count shown by FilterPanel's builder
          preview. A zero count still renders — the chip must never
          hide itself, or an empty app would have no explanation. */}
      {activeFilter && (
        <>
          <div style={{ width: 1, height: 16, background: C.border }} />
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: `${C.blue}18`, border: `1px solid ${C.blue}55`,
              borderRadius: 5, padding: '3px 6px 3px 10px',
            }}
          >
            <span style={{ color: C.blue, fontSize: 10, fontWeight: 700 }}>
              🔍 {activeFilter.name}
            </span>
            <span style={{ color: C.dim, fontSize: 10 }}>
              {`${visibleTradeCount} of ${totalTradeCount} trades`}
            </span>
            <button
              onClick={onClearActiveFilter}
              title="Clear active filter"
              style={{
                background:   'none',
                border:       'none',
                color:        C.dim,
                fontSize:     12,
                lineHeight:   1,
                cursor:       'pointer',
                padding:      '0 2px',
                fontFamily:   'inherit',
              }}
            >
              ✕
            </button>
          </div>
        </>
      )}
    </div>
  );
}
