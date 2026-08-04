/**
 * calculations/filterEngine.ts
 *
 * Phase 14 — Advanced Filters: condition evaluation engine.
 *
 * NEW module — no original-app equivalent (the original app only ever
 * supported simple, hardcoded field=value AND-only filters — see
 * RawTab's 4-field filter, Phase 5, and the global account/market
 * FilterBar, Phase 4). This is genuinely new functionality, explicitly
 * pre-approved in the original migration plan's ADVANCED FILTERS
 * section: *"Support filtering by everything. Allow: Multiple Filters,
 * AND / OR, Saved Filters, Favorite Filters, Quick Filters."*
 *
 * SCOPE NOTE (per your "do not redesign the UI" / "do not introduce
 * features outside approved scope" rules): this module — and the
 * hook/components built alongside it in this phase — implement the
 * advanced-filter CAPABILITY as new, self-contained, opt-in
 * architecture. Nothing here is wired into any EXISTING page's filter
 * UI (Raw's 4-field filter, the global account/market FilterBar, or
 * Strategy's Multi-Filter Comparison tool all continue working exactly
 * as before, completely untouched). This mirrors the Phase 8 precedent
 * (`useAdvancedAnalytics` was built and fully validated a full phase
 * before any page consumed it, in Phase 9) — the capability exists,
 * tested and ready, for a future phase to explicitly wire into a page
 * with your separate approval.
 *
 * OPERATOR SCOPE (documented, intentional): supports 'equals',
 * 'notEquals', 'contains', 'gt', 'gte', 'lt', 'lte'. This is a
 * deliberately curated set covering categorical fields (equals/
 * notEquals/contains) and numeric fields (gt/gte/lt/lte) — not an
 * open-ended expression language. "Filtering by everything" in the
 * approved plan is interpreted as "any trade field can be used as a
 * condition," not "arbitrary boolean/regex/date-range expressions,"
 * to avoid over-engineering beyond what was actually requested.
 */

import type { EnrichedTrade } from './tradeCalc.js';
import { nextId } from './idGenerator.js';

// ─── Types ───────────────────────────────────────────────────

export type FilterOperator = 'equals' | 'notEquals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

export interface FilterCondition {
  id:       string;
  /** Any field on EnrichedTrade — categorical (string) or numeric (_r, _pl, _netPL, _pts, personalRating) */
  field:    string;
  operator: FilterOperator;
  /** Comparison value — always entered as a string; numeric operators parse it with Number() */
  value:    string;
}

export type FilterLogic = 'AND' | 'OR';

export interface FilterGroup {
  id:         string;
  logic:      FilterLogic;
  conditions: FilterCondition[];
}

export interface SavedFilter {
  id:         string;
  name:       string;
  group:      FilterGroup;
  isFavorite: boolean;
  /** Timestamp (Date.now()) — for sorting saved filters by recency if needed later */
  createdAt:  number;
}

// ─── Condition evaluation ────────────────────────────────────

/**
 * Evaluate a single condition against one trade.
 * FORMULA:
 *   'equals'    → String(trade[field]) === value   (case-sensitive exact match,
 *                 matches the existing app-wide convention used by Raw's
 *                 filters and Strategy's Multi-Filter Comparison — both
 *                 use strict `===` on raw field values)
 *   'notEquals' → String(trade[field]) !== value
 *   'contains'  → String(trade[field]).toLowerCase().includes(value.toLowerCase())
 *                 (case-INSENSITIVE — a deliberate, documented exception
 *                 to the equals/notEquals convention above, since a
 *                 substring search is far less useful if case-sensitive)
 *   'gt'/'gte'/'lt'/'lte' → Number(trade[field]) compared to Number(value)
 *                 (numeric fields only — see edge cases)
 * SOURCE:  New — no original-app equivalent.
 * ASSUMPTIONS: `field` is read via bracket access on the trade object.
 *   A field name not present on the trade reads as `undefined`, which
 *   is NORMALIZED TO `''` before any string comparison (see the
 *   `strVal` line in evaluateCondition below) — it does NOT stringify
 *   to `"undefined"`. So for an absent field: `equals ''` matches,
 *   `equals 'anything-else'` does not, `notEquals ''` does not match,
 *   and `contains ''` matches. Numeric operators still yield `NaN` via
 *   `Number(undefined)` and bail out through the isNaN guard (see edge
 *   cases).
 *
 *   Corrected in the Phase 22 documentation pass. This block previously
 *   claimed absent fields stringify to `"undefined"`, which the code
 *   has never done. The behavior described above is characterized by
 *   filterEngine.test.ts (Phase 22) — the tests document the
 *   implementation, and this header now agrees with both. No code
 *   changed; this is a comment correction only.
 * EDGE CASES:
 *   - Numeric operators (gt/gte/lt/lte) return `false` if either side
 *     parses to NaN (e.g. comparing a non-numeric field, or an empty
 *     `value` string) — a non-comparable condition never matches,
 *     rather than throwing or matching everything.
 *   - A `value` of `''` (empty string) for 'equals' matches trades
 *     where that field is genuinely empty/unset — this is intentional,
 *     letting a condition express "field is empty."
 */
