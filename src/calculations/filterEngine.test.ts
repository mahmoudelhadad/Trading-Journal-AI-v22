/**
 * calculations/filterEngine.test.ts
 *
 * Phase 22 — characterization tests for the Advanced Filters engine
 * (calculations/filterEngine.ts, Phase 14). The engine had zero
 * coverage before this phase, which promotes it from "used by the
 * Backtest page only" to "runs on every page" via
 * calculations/visibleTrades.ts.
 *
 * These assert the IMPLEMENTED behavior. Where the module's own
 * ASSUMPTIONS header disagrees with the code, the code wins:
 *
 *   The header (filterEngine.ts, ASSUMPTIONS block) states that a field
 *   absent from the trade "stringifies to `"undefined"` for equals/
 *   notEquals/contains". It does not. filterEngine.ts:102 normalizes
 *   null/undefined to '' BEFORE any comparison, so an absent field
 *   compares as the empty string. The `NaN` half of that same header
 *   sentence IS accurate: numeric operators bail out via the isNaN
 *   guard at filterEngine.ts:117.
 *
 * The header is stale documentation. Correcting it is documentation
 * work and is out of scope for this phase — filterEngine.ts is not
 * modified here. These tests characterize what the code does, because
 * that is what every page is about to depend on.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCondition, evaluateGroup, applyFilterGroup,
  createFilterCondition, createFilterGroup,
} from './filterEngine.js';
import type { EnrichedTrade } from './tradeCalc.js';

// A minimal enriched-trade stand-in. The engine reads fields by bracket
// access and never depends on the full EnrichedTrade shape, so only the
// fields under test are populated.
function t(fields: Record<string, unknown>): EnrichedTrade {
  return fields as unknown as EnrichedTrade;
}

const green = t({ symbol: 'US100', _outcome: 'Green', _r: 2.5, planFollowed: 'Yes' });
const red   = t({ symbol: 'EURUSD', _outcome: 'Red',   _r: -1,  planFollowed: 'No'  });

describe('evaluateCondition — operators', () => {
  it('equals is an exact, case-SENSITIVE string comparison', () => {
    expect(evaluateCondition(green, createFilterCondition('symbol', 'equals', 'US100'))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('symbol', 'equals', 'us100'))).toBe(false);
  });

  it('notEquals is the exact negation of equals', () => {
    expect(evaluateCondition(green, createFilterCondition('symbol', 'notEquals', 'EURUSD'))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('symbol', 'notEquals', 'US100'))).toBe(false);
  });

  it('contains is case-INSENSITIVE — the documented exception to equals', () => {
    expect(evaluateCondition(green, createFilterCondition('symbol', 'contains', 'us1'))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('symbol', 'contains', 'US1'))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('symbol', 'contains', 'JPY'))).toBe(false);
  });

  it('gt / gte / lt / lte compare numerically, not lexically', () => {
    expect(evaluateCondition(green, createFilterCondition('_r', 'gt',  '2'))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('_r', 'gt',  '2.5'))).toBe(false);
    expect(evaluateCondition(green, createFilterCondition('_r', 'gte', '2.5'))).toBe(true);
    expect(evaluateCondition(red,   createFilterCondition('_r', 'lt',  '0'))).toBe(true);
    expect(evaluateCondition(red,   createFilterCondition('_r', 'lte', '-1'))).toBe(true);
    expect(evaluateCondition(red,   createFilterCondition('_r', 'lte', '-2'))).toBe(false);
  });
});

describe('evaluateCondition — absent fields (implementation, not the stale header)', () => {
  it("normalizes an absent field to '' before comparing, NOT to \"undefined\"", () => {
    // filterEngine.ts:102 — raw === undefined ? '' : String(raw)
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'equals', ''))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'equals', 'undefined'))).toBe(false);
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'equals', 'x'))).toBe(false);
  });

  it("notEquals and contains follow the same '' normalization", () => {
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'notEquals', ''))).toBe(false);
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'notEquals', 'x'))).toBe(true);
    // '' contains '' is true; '' contains anything else is false
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'contains', ''))).toBe(true);
    expect(evaluateCondition(green, createFilterCondition('noSuchField', 'contains', 'x'))).toBe(false);
  });

  it('numeric operators return false on an absent field via the NaN guard', () => {
    // filterEngine.ts:117 — isNaN(left) || isNaN(right) → false
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      expect(evaluateCondition(green, createFilterCondition('noSuchField', op, '1'))).toBe(false);
    }
  });

  it('numeric operators return false when the VALUE is non-numeric', () => {
    expect(evaluateCondition(green, createFilterCondition('_r', 'gt', 'abc'))).toBe(false);
  });
});

describe('evaluateGroup — AND / OR / empty', () => {
  const isGreen = createFilterCondition('_outcome', 'equals', 'Green');
  const bigR    = createFilterCondition('_r', 'gte', '2');

  it('AND requires every condition', () => {
    expect(evaluateGroup(green, createFilterGroup('AND', [isGreen, bigR]))).toBe(true);
    expect(evaluateGroup(red,   createFilterGroup('AND', [isGreen, bigR]))).toBe(false);
  });

  it('OR requires at least one condition', () => {
    expect(evaluateGroup(red, createFilterGroup('OR', [isGreen, createFilterCondition('_r', 'lt', '0')]))).toBe(true);
    expect(evaluateGroup(red, createFilterGroup('OR', [isGreen, bigR]))).toBe(false);
  });

  it('an empty conditions array matches everything, for BOTH logic modes', () => {
    // This is what makes a no-condition group a true "match all" — the
    // property Step 16(b)'s Backtest isolation measurement relies on.
    expect(evaluateGroup(green, createFilterGroup('AND', []))).toBe(true);
    expect(evaluateGroup(green, createFilterGroup('OR',  []))).toBe(true);
    expect(evaluateGroup(red,   createFilterGroup('AND', []))).toBe(true);
  });

  it('a default, untouched condition row matches everything', () => {
    // createFilterCondition() defaults to field:'', operator:'equals',
    // value:'' — absent field normalizes to '', which equals ''.
    const untouched = createFilterGroup('AND', [createFilterCondition()]);
    expect(evaluateGroup(green, untouched)).toBe(true);
    expect(evaluateGroup(red,   untouched)).toBe(true);
  });
});

describe('applyFilterGroup', () => {
  const trades = [green, red];

  it('returns only the matching trades', () => {
    const result = applyFilterGroup(trades, createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Green')]));
    expect(result).toEqual([green]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(applyFilterGroup(trades, createFilterGroup('AND', [createFilterCondition('symbol', 'equals', 'NOPE')]))).toEqual([]);
  });

  it('does not mutate its input and returns a new array', () => {
    const input = [green, red];
    const result = applyFilterGroup(input, createFilterGroup('AND', []));
    expect(input).toEqual([green, red]);
    expect(result).not.toBe(input);
  });
});
