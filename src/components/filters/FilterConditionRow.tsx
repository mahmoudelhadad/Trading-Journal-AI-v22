/**
 * components/filters/FilterConditionRow.tsx
 *
 * Phase 14 — Advanced Filters: one editable condition row
 * (field / operator / value), used inside FilterPanel.
 *
 * NEW component — no original-app equivalent. Reuses the existing
 * Select and Input UI atoms (Phase 3) rather than building new form
 * controls — no new form-input styling introduced.
 */

import React from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Select } from '@components/ui/Select.js';
import { Input } from '@components/ui/Input.js';
import type { FilterCondition, FilterOperator } from '@calculations/filterEngine.js';

// ─── Field options — curated, matches Strategy page's precedent ──
// (see pages/Strategy.tsx's FILTERABLE_FIELDS for the categorical-field
// list this mirrors) plus a few numeric EnrichedTrade fields.

const CATEGORICAL_FIELDS = [
  'symbol', 'direction', 'entrySetup', 'dailySetup', 'intraDaySetup', 'session',
  'daySwing', 'setupType', 'broker', 'account', 'liquidity', 'planFollowed',
  'emotions', 'personalRating', '_outcome', 'market',
];
const NUMERIC_FIELDS = ['_r', '_pl', '_netPL', '_pts', '_rPct'];

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  equals: 'is',
  notEquals: 'is not',
  contains: 'contains',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

function operatorsForField(field: string): FilterOperator[] {
  return NUMERIC_FIELDS.includes(field)
    ? ['equals', 'notEquals', 'gt', 'gte', 'lt', 'lte']
    : ['equals', 'notEquals', 'contains'];
}

// ─── Types ───────────────────────────────────────────────────

export interface FilterConditionRowProps {
  condition: FilterCondition;
  onChange:  (updated: FilterCondition) => void;
  onRemove:  () => void;
}

// ─── Component ───────────────────────────────────────────────

export function FilterConditionRow({ condition, onChange, onRemove }: FilterConditionRowProps) {
  const allFields = [...CATEGORICAL_FIELDS, ...NUMERIC_FIELDS];
  const availableOps = operatorsForField(condition.field);

  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
      <Select
        value={condition.field}
        onChange={(field) => onChange({ ...condition, field, operator: operatorsForField(field)[0] })}
        options={allFields}
        placeholder="Field..."
        width="150px"
      />
      <select
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value as FilterOperator })}
        style={{ width: 90, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 8px', fontSize: 11 }}
      >
        {availableOps.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>)}
      </select>
      <Input value={condition.value} onChange={(value) => onChange({ ...condition, value })} placeholder="Value..." width="140px" />
      <button
        onClick={onRemove}
        style={{ background: 'none', border: 'none', color: C.red, fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: '0 4px' }}
        title="Remove condition"
      >
        ×
      </button>
    </div>
  );
}
