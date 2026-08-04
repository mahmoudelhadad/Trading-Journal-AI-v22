/**
 * calculations/streaks.test.ts
 *
 * Gap-analysis G-2 — characterization test for computeStreaks(), one
 * of the deterministic building blocks Backtesting Foundation (L4)
 * will reuse. Trades are built via `enrichTrades()` so `_outcome` is
 * computed the same way it will be for a simulated trade, not
 * hand-set.
 */
import { describe, expect, it } from 'vitest';
import { enrichTrades } from './tradeCalc.js';
import { computeStreaks } from './streaks.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

const accounts: Account[] = [{ id: 'acc_1', name: 'Main', capital: 1000 } as Account];

function trade(exitPrice: string): Omit<RawTradeContent, '_tid'> {
  return {
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
const WIN = trade('200');
const LOSS = trade('50');

describe('computeStreaks', () => {
  it('returns the documented empty baseline for no trades', () => {
    expect(computeStreaks([])).toEqual({ current: 0, type: '', maxWin: 0, maxLoss: 0 });
  });

  it('tracks the current streak in progress at the end of the sequence', () => {
    const enriched = enrichTrades([WIN, WIN, LOSS], accounts);
    const result = computeStreaks(enriched);
    expect(result.current).toBe(1);
    expect(result.type).toBe('L');
  });

  it('tracks the longest win and loss runs seen anywhere in the sequence', () => {
    const enriched = enrichTrades([WIN, WIN, WIN, LOSS, WIN, LOSS, LOSS], accounts);
    const result = computeStreaks(enriched);
    expect(result.maxWin).toBe(3);
    expect(result.maxLoss).toBe(2);
  });
});
