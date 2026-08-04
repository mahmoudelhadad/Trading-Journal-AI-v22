/**
 * calculations/tradeReview.ts
 *
 * Phase 15 — Trade Review: types and pure helpers for Checklists and
 * Custom Fields.
 *
 * NEW module — no original-app equivalent for Checklists or Custom
 * Fields specifically. Per the original migration plan's TRADE REVIEW
 * section: *"Rating, psychology, checklist, custom fields."* Rating
 * (`personalRating`) and psychology (`emotions`) ALREADY exist as
 * RawTrade fields, captured by TradeForm.tsx since Phase 5 — the
 * original app never had a separate "Trade Review" page or component;
 * this data was always part of the single trade-entry form. This
 * phase adds ONLY the two genuinely missing capabilities: Checklists
 * and Custom Fields.
 *
 * DATA MODEL DECISION (documented, intentional — per your "keep
 * backward compatibility" and "do not redesign existing UI" rules):
 * Checklist completions and custom field values are stored SEPARATELY
 * from RawTrade, keyed by trade `_tid`, rather than adding new fields
 * to the RawTrade interface. This means:
 *   - The RawTrade schema is completely unchanged — zero risk to
 *     existing trade data of any kind.
 *   - TradeForm.tsx (Phase 5) is not modified — no new fields appear
 *     on the existing Add/Edit Trade form.
 *   - The capability exists as new, opt-in architecture, exactly
 *     mirroring the Phase 14 Advanced Filters precedent: built and
 *     validated, not wired into any existing page's UI this phase.
 */

import { nextId } from './idGenerator.js';

// ─── Types: Checklist ────────────────────────────────────────

export interface ChecklistItem {
  id:   string;
  text: string;
}

export interface ChecklistTemplate {
  id:    string;
  name:  string;
  items: ChecklistItem[];
}

/** Per-trade completion state: which item IDs are checked for one trade */
export type ChecklistCompletion = Record<string, boolean>;

/** All completions, keyed by trade _tid, then by checklist item id */
export type ChecklistCompletions = Record<number, ChecklistCompletion>;

// ─── Types: Custom Fields ────────────────────────────────────

export type CustomFieldType = 'text' | 'number' | 'boolean';

export interface CustomFieldDef {
  id:   string;
  name: string;
  type: CustomFieldType;
}

/** Per-trade custom field values: fieldId -> raw string value */
export type CustomFieldValueSet = Record<string, string>;

/** All custom field values, keyed by trade _tid, then by field id */
export type CustomFieldValues = Record<number, CustomFieldValueSet>;

// ─── ID generation ────────────────────────────────────────────
// nextId() is imported from idGenerator.js — this is the second call
// site (filterEngine.ts, Phase 14, was the first). Consolidated into
// a shared module during this same phase's self-review — see
// idGenerator.ts's header for the full rationale.

export function createChecklistItem(text = ''): ChecklistItem {
  return { id: nextId('item'), text };
}

export function createChecklistTemplate(name = 'Untitled Checklist', items: ChecklistItem[] = []): ChecklistTemplate {
  return { id: nextId('checklist'), name, items };
}

export function createCustomFieldDef(name = '', type: CustomFieldType = 'text'): CustomFieldDef {
  return { id: nextId('field'), name, type };
}

// ─── Pure helpers ────────────────────────────────────────────

/**
 * Compute checklist completion percentage for one trade.
 * FORMULA: (number of checked items present in `completion`) / template.items.length * 100
 * EDGE CASES: Returns 0 for a template with no items (not NaN/division-by-zero).
 */
export function getCompletionPercent(template: ChecklistTemplate, completion: ChecklistCompletion | undefined): number {
  if (template.items.length === 0) return 0;
  const checkedCount = template.items.filter((item) => completion?.[item.id]).length;
  return Math.round((checkedCount / template.items.length) * 100);
}

/**
 * Validate a raw string value against a custom field's declared type.
 * FORMULA: 'number' -> value is empty OR parses via Number() without NaN.
 *          'boolean' -> value is empty, 'true', or 'false' (string form,
 *          since values are stored as strings for consistency with the
 *          rest of the app's string-based form fields, e.g. RawTrade).
 *          'text' -> always valid (any string is valid text).
 * EDGE CASES: An empty string is always considered valid regardless of
 *          type — an unset field is not an invalid field.
 */
export function isValidCustomFieldValue(type: CustomFieldType, value: string): boolean {
  if (value === '') return true;
  if (type === 'number') return !isNaN(Number(value));
  if (type === 'boolean') return value === 'true' || value === 'false';
  return true; // 'text'
}
