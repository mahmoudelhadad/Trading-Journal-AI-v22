import { describe, expect, it } from 'vitest';
import { mergeBarsInsertIfAbsent, revealClosedBars } from './replayReveal.js';
import type { HistoricalBar } from '@apptypes/marketData.js';

const bar = (t: number, h = 1): HistoricalBar => ({ t, o: 1, h, l: 1, c: 1, v: 1 });

describe('replay reveal chokepoint', () => {
  it('reveals exactly at close and never a partial minute', () => {
    expect(revealClosedBars([bar(0)], 59_999)).toEqual([]);
    expect(revealClosedBars([bar(0)], 60_000)).toEqual([bar(0)]);
  });
  it('keeps a future autoscale sentinel out of observable chart data', () => {
    expect(revealClosedBars([bar(0), bar(60_000, 1_000_000)], 60_000).map((b) => b.h)).toEqual([1]);
  });
  it('merges insert-if-absent idempotently without overwriting', () => {
    const target = new Map([[0, bar(0, 2)]]);
    mergeBarsInsertIfAbsent(target, [bar(0, 99), bar(60_000, 3), bar(60_000, 4)]);
    expect([...target.values()].map((b) => b.h)).toEqual([2, 3]);
  });
});
