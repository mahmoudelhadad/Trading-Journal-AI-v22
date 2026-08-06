import { describe, expect, it, vi } from 'vitest';
import {
  MAX_STORED_BACKTEST_RESULTS,
  canAddBacktestResult,
  createBacktestResultWithinLimit,
} from './useBacktests.js';
import type { BacktestResult } from '@apptypes/backtest.js';

const result = (id: string): BacktestResult => ({ id } as BacktestResult);

describe('saved Backtest capacity', () => {
  it('allows 49 results and preserves the cap at 50', () => {
    expect(MAX_STORED_BACKTEST_RESULTS).toBe(50);
    expect(canAddBacktestResult(49)).toBe(true);
  });

  it('blocks 50, 51, and larger restored collections', () => {
    expect(canAddBacktestResult(50)).toBe(false);
    expect(canAddBacktestResult(51)).toBe(false);
    expect(canAddBacktestResult(75)).toBe(false);
  });

  it('does not compute a result when the limit is reached', () => {
    const compute = vi.fn(() => result('attempted'));
    expect(createBacktestResultWithinLimit(50, compute)).toEqual({
      success: false,
      reason: 'limit_reached',
    });
    expect(compute).not.toHaveBeenCalled();
  });

  it('computes exactly once below the limit', () => {
    const computed = result('created');
    const compute = vi.fn(() => computed);
    expect(createBacktestResultWithinLimit(49, compute)).toEqual({ success: true, result: computed });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('models deletion freeing capacity while rename leaves it unchanged', () => {
    const restored = Array.from({ length: 51 }, (_, i) => result(String(i)));
    const renamed = restored.map((item, i) => i === 0 ? { ...item, name: 'Renamed' } : item);
    expect(canAddBacktestResult(renamed.length)).toBe(false);
    expect(canAddBacktestResult(renamed.slice(0, 49).length)).toBe(true);
    expect(restored).toHaveLength(51);
  });
});
