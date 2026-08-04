/**
 * components/backtest/BacktestRunner.tsx
 *
 * Backtesting UI — strategy-definition surface.
 *
 * Composes the EXISTING <FilterPanel> (Phase 14) as the strategy
 * builder rather than reimplementing condition rows — the FilterGroup
 * it produces is exactly what computeBacktestResult() takes as its
 * strategy definition. FilterPanel is embedded with `hideSaveRow` so
 * its own "name this filter + 💾 Save" row is suppressed: this
 * component supplies the name field and the Run button, and rendering
 * both sets would give the user two name inputs and two submit buttons
 * with contradictory labels. `onSave` is required by FilterPanelProps
 * but meaningless here, so it receives a no-op — saving a filter is
 * the SettingsModal's concern, not this phase's.
 *
 * SEEDED GROUP: FilterPanel keeps its own group state and only emits
 * via onGroupChange when the user edits something. This component
 * therefore seeds an identical initial group with the same factories
 * FilterPanel itself uses, so a run performed before any edit is
 * valid rather than undefined.
 *
 * This component is presentational + local-state only: it does not
 * call useBacktests(), does not call computeBacktestResult(), does not
 * persist anything, and performs no analytics. Its only logic is the
 * two approved validations (non-empty name, starting capital > 0).
 * Running is entirely delegated upward through onRun.
 */

import React, { useState } from 'react';
import { COLORS as C } from '@constants/lists.js';
import { Card } from '@components/ui/Card.js';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { FilterPanel } from '@components/filters/FilterPanel.js';
import {
  createFilterCondition, createFilterGroup, type FilterGroup,
} from '@calculations/filterEngine.js';
import type { EnrichedTrade } from '@calculations/tradeCalc.js';
import type { Account } from '@hooks/useAccounts.js';

// ─── Types ───────────────────────────────────────────────────

export interface BacktestRunnerProps {
  /** UNFILTERED enriched trades — same set the run will execute against, so FilterPanel's live match count matches the result */
  allTrades: EnrichedTrade[];
  accounts:  Account[];
  onRun: (filterGroup: FilterGroup, startingCapital: number, name: string) => void;
}

// ─── Component ───────────────────────────────────────────────

export function BacktestRunner({ allTrades, accounts, onRun }: BacktestRunnerProps) {
  // Seeded to match FilterPanel's own initial state exactly — see file header.
  const [group, setGroup] = useState<FilterGroup>(
    () => createFilterGroup('AND', [createFilterCondition()]),
  );
  const [name, setName] = useState('');

  // Starting capital is held as a string because Input.onChange emits
  // strings. Defaulted to the sum of all account capitals — the same
  // 'all accounts' convention pages/Equity.tsx already uses — purely
  // as a prefilled starting value the user can overwrite.
  const [capitalText, setCapitalText] = useState(
    () => String(accounts.reduce((s, a) => s + a.capital, 0)),
  );

  // ── Inline validation — the only two rules in this phase ──
  const startingCapital = Number(capitalText);
  const nameValid       = name.trim().length > 0;
  const capitalValid    = Number.isFinite(startingCapital) && startingCapital > 0;
  const canRun          = nameValid && capitalValid;

  function handleRun() {
    if (!canRun) return;
    onRun(group, startingCapital, name.trim());
  }

  return (
    <Card>
      <div style={{ color: C.text, fontSize: 11, fontWeight: 700, marginBottom: 10 }}>
        🧪 Backtest Strategy
      </div>

      {/* Strategy definition — the existing Phase 14 builder, save row suppressed */}
      <FilterPanel
        trades={allTrades}
        onSave={() => { /* no-op — save row is hidden; see file header */ }}
        onGroupChange={setGroup}
        hideSaveRow
      />

      {/* Name + starting capital + run */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
        <div style={{ flex: 1 }}>
          <Input value={name} onChange={setName} placeholder="Name this backtest..." />
          {!nameValid && (
            <div style={{ color: C.dim, fontSize: 9, marginTop: 3 }}>Name is required</div>
          )}
        </div>

        <div style={{ width: 150 }}>
          <Input type="number" value={capitalText} onChange={setCapitalText} placeholder="Starting capital" />
          {!capitalValid && (
            <div style={{ color: C.red, fontSize: 9, marginTop: 3 }}>Must be greater than 0</div>
          )}
        </div>

        <Button variant="primary" size="sm" onClick={handleRun} disabled={!canRun}>
          ▶ Run Backtest
        </Button>
      </div>
    </Card>
  );
}
