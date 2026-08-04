/**
 * calculations/tradeCalc.test.ts
 *
 * Gap-analysis G-2 — establishes the project's first automated test
 * coverage, targeted at the layer Backtesting Foundation (L4) will
 * consume directly: the pure calculation functions in tradeCalc.ts.
 *
 * These are characterization tests: they encode the formulas already
 * documented in tradeCalc.ts's own comments and in MIGRATION_NOTES.md
 * ("copied VERBATIM from the original single-file app"), so a future
 * change that accidentally alters a formula — including one made while
 * building the backtesting engine — fails here instead of surfacing as
 * a silently wrong statistic.
 *
 * `enrichTrades` is tested with a plain object satisfying only
 * `RawTradeContent` (no `syncId`/`syncStatus`/etc.) — this is a direct
 * regression test for gap-analysis G-1/G-5: before that fix, this
 * exact input shape was structurally incompatible with `TradeLike`,
 * which is precisely why a hypothetical (backtest-simulated) trade
 * could not be typed correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  calcR,
  calcPL,
  calcRisk,
  calcPoints,
  calcOutcome,
  formatDur,
  enrichTrades,
} from './tradeCalc.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

describe('calcR', () => {
  it('computes a positive R for a winning long trade', () => {
    // entry 100, stop 90 (risk 10), exit 120 -> (120-100)/10 = 2R
    expect(calcR({ entryPrice: '100', stopLoss: '90', exitPrice: '120', direction: 'Long' })).toBe(2);
  });

  it('computes a negative R for a losing short trade', () => {
    // entry 100, stop 110 (risk 10), exit 105, short -> (100-105)/10 = -0.5R
    expect(calcR({ entryPrice: '100', stopLoss: '110', exitPrice: '105', direction: 'Short' })).toBe(-0.5);
  });

  it('returns null when required fields are missing', () => {
    expect(calcR({ entryPrice: '100', stopLoss: '', exitPrice: '120', direction: 'Long' })).toBeNull();
  });

  it('returns null when entry equals stop (zero risk distance)', () => {
    expect(calcR({ entryPrice: '100', stopLoss: '100', exitPrice: '120', direction: 'Long' })).toBeNull();
  });
});

describe('calcPL', () => {
  it('computes gross P/L for a winning long trade (US100: f=1, pv=1)', () => {
    // (120-100) * positionSize(2) * f(1) * pv(1) = 40
    expect(calcPL({ entryPrice: '100', exitPrice: '120', positionSize: '2', symbol: 'US100', direction: 'Long' })).toBe(40);
  });

  it('computes gross P/L for a losing short trade', () => {
    // short: (entry-exit) = (100-120) = -20 * size(1) = -20
    expect(calcPL({ entryPrice: '100', exitPrice: '120', positionSize: '1', symbol: 'US100', direction: 'Short' })).toBe(-20);
  });

  it('returns null when symbol is missing', () => {
    expect(calcPL({ entryPrice: '100', exitPrice: '120', positionSize: '1', symbol: '', direction: 'Long' })).toBeNull();
  });
});

describe('calcRisk', () => {
  it('computes risk value in dollars', () => {
    // |100-90| * 2 * f(1) * pv(1) = 20
    expect(calcRisk({ entryPrice: '100', stopLoss: '90', positionSize: '2', symbol: 'US100' })).toBe(20);
  });
});

describe('calcPoints', () => {
  it('computes rounded point/pip difference', () => {
    expect(calcPoints({ entryPrice: '100', exitPrice: '120.456', symbol: 'US100', direction: 'Long' })).toBe(20.46);
  });
});

describe('calcOutcome', () => {
  it('classifies Green above the +0.2 threshold', () => {
    expect(calcOutcome(0.21)).toBe('Green');
  });
  it('classifies Red below the -0.2 threshold', () => {
    expect(calcOutcome(-0.21)).toBe('Red');
  });
  it('classifies Breakeven inside the threshold band, inclusive of the boundary', () => {
    expect(calcOutcome(0.2)).toBe('Breakeven');
    expect(calcOutcome(-0.2)).toBe('Breakeven');
    expect(calcOutcome(0)).toBe('Breakeven');
  });
  it('returns empty string for a null R (no exit yet)', () => {
    expect(calcOutcome(null)).toBe('');
  });
});

describe('formatDur', () => {
  it('formats minutes as "Hh Mm"', () => {
    expect(formatDur(125)).toBe('2h 5m');
  });
  it('renders the em-dash placeholder for a null duration', () => {
    expect(formatDur(null)).toBe('—');
  });
});

describe('enrichTrades', () => {
  const accounts: Account[] = [{ id: 'acc_1', name: 'Main', capital: 10000 } as Account];

  it('accepts a plain RawTradeContent-shaped object with no sync identity', () => {
    // Regression test for gap-analysis G-1/G-5: this object has none of
    // SyncMetadata's fields (syncId, syncStatus, ...) — exactly the
    // shape a hypothetical/backtest trade will have, and exactly the
    // shape that failed to type-check against the pre-fix TradeLike.
    const trade: Omit<RawTradeContent, '_tid'> = {
      market: 'forex', symbol: 'US100', date: '2026-01-01', broker: '', account: '',
      accountId: 'acc_1', dailySetup: '', liquidity: '', entrySetup: '', intraDaySetup: '',
      intraDayTF: '', session: '', daySwing: '', linkToChart: '', positionSize: '1',
      direction: 'Long', entryTime: '09:00', exitTime: '10:00', entryPrice: '100',
      stopLoss: '90', target: '', exitPrice: '120', commission: '0', setupType: '',
      personalRating: '', planFollowed: '', emotions: '', beSL: '', afSL: '', sl1: '',
      sl2: '', sl3: '', tm1: '', tm2: '', tm3: '', tm4: '', tm5: '', tm6: '', error: '',
      notes: '',
    };

    const [enriched] = enrichTrades([trade], accounts);

    expect(enriched._r).toBe(2);
    expect(enriched._outcome).toBe('Green');
    expect(enriched._netPL).toBe(20); // (120-100)*1*1*1 - commission(0)
    expect(enriched._capital).toBe(10000); // starting capital, before this trade's P/L is applied
  });

  it('advances running capital per account across successive trades, in input order', () => {
    const base: Omit<RawTradeContent, '_tid'> = {
      market: 'forex', symbol: 'US100', date: '2026-01-01', broker: '', account: '',
      accountId: 'acc_1', dailySetup: '', liquidity: '', entrySetup: '', intraDaySetup: '',
      intraDayTF: '', session: '', daySwing: '', linkToChart: '', positionSize: '1',
      direction: 'Long', entryTime: '', exitTime: '', entryPrice: '100', stopLoss: '90',
      target: '', exitPrice: '120', commission: '0', setupType: '', personalRating: '',
      planFollowed: '', emotions: '', beSL: '', afSL: '', sl1: '', sl2: '', sl3: '',
      tm1: '', tm2: '', tm3: '', tm4: '', tm5: '', tm6: '', error: '', notes: '',
    };

    const [first, second] = enrichTrades([base, base], accounts);

    expect(first._capital).toBe(10000);
    expect(second._capital).toBe(10020); // 10000 + first trade's +20 net P/L
  });
});
