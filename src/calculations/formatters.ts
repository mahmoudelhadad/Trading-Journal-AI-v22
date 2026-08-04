/**
 * calculations/formatters.ts
 *
 * Phase 5 — Display formatting helpers.
 *
 * Copied VERBATIM from the original single-file app.
 * These are pure functions with no side effects — they format
 * computed numeric values (R, %, $, points) for display, and map
 * trade outcomes to their display color.
 *
 * Backward compatibility: FULLY PRESERVED
 * Every formatting rule (sign, decimals, — for null) is unchanged.
 */

import { COLORS as C } from '@constants/lists.js';
import type { TradeOutcome } from './tradeCalc.js';

/**
 * Format functions object.
 * Original variable name: fr
 *
 *   fr.r(v)   → "+1.50R" | "-0.80R" | "—"
 *   fr.pct(v) → "12.5%"  | "—"
 *   fr.usd(v) → "+$120.00" | "-$45.30" | "—"
 *   fr.pt(v)  → "+15.20" | "-8.00" | "—"
 */
export const fr = {
  /** Format R multiple — matches original: v>=0 ? '+'+v.toFixed(2)+'R' : v.toFixed(2)+'R' */
  r: (v: number | null): string =>
    v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2) + 'R',

  /** Format percentage — matches original: (v*100).toFixed(1)+'%' */
  pct: (v: number | null): string =>
    v === null ? '—' : (v * 100).toFixed(1) + '%',

  /** Format USD — matches original: v>=0 ? '+$'+abs(v).toFixed(2) : '-$'+abs(v).toFixed(2) */
  usd: (v: number | null): string =>
    v === null ? '—' : (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2),

  /** Format pips/points — matches original: v>=0 ? '+'+v.toFixed(2) : v.toFixed(2) */
  pt: (v: number | null): string =>
    v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2),
};

/**
 * Map trade outcome to its display color.
 * Original: function oc(o) { return ({Green:C.green,Red:C.red,Breakeven:C.gold})[o] || C.dim; }
 *
 * @param outcome - 'Green' | 'Red' | 'Breakeven' | ''
 * @returns Hex color string
 */
export function getOutcomeColor(outcome: TradeOutcome): string {
  const map: Record<string, string> = {
    Green:     C.green,
    Red:       C.red,
    Breakeven: C.gold,
  };
  return map[outcome] ?? C.dim;
}

/**
 * Get the display color for a direction value ('Long' | 'Short').
 * Extracted from repeated inline pattern in RawTab:
 *   t.direction==="Long" ? C.green : t.direction==="Short" ? C.red : C.dim
 */
export function getDirectionColor(direction: string): string {
  if (direction === 'Long') return C.green;
  if (direction === 'Short') return C.red;
  return C.dim;
}

/**
 * Get the display color for a signed numeric value (P/L, R, points).
 * Extracted from repeated inline pattern in RawTab:
 *   v !== null ? (v > 0 ? C.green : C.red) : C.dim
 */
export function getSignColor(value: number | null): string {
  if (value === null) return C.dim;
  return value > 0 ? C.green : C.red;
}

/**
 * Get the display color for Plan Followed ('Yes' | 'No').
 * Extracted from repeated inline pattern in RawTab:
 *   t.planFollowed==="Yes" ? C.green : t.planFollowed==="No" ? C.red : C.dim
 */
export function getPlanFollowedColor(planFollowed: string): string {
  if (planFollowed === 'Yes') return C.green;
  if (planFollowed === 'No') return C.red;
  return C.dim;
}

/**
 * Format a date string as short weekday name.
 * Matches original inline pattern used in RawTab and period tabs:
 *   t.date ? new Date(t.date+"T12:00").toLocaleDateString("en",{weekday:"short"}) : "—"
 *
 * Note: "T12:00" is appended to avoid timezone rollback issues —
 * copied exactly from original.
 */
/**
 * Phase 20B — Production Readiness Fixes: parameter type widened from
 * `string` to `string | undefined` to match what this function's body
 * ALREADY did at runtime (`if (!date) return '—';` already handles
 * undefined/null/empty-string identically via JS falsy semantics).
 * This is a type-signature-only change — zero runtime behavior change.
 * Fixes a genuine `tsc --noEmit` error at the one call site
 * (TradeRow.tsx) that passes `date?: string` (optional) from
 * EnrichedTrade/TradeLike.
 */
export function formatDayShort(date: string | undefined): string {
  if (!date) return '—';
  return new Date(date + 'T12:00').toLocaleDateString('en', { weekday: 'short' });
}
