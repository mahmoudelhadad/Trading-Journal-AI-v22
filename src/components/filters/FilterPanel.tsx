/**
 * components/filters/FilterPanel.tsx
 *
 * Phase 14 — Advanced Filters: AND/OR filter-group builder panel.
 *
 * NEW component — no original-app equivalent. Lets the user add/remove
 * condition rows, toggle AND/OR logic, preview the resulting match
 * count, save the group as a named filter, and apply Quick Filters as
 * a starting point. Reuses Card, Button, Input UI atoms (Phase 3) —
 * no new visual language introduced.
 *
 * NOT wired into any existing page in this phase — see
 * calculations/filterEngine.ts's file header for the scope rationale.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { FilterConditionRow } from './FilterConditionRow.js';
import {
  createFilterCondition, createFilterGroup, applyFilterGroup, QUICK_FILTERS,
  type FilterGroup, type FilterLogic, type FilterCondition,
} from '@calculations/filterEngine.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface FilterPanelProps {
  trades:   EnrichedTrade[];
  onSave:   (name: string, group: FilterGroup) => void;
  /** Optional: called whenever the built group changes, so a parent COULD preview live matches — not required, purely opt-in */
  onGroupChange?: (group: FilterGroup) => void;
  /**
   * Optional: hides the trailing "name this filter + 💾 Save" row.
   * Defaults to false, so every existing consumer is unaffected.
   * Gates rendering ONLY — onSave, onGroupChange, the group state and
   * the match-count preview all behave identically either way. Added
   * for the Backtesting UI phase, where the embedding component
   * supplies its own name field and run button and would otherwise
   * render a second, contradictory one.
   */
  hideSaveRow?: boolean;
}

// ─── Component ───────────────────────────────────────────────

export function FilterPanel({ trades, onSave, onGroupChange, hideSaveRow = false }: FilterPanelProps) {
  const [group, setGroup] = useState<FilterGroup>(() => createFilterGroup('AND', [createFilterCondition()]));
  const [filterName, setFilterName] = useState('');

  function update(updated: FilterGroup) {
    setGroup(updated);
    onGroupChange?.(updated);
  }

  function addCondition() {
    update({ ...group, conditions: [...group.conditions, createFilterCondition()] });
  }
  function updateCondition(index: number, cond: FilterCondition) {
    const conditions = group.conditions.slice();
    conditions[index] = cond;
    update({ ...group, conditions });
  }
  function removeCondition(index: number) {
    update({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });
  }
  function setLogic(logic: FilterLogic) {
    update({ ...group, logic });
  }
  function applyQuickFilter(build: () => FilterGroup) {
    update(build());
  }

  const matchCount = applyFilterGroup(trades, group).length;

  function handleSave() {
    if (!filterName.trim()) return;
    onSave(filterName.trim(), group);
    setFilterName('');
  }

  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>🔍 Advanced Filter Builder</div>

      {/* Quick Filters */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {QUICK_FILTERS.map((qf) => (
          <button
            key={qf.label}
            onClick={() => applyQuickFilter(qf.build)}
            style={{ background: C.row, border: `1px solid ${C.border}`, color: C.dim, borderRadius: 6, padding: '4px 10px', fontSize: 10, cursor: 'pointer' }}
          >
            {qf.label}
          </button>
        ))}
      </div>

      {/* AND/OR toggle */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <span style={{ color: C.dim, fontSize: 10 }}>Match</span>
        {(['AND', 'OR'] as const).map((l) => (
          <button
            key={l}
            onClick={() => setLogic(l)}
            style={{
              background: group.logic === l ? `${C.blue}22` : 'none',
              color: group.logic === l ? C.blue : C.dim,
              border: `1px solid ${group.logic === l ? C.blue : C.border}`,
              borderRadius: 5, padding: '3px 12px', fontSize: 10, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {l === 'AND' ? 'ALL conditions (AND)' : 'ANY condition (OR)'}
          </button>
        ))}
      </div>

      {/* Condition rows */}
      {group.conditions.map((cond, i) => (
        <FilterConditionRow
          key={cond.id}
          condition={cond}
          onChange={(updated) => updateCondition(i, updated)}
          onRemove={() => removeCondition(i)}
        />
      ))}

      <Button variant="secondary" size="sm" onClick={addCondition} style={{ marginBottom: 12 }}>+ Add Condition</Button>

      {/* Match count preview */}
      <div style={{ color: C.dim, fontSize: 11, marginBottom: 10 }}>
        {`Matches ${matchCount} of ${trades.length} trades`}
      </div>

      {/* Save as named filter */}
      {!hideSaveRow && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Input value={filterName} onChange={setFilterName} placeholder="Name this filter to save it..." />
          <Button variant="primary" size="sm" onClick={handleSave} disabled={!filterName.trim()}>💾 Save</Button>
        </div>
      )}
    </Card>
  );
}
