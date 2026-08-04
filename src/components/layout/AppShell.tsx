/**
 * components/layout/AppShell.tsx
 *
 * Top-level layout composition: Header + FilterBar + TabBar + content area.
 *
 * Matches the original App() component's JSX structure exactly:
 *
 *   return h("div", { style:{ background:C.bg, minHeight:"100vh", color:C.text } },
 *     h(Header ...),          // sticky top bar
 *     h(FilterBar, ...),      // account + market filters
 *     h(TabBar, ...),         // horizontal tab navigation
 *     h("div", { style:{ padding:14 } }, children)  // active tab content
 *   );
 *
 * Phase 4 — App Shell (layout only).
 *
 * CRITICAL: This component is a pure layout container.
 *   - It receives ALL data and handlers as props.
 *   - It does NOT call useTrades / useAccounts / useFilters / useLists.
 *   - It does NOT read or write LocalStorage.
 *   - It does NOT decide which page component to render — the caller
 *     passes the already-selected page as `children`.
 *
 * Wiring AppShell to the real hooks happens in a later phase when
 * pages are migrated (Phase 5+), NOT in Phase 4.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Header, type HeaderProps } from './Header.js';
import { FilterBar, type FilterBarProps } from './FilterBar.js';
import { TabBar, type TabBarProps } from './TabBar.js';

// ─── Types ───────────────────────────────────────────────────

export interface AppShellProps {
  /** Props forwarded verbatim to <Header> */
  headerProps:    HeaderProps;
  /**
   * Props forwarded verbatim to <FilterBar>.
   * Optional — some future pages (e.g. a full-screen Settings page)
   * may want to hide the filter bar entirely.
   */
  filterBarProps?: FilterBarProps;
  /** Props forwarded verbatim to <TabBar> */
  tabBarProps:    TabBarProps;
  /** Active tab's page content */
  children:       React.ReactNode;
  /**
   * Additional content rendered after the main content area —
   * used for modals (TradeForm, AccManager, SettingsManager, ImportExport).
   * Matches original app pattern where modals are conditionally
   * rendered as siblings at the end of the App() return statement.
   */
  modals?:        React.ReactNode;
  /** Padding around the content area — matches original (14px) */
  contentPadding?: number;
  style?:         React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────

export function AppShell({
  headerProps,
  filterBarProps,
  tabBarProps,
  children,
  modals,
  contentPadding = 14,
  style,
}: AppShellProps) {
  return (
    <div
      style={{
        background:  C.bg,
        minHeight:   '100vh',
        color:       C.text,
        ...style,
      }}
    >
      <Header {...headerProps} />

      {filterBarProps && <FilterBar {...filterBarProps} />}

      <TabBar {...tabBarProps} />

      <div style={{ padding: contentPadding }}>
        {children}
      </div>

      {modals}
    </div>
  );
}
