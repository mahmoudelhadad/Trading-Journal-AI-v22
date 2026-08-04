/**
 * constants/lists.js
 *
 * Default dropdown lists and default accounts.
 * Copied verbatim from the original single-file app.
 * No values changed, no keys renamed, no items removed.
 *
 * Backward compatibility: PRESERVED
 * - DEFAULT_LISTS keys match LocalStorage key "fxj_v4_lists"
 * - DEFAULT_ACCOUNTS matches LocalStorage key "fxj_v4_accounts"
 * - Users who saved custom lists will have them loaded from storage;
 *   these defaults are only used when no saved data exists.
 */

// ─── Dropdown Lists ─────────────────────────────────────────
// Original variable name: DEFAULT_LISTS
export const DEFAULT_LISTS = {
  Broker:         ['FTMO', 'E2T', 'TTP', 'Tradovate', 'Interactive Brokers', 'NinjaTrader'],
  Account:        ['EVAL', 'Funded', 'Back Test', 'Demo', 'Real', 'Paper'],
  DailySetup:     ['Po3', 'AMD', 'SMT', '50% Fib'],
  Liquidity:      ['LN', 'AS', 'NY', 'Swing H/L', '5M FVG', '15M FVG', '1H FVG', 'PDH/L', 'DH/L', 'PWH/L'],
  EntrySetup:     ['FVG', 'BB', 'IFVG', 'OB', 'MB'],
  IntraDaySetup:  ['MSS', 'IFVG', 'MSB', 'CSID'],
  IntraDayTF:     ['1M', '2M', '3M', '5M', '15M', '30S', '15S'],
  Session:        ['NY am', 'NY pm', 'LN', 'AS', 'Globex'],
  DaySwing:       ['Day', 'Swing'],
  Direction:      ['Long', 'Short'],
  SetupType:      ['A+', 'A', 'B', 'C'],
  Rating:         ['0', '1', '2', '3', '4', '5'],
  PlanFollowed:   ['Yes', 'No'],
  Emotions:       ['FOMO', 'Fear', 'Greed', 'Hoping', 'Revenge', 'Mistrust', 'Anxiety', 'Happy', 'Confidence', 'Ego'],
};

// ─── Default Accounts ───────────────────────────────────────
// Original variable name: DEFAULT_ACCOUNTS
// Used only when no accounts exist in LocalStorage ("fxj_v4_accounts")
export const DEFAULT_ACCOUNTS = [
  { id: 'acc_1', name: 'Main Account', capital: 10000, color: '#3B82F6' },
];

// ─── Theme Colors ────────────────────────────────────────────
// Original variable name: C
// Copied verbatim — no color changed
export const COLORS = {
  bg:     '#0D1421',
  card:   '#111D2E',
  row:    '#1A2535',
  rowAlt: '#152030',
  border: '#243350',
  text:   '#C8D6E8',
  dim:    '#6B82A0',
  white:  '#FFFFFF',
  blue:   '#3B82F6',
  green:  '#22C55E',
  red:    '#EF4444',
  gold:   '#F59E0B',
  purple: '#8B5CF6',
  teal:   '#14B8A6',
  orange: '#F97316',
  pink:   '#EC4899',
  // Phase 20 — Architecture Cleanup (finding M-4): named entries for
  // values that were previously magic hex literals inline in
  // Calendar.tsx (faithfully migrated from the original app's exact
  // day-cell colors in Phase 10, just never centralized as constants).
  winBg:      '#0F2A1A',
  lossBg:     '#2A0F0F',
  winBorder:  '#22C55E44',
  lossBorder: '#EF444444',
};

// ─── Account Color Options ───────────────────────────────────
// Used in AccManager color picker — matches original hardcoded array
export const ACCOUNT_COLORS = [
  '#3B82F6', '#22C55E', '#F59E0B', '#EF4444',
  '#8B5CF6', '#14B8A6', '#F97316', '#EC4899',
  '#6366F1', '#84CC16',
];
