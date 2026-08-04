/**
 * calculations/backtest.test.ts
 *
 * Characterization tests for computeBacktestResult() (calculations/
 * backtest.ts). These assert COMPOSITION, not arithmetic — the
 * arithmetic itself is already characterized by tradeCalc.test.ts,
 * drawdown.test.ts, and streaks.test.ts. Each assertion here confirms
 * computeBacktestResult() wires filterGroup/trades/startingCapital
 * through to the same L3 functions a caller would invoke directly,
 * producing an identical result.
 *
 * id/createdAt are the only non-deterministic fields on BacktestResult
 * (nextId()'s counter, Date.now()) — tested for presence/type only.
 * Every other field is a pure function of the inputs and is tested for
 * exact equality against calling the underlying L3 function directly,
 * preserving the Determinism Boundary confirmed at Step 2.
 *
 * Trades here carry real numeric `_tid` values (unlike tradeCalc.
 * test.ts's hypothetical-trade case) — this phase's v1 backtests filter
 * real historical trades, which always carry a real `_tid`.
 */
import { describe, expect, it } from 'vitest';
import { enrichTrades } from './tradeCalc.js';
import { applyFilterGroup, createFilterCondition, createFilterGroup } from './filterEngine.js';
import { summarizeTrades } from './rolling.js';
import { buildEquitySequence, computeDrawdown } from './drawdown.js';
import { computeStreaks, getAverageStreaks, getLongestStreaks } from './streaks.js';
import { computeCoreAnalytics } from './analytics.js';
import { computeBacktestResult } from './backtest.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

const accounts: Account[] = [{ id: 'acc_1', name: 'Main', capital: 1000 } as Account];
const STARTING_CAPITAL = 1000;

function trade(tid: number, exitPrice: string): RawTradeContent {
  return {
    _tid: tid,
    market: 'forex', symbol: 'US100', date: '2026-01-01', broker: '', account: '',
    accountId: 'acc_1', dailySetup: '', liquidity: '', entrySetup: '', intraDaySetup: '',
    intraDayTF: '', session: '', daySwing: '', linkToChart: '', positionSize: '1',
    direction: 'Long', entryTime: '', exitTime: '', entryPrice: '100', stopLoss: '90',
    target: '', exitPrice, commission: '0', setupType: '', personalRating: '',
    planFollowed: '', emotions: '', beSL: '', afSL: '', sl1: '', sl2: '', sl3: '',
    tm1: '', tm2: '', tm3: '', tm4: '', tm5: '', tm6: '', error: '', notes: '',
  };
}

// exitPrice=200 -> R=10 -> Green (win); exitPrice=50 -> R=-5 -> Red (loss)
const trades = enrichTrades(
  [trade(1, '200'), trade(2, '200'), trade(3, '50'), trade(4, '200'), trade(5, '50')],
  accounts,
);

const greenOnly = createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Green')]);
const matchesNothing = createFilterGroup('AND', [createFilterCondition('_outcome', 'equals', 'Breakeven')]);

describe('computeBacktestResult', () => {
  it("matches applyFilterGroup's own output for matchedTradeIds/tradeCount", () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);
    const matched = applyFilterGroup(trades, greenOnly);

    expect(result.tradeCount).toBe(matched.length);
    expect(result.matchedTradeIds).toEqual(matched.map((t) => t._tid));
    expect(result.matchedTradeIds).toEqual([1, 2, 4]);
  });

  it('summary/drawdown/streaks/core match calling the underlying L3 functions directly on the same filtered set', () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);
    const matched = applyFilterGroup(trades, greenOnly);

    expect(result.summary).toEqual(summarizeTrades(matched));
    expect(result.drawdown).toEqual(computeDrawdown(buildEquitySequence(matched, STARTING_CAPITAL)));
    expect(result.streaks).toEqual(computeStreaks(matched));
    expect(result.averageStreaks).toEqual(getAverageStreaks(matched));
    expect(result.longestStreaks).toEqual(getLongestStreaks(matched));
    expect(result.core).toEqual(computeCoreAnalytics(matched));
  });

  it('produces the same documented empty baselines as the underlying L3 functions when the filter matches nothing', () => {
    const result = computeBacktestResult(matchesNothing, trades, STARTING_CAPITAL);

    expect(result.tradeCount).toBe(0);
    expect(result.matchedTradeIds).toEqual([]);
    expect(result.summary).toEqual(summarizeTrades([]));
    expect(result.drawdown).toEqual(computeDrawdown(buildEquitySequence([], STARTING_CAPITAL)));
    expect(result.streaks).toEqual({ current: 0, type: '', maxWin: 0, maxLoss: 0 });
    expect(result.averageStreaks).toEqual({ avgWinStreak: null, avgLossStreak: null });
    expect(result.longestStreaks).toEqual({ longestWinStreak: 0, longestLossStreak: 0 });
  });

  it('snapshots filterGroup and startingCapital exactly as given', () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);

    expect(result.filterGroup).toEqual(greenOnly);
    expect(result.startingCapital).toBe(STARTING_CAPITAL);
  });

  it('generates id and createdAt rather than requiring the caller to supply them', () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);

    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.createdAt).toBe('number');
  });

  it('defaults name to "Untitled Backtest" when omitted', () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);
    expect(result.name).toBe('Untitled Backtest');
  });

  it('uses the given name when provided', () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL, 'My Setup');
    expect(result.name).toBe('My Setup');
  });

  it('does not persist a full equity-curve array — regression guard for the resolved blocking item', () => {
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);
    expect(result).not.toHaveProperty('equitySequence');
  });
});
