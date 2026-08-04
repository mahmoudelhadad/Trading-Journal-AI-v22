/**
 * calculations/visibleTrades.test.ts
 *
 * Phase 22 — tests for selectVisibleTrades(), the application's single
 * filtering rule.
 *
 * THE IDENTITY GUARANTEE (the phase's central claim): with
 * activeGroup === null, this function must return exactly what the
 * pre-phase useFilters.applyFilters returned. The expectations in the
 * first describe block are derived from the PRE-MOVE source snapshot
 * captured at Step 0(b), not from reading the post-move module — so the
 * test and the code under test have independent origins and the test is
 * not merely a restatement of the implementation.
 *
 * The pre-move predicate, verbatim from that snapshot:
 *
 *   if (accFilter === 'all' && mktFilter === 'all') return allTrades;
 *   return allTrades.filter((t) => {
 *     const passAcc = accFilter === 'all' || t.accountId === accFilter;
 *     const passMkt = mktFilter === 'all'
 *       || (mktFilter === 'futures' && t._isFutures)
 *       || (mktFilter === 'forex'   && !t._isFutures);
 *     return passAcc && passMkt;
 *   });
 *
 * Note the early return hands back the SAME array reference, not a
 * copy. That is preserved behavior and is asserted as such below.
 */
import { describe, expect, it } from 'vitest';
import { selectVisibleTrades } from './visibleTrades.js';
import { createFilterCondition, createFilterGroup } from './filterEngine.js';
import type { EnrichedTrade } from './tradeCalc.js';

function t(fields: Record<string, unknown>): EnrichedTrade {
  return fields as unknown as EnrichedTrade;
}

// Two accounts × two markets, so every account/market combination has a
// distinguishable expected result.
const a1fx  = t({ _tid: 1, accountId: 'acc_1', _isFutures: false, _outcome: 'Green', _r: 3 });
const a1fut = t({ _tid: 2, accountId: 'acc_1', _isFutures: true,  _outcome: 'Red',   _r: -1 });
const a2fx  = t({ _tid: 3, accountId: 'acc_2', _isFutures: false, _outcome: 'Green', _r: 1 });
const a2fut = t({ _tid: 4, accountId: 'acc_2', _isFutures: true,  _outcome: 'Green', _r: 2 });

const ALL = [a1fx, a1fut, a2fx, a2fut];

describe('identity guarantee — activeGroup === null reproduces the pre-phase behavior', () => {
  it("both 'all': returns the input array itself, exactly as the early return did", () => {
    const result = selectVisibleTrades(ALL, 'all', 'all', null);
    expect(result).toBe(ALL);
  });

  it('account only: keeps trades whose accountId matches', () => {
    expect(selectVisibleTrades(ALL, 'acc_1', 'all', null)).toEqual([a1fx, a1fut]);
    expect(selectVisibleTrades(ALL, 'acc_2', 'all', null)).toEqual([a2fx, a2fut]);
  });

  it("market only: 'futures' keeps _isFutures, 'forex' keeps !_isFutures", () => {
    expect(selectVisibleTrades(ALL, 'all', 'futures', null)).toEqual([a1fut, a2fut]);
    expect(selectVisibleTrades(ALL, 'all', 'forex',   null)).toEqual([a1fx, a2fx]);
  });

  it('both set: the two predicates are ANDed', () => {
    expect(selectVisibleTrades(ALL, 'acc_1', 'futures', null)).toEqual([a1fut]);
    expect(selectVisibleTrades(ALL, 'acc_2', 'forex',   null)).toEqual([a2fx]);
  });

  it('an account id matching nothing yields an empty array', () => {
    expect(selectVisibleTrades(ALL, 'acc_missing', 'all', null)).toEqual([]);
  });
});

describe('composition — account/market intersected with the active group', () => {
  const greensOnly = createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Green')]);

  it('applies the group on top of the account/market narrowing', () => {
    // acc_1 → [a1fx, a1fut]; then Green only → [a1fx]
    expect(selectVisibleTrades(ALL, 'acc_1', 'all', greensOnly)).toEqual([a1fx]);
  });

  it("applies the group even when both account and market are 'all'", () => {
    // The early return must NOT short-circuit past an active group.
    expect(selectVisibleTrades(ALL, 'all', 'all', greensOnly)).toEqual([a1fx, a2fx, a2fut]);
  });

  it('a group matching nothing yields an empty array', () => {
    const none = createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Purple')]);
    expect(selectVisibleTrades(ALL, 'all', 'all', none)).toEqual([]);
  });

  it('a group matching everything is a no-op on the narrowed set', () => {
    const everything = createFilterGroup('AND', []);
    expect(selectVisibleTrades(ALL, 'all', 'all', everything)).toEqual(ALL);
    expect(selectVisibleTrades(ALL, 'acc_1', 'all', everything)).toEqual([a1fx, a1fut]);
  });

  it('the fixed order produces the same set as applying the group first', () => {
    // account → market → group is a pure conjunction, so narrowing in
    // the reverse order must yield the same trades.
    const groupFirst = selectVisibleTrades(
      selectVisibleTrades(ALL, 'all', 'all', greensOnly), 'acc_2', 'all', null,
    );
    expect(selectVisibleTrades(ALL, 'acc_2', 'all', greensOnly)).toEqual(groupFirst);
  });
});

describe('purity', () => {
  it('never mutates its input', () => {
    const input = [...ALL];
    selectVisibleTrades(input, 'acc_1', 'futures', createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Red')]));
    expect(input).toEqual(ALL);
  });

  it('returns a new array on every filtering path', () => {
    // The sole exception is the preserved early return (both 'all' +
    // null group), which hands back the same reference — asserted in
    // the identity-guarantee block above.
    expect(selectVisibleTrades(ALL, 'acc_1', 'all', null)).not.toBe(ALL);
    expect(selectVisibleTrades(ALL, 'all', 'forex', null)).not.toBe(ALL);
    expect(selectVisibleTrades(ALL, 'all', 'all', createFilterGroup('AND', []))).not.toBe(ALL);
  });
});