export function evaluateCondition(trade: EnrichedTrade, condition: FilterCondition): boolean {
  const raw = (trade as unknown as Record<string, unknown>)[condition.field];
  const strVal = raw === null || raw === undefined ? '' : String(raw);

  switch (condition.operator) {
    case 'equals':
      return strVal === condition.value;
    case 'notEquals':
      return strVal !== condition.value;
    case 'contains':
      return strVal.toLowerCase().includes(condition.value.toLowerCase());
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const left = Number(raw);
      const right = Number(condition.value);
      if (isNaN(left) || isNaN(right)) return false;
      if (condition.operator === 'gt') return left > right;
      if (condition.operator === 'gte') return left >= right;
      if (condition.operator === 'lt') return left < right;
      return left <= right; // 'lte'
    }
    default:
      return false;
  }
}

/**
 * Evaluate a full filter group (multiple conditions combined with AND/OR).
 * FORMULA: AND → every condition must be true. OR → at least one condition
 *          must be true.
 * EDGE CASES: An empty conditions array always returns `true` (an empty
 *          filter matches everything — "no conditions" means "no
 *          restriction," consistent with how the existing Raw/global
 *          filters already treat an unset field as "no filter").
 */
export function evaluateGroup(trade: EnrichedTrade, group: FilterGroup): boolean {
  if (group.conditions.length === 0) return true;
  return group.logic === 'AND'
    ? group.conditions.every((c) => evaluateCondition(trade, c))
    : group.conditions.some((c) => evaluateCondition(trade, c));
}

/**
 * Apply a filter group to an array of trades.
 */
export function applyFilterGroup(trades: EnrichedTrade[], group: FilterGroup): EnrichedTrade[] {
  return trades.filter((t) => evaluateGroup(t, group));
}

// ─── Factory helpers ─────────────────────────────────────────
// nextId() is imported from idGenerator.js (Phase 15 consolidation) —
// see that file's header for why this was extracted.

export function createFilterCondition(field = '', operator: FilterOperator = 'equals', value = ''): FilterCondition {
  return { id: nextId('cond'), field, operator, value };
}

export function createFilterGroup(logic: FilterLogic = 'AND', conditions: FilterCondition[] = []): FilterGroup {
  return { id: nextId('group'), logic, conditions };
}

export function createSavedFilter(name: string, group: FilterGroup, isFavorite = false): SavedFilter {
  return { id: nextId('saved'), name, group, isFavorite, createdAt: Date.now() };
}

// ─── Quick Filters ────────────────────────────────────────────
// A small set of common, pre-built filter groups — the "Quick Filters"
// item from the approved plan. These are convenience STARTING POINTS
// (returned as plain FilterGroup objects a caller can apply directly
// or use as a template to customize further) — not a fixed, exhaustive
// list; more can be added later without touching the engine above.

export const QUICK_FILTERS: Array<{ label: string; build: () => FilterGroup }> = [
  {
    label: 'Winning trades',
    build: () => createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Green')]),
  },
  {
    label: 'Losing trades',
    build: () => createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Red')]),
  },
  {
    label: 'Futures only',
    build: () => createFilterGroup('AND', [createFilterCondition('_isFutures', 'equals', 'true')]),
  },
  {
    label: 'Forex only',
    build: () => createFilterGroup('AND', [createFilterCondition('_isFutures', 'equals', 'false')]),
  },
  {
    label: 'Plan not followed',
    build: () => createFilterGroup('AND', [createFilterCondition('planFollowed', 'equals', 'No')]),
  },
  {
    label: 'R >= 2',
    build: () => createFilterGroup('AND', [createFilterCondition('_r', 'gte', '2')]),
  },
];
