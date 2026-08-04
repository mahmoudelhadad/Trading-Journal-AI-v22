/**
 * calculations/drawdown.test.ts
 *
 * Gap-analysis G-2 — characterization tests for the drawdown engine,
 * one of the deterministic building blocks Backtesting Foundation (L4)
 * must reuse rather than reimplement (per the accepted architecture
 * blueprint's Analytics <- Backtesting dependency direction).
 *
 * Trades are built via `enrichTrades()` from plain RawTradeContent
 * objects (no sync identity) rather than hand-constructed
 * `EnrichedTrade` literals, so these tests exercise the real
 * L2-independent pipeline a simulated trade will actually go through.
 */
import { describe, expect, it } from 'vitest';
import { enrichTrades } from './tradeCalc.js';
import { buildEquitySequence, computeDrawdown } from './drawdown.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

const accounts: Account[] = [{ id: 'acc_1', name: 'Main', capital: 1000 } as Account];

function trade(exitPrice: string, positionSize = '1'): Omit<RawTradeContent, '_tid'> {
  return {
    market: 'forex', symbol: 'US100', date: '2026-01-01', broker: '', account: '',
    accountId: 'acc_1', dailySetup: '', liquidity: '', entrySetup: '', intraDaySetup: '',
    intraDayTF: '', session: '', daySwing: '', linkToChart: '', positionSize,
    direction: 'Long', entryTime: '', exitTime: '', entryPrice: '100', stopLoss: '90',
    target: '', exitPrice, commission: '0', setupType: '', personalRating: '',
    planFollowed: '', emotions: '', beSL: '', afSL: '', sl1: '', sl2: '', sl3: '',
    tm1: '', tm2: '', tm3: '', tm4: '', tm5: '', tm6: '', error: '', notes: '',
  };
}

describe('buildEquitySequence', () => {
  it('starts with a single point at the starting capital for an empty trade list', () => {
    expect(buildEquitySequence([], 1000)).toEqual([{ index: 0, equity: 1000 }]);
  });

  it('accumulates net P/L in input order', () => {
    // +100, then -50 -> equity 1000, 1100, 1050
    const enriched = enrichTrades([trade('200'), trade('50')], accounts);
    const seq = buildEquitySequence(enriched, 1000);
    expect(seq.map((p) => p.equity)).toEqual([1000, 1100, 1050]);
  });
});

describe('computeDrawdown', () => {
  it('reports zero drawdown for a monotonically rising equity curve', () => {
    const enriched = enrichTrades([trade('150'), trade('200')], accounts);
    const result = computeDrawdown(buildEquitySequence(enriched, 1000));
    expect(result.maxDrawdownDollar).toBe(0);
    expect(result.currentDrawdownDollar).toBe(0);
  });

  it('measures the peak-to-trough decline after a losing trade', () => {
    // 1000 -> 1100 (peak, +100 win) -> 1050 (-50 loss) -> drawdown = 50
    const enriched = enrichTrades([trade('200'), trade('50')], accounts);
    const result = computeDrawdown(buildEquitySequence(enriched, 1000));
    expect(result.maxDrawdownDollar).toBe(50);
    expect(result.maxDrawdownPercent).toBeCloseTo((50 / 1100) * 100, 5);
  });

  it('reports null recoveryTimeTrades when the account never recovers to the pre-drawdown peak', () => {
    const enriched = enrichTrades([trade('200'), trade('50')], accounts);
    const result = computeDrawdown(buildEquitySequence(enriched, 1000));
    expect(result.recoveryTimeTrades).toBeNull();
  });

  it('returns the documented empty-sequence baseline', () => {
    expect(computeDrawdown([])).toEqual({
      maxDrawdownDollar: 0,
      maxDrawdownPercent: 0,
      currentDrawdownDollar: 0,
      currentDrawdownPercent: 0,
      drawdownDurationTrades: 0,
      recoveryTimeTrades: null,
      rollingDrawdown: [],
    });
  });
});
