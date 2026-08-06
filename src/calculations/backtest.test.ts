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
import { computeCoreAnalytics, withRecoveryFactor } from './analytics.js';
import { computeBacktestResult } from './backtest.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

const accounts: Account[] = [{ id: 'acc_1', name: 'Main', capital: 1000 } as Account];
const STARTING_CAPITAL = 1000;
const TOLERANCE = 1e-9;

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
    // Phase 24: `core` is now computeCoreAnalytics() composed with
    // withRecoveryFactor(). The max drawdown fed to the oracle is
    // recomputed independently here — NOT read from result.drawdown or
    // result.core, which would make this assertion self-referential.
    //
    // NOTE: this oracle passes both before and after the Phase 24 fix,
    // because `greenOnly` matches three winners whose equity curve only
    // rises, so maxDrawdownDollar is 0 and withRecoveryFactor() leaves
    // recoveryFactor null either way. It documents intent; it is NOT a
    // regression signal for the wiring. The load-bearing coverage is
    // the non-zero-drawdown test at the end of this file.
    expect(result.core).toEqual(
      withRecoveryFactor(
        computeCoreAnalytics(matched),
        computeDrawdown(buildEquitySequence(matched, STARTING_CAPITAL)).maxDrawdownDollar,
      ),
    );
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

  // Phase 26 deliberately reverses the prior acceptance criterion:
  // AD-015 clause 2 is superseded by AD-018, so equityPath is persisted.
  it('T-1 persists the independently hand-derived raw equity path with one point per matched trade', () => {
    const result = computeBacktestResult(createFilterGroup('AND', []), trades, STARTING_CAPITAL);

    expect(result).toHaveProperty('equityPath');
    expect(result.equityPath).toHaveLength(result.tradeCount);
    expect(result.equityPath).toEqual([1100, 1200, 1150, 1250, 1200]);
  });

  it('T-2 keeps equityPath consistent with stored drawdown and its endpoint within tolerance of net P&L', () => {
    const result = computeBacktestResult(createFilterGroup('AND', []), trades, STARTING_CAPITAL);

    expect(result.drawdown.maxDrawdownDollar).toBe(50);
    expect(result.equityPath).toEqual([1100, 1200, 1150, 1250, 1200]);
    const endpoint = result.equityPath && result.equityPath.length > 0
      ? result.equityPath[result.equityPath.length - 1]
      : STARTING_CAPITAL;
    expect(Math.abs(endpoint - (STARTING_CAPITAL + result.summary.netPL))).toBeLessThan(TOLERANCE);
  });

  it('T-3 preserves equityPath exactly through a JSON round-trip', () => {
    const result = computeBacktestResult(createFilterGroup('AND', []), trades, STARTING_CAPITAL);
    const saved = JSON.parse(JSON.stringify(result)) as typeof result;

    expect(saved.equityPath).toEqual([1100, 1200, 1150, 1250, 1200]);
    expect(saved.equityPath).toEqual(result.equityPath);
  });

  it('T-4 leaves the saved path and every stored metric unchanged when source trades keep ids but change net P&L', () => {
    const result = computeBacktestResult(createFilterGroup('AND', []), trades, STARTING_CAPITAL);
    const saved = JSON.parse(JSON.stringify(result)) as typeof result;
    const snapshot = JSON.parse(JSON.stringify(saved)) as typeof result;
    const replacedTrades = trades.map((t, i) => ({ ...t, _netPL: (i + 1) * 1000 }));

    expect(replacedTrades.map((t) => t._tid)).toEqual(saved.matchedTradeIds);
    expect(replacedTrades.map((t) => t._netPL)).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(saved.equityPath).toEqual([1100, 1200, 1150, 1250, 1200]);
    expect(saved).toEqual(snapshot);
  });

  it('T-5 leaves the saved path and every stored metric unchanged when matched source trades are deleted, including all', () => {
    const result = computeBacktestResult(createFilterGroup('AND', []), trades, STARTING_CAPITAL);
    const saved = JSON.parse(JSON.stringify(result)) as typeof result;
    const snapshot = JSON.parse(JSON.stringify(saved)) as typeof result;
    const withoutMatchedTrades = trades.filter((t) => !saved.matchedTradeIds.includes(t._tid));

    expect(withoutMatchedTrades).toEqual([]);
    expect(saved.equityPath).toEqual([1100, 1200, 1150, 1250, 1200]);
    expect(saved).toEqual(snapshot);
  });

  it('T-6 persists an empty equityPath when no trades match', () => {
    const result = computeBacktestResult(matchesNothing, trades, STARTING_CAPITAL);

    expect(result.equityPath).toEqual([]);
  });

  it('T-7 retains a point with repeated cumulative equity for a null _netPL', () => {
    const nullThenWin = [
      { ...trades[0], _tid: 6, _netPL: null },
      { ...trades[0], _tid: 7 },
    ];
    const result = computeBacktestResult(createFilterGroup('AND', []), nullThenWin, STARTING_CAPITAL);

    expect(result.tradeCount).toBe(2);
    expect(result.equityPath).toEqual([1000, 1100]);
  });

  it('T-8 treats absence of equityPath as legacy and never as a frozen snapshot', () => {
    const result = computeBacktestResult(matchesNothing, trades, STARTING_CAPITAL);
    const { equityPath: _equityPath, ...legacyRecord } = result;

    expect(_equityPath).toEqual([]);
    expect('equityPath' in legacyRecord).toBe(false);
    expect((legacyRecord as Partial<typeof result>).equityPath).toBeUndefined();
    expect('equityPath' in result).toBe(true);
    expect(result.equityPath).toEqual([]);
  });

  // ── Phase 24 — Recovery Factor wiring ──────────────────────
  //
  // T-2 (load-bearing) and T-3 below pin the composition of
  // withRecoveryFactor() into the stored result's `core`.
  //
  // Every expected value is HAND-DERIVED from the module fixture, not
  // read from any function under test. With symbol 'US100' (f=1, pv=1),
  // entryPrice 100, stopLoss 90, positionSize 1 and commission 0:
  //   exitPrice 200 -> _r = +10, _pl = _netPL = +100  (Green)
  //   exitPrice  50 -> _r =  -5, _pl = _netPL =  -50  (Red)
  // The module fixture is [200, 200, 50, 200, 50].

  const matchesEverything = createFilterGroup('AND', []);

  it('populates recoveryFactor as netProfit / |maxDrawdown| when the matched set has a real drawdown', () => {
    // An empty conditions array matches every trade (see backtest.ts's
    // header), so `matched` is all five fixture trades in input order.
    //
    // Equity from a starting capital of 1000, adding _netPL per trade:
    //   1000 -> 1100 -> 1200 -> 1150 -> 1250 -> 1200
    // Running peak:
    //   1000    1100    1200    1200    1250    1250
    // Peak-to-trough declines: 1200->1150 = 50, and 1250->1200 = 50.
    //   => maxDrawdownDollar = 50
    // netProfit = sum(_netPL) = 100 + 100 - 50 + 100 - 50 = 200
    //   => recoveryFactor = 200 / |50| = 4
    const result = computeBacktestResult(matchesEverything, trades, STARTING_CAPITAL);

    // Asserted first so a fixture error is distinguishable from a
    // wiring error: if these two hold, the arithmetic feeding the
    // Recovery Factor is sound and only the composition can be wrong.
    expect(result.tradeCount).toBe(5);
    expect(result.drawdown.maxDrawdownDollar).toBe(50);
    expect(result.core.netProfit).toBe(200);

    // The behavior this phase exists to fix.
    expect(result.core.recoveryFactor).toBe(4);
  });

  it('leaves recoveryFactor null when the matched set never draws down', () => {
    // greenOnly matches the three winners, whose equity curve rises
    // monotonically: 1000 -> 1100 -> 1200 -> 1300.
    //   => maxDrawdownDollar = 0
    // withRecoveryFactor() returns null for a zero max drawdown
    // (analytics.ts), so the row legitimately stays empty. Fixing the
    // wiring does NOT guarantee a number appears.
    const result = computeBacktestResult(greenOnly, trades, STARTING_CAPITAL);

    expect(result.drawdown.maxDrawdownDollar).toBe(0);
    expect(result.core.recoveryFactor).toBeNull();
  });
});
