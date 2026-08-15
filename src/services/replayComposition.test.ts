import { describe, expect, it, vi } from 'vitest';
import { createReplayComposition, type ReplayComposition } from './replayComposition.js';
import type { IndexedDbHandle } from './indexedDb.js';

describe('replay composition', () => {
  it('constructs inertly in Node without browser globals or storage work', () => {
    const composition = createReplayComposition();
    expect(composition.runtime.getSnapshot().playState).toBe('paused');
  });

  it('rejects malformed source before opening IndexedDB or entering the runtime barrier', async () => {
    const composition = createReplayComposition();
    const before = composition.runtime.getSnapshot();
    const result = await composition.importNinjaTrader({ root: 'NQ', expiryText: '03-16', text: 'not;a;valid;row', fileName: 'bad.txt' });
    expect(result.ok).toBe(false);
    expect(composition.runtime.getSnapshot()).toBe(before);
  });

  it('runs real parse/checksum before barrier-protected injected commit and settles afterward', async () => {
    const order: string[] = [];
    const handle = {} as IndexedDbHandle;
    const compositionBox: { value?: ReplayComposition } = {};
    const openDb = vi.fn(async () => {
      expect(compositionBox.value!.runtime.getSnapshot().importing).toBe(true);
      order.push('open');
      return { kind: 'success' as const, value: handle };
    });
    const commit = vi.fn(async (_handle, input) => {
      expect(_handle).toBe(handle);
      expect(compositionBox.value!.runtime.getSnapshot().importing).toBe(true);
      expect(input.bars).toEqual([{ t: Date.parse('2016-03-01T05:00:00Z'), o: 4200, h: 4201, l: 4199, c: 4200.25, v: 12 }]);
      expect(input.sourceChecksumSha256).toMatch(/^[a-f0-9]{64}$/);
      order.push('commit');
      return { ok: true as const, summary: { seriesId: 'NQ|2016|03|1m', chunksWritten: 1, barsAdded: 1, idempotentDuplicates: 0, barCount: 1 } };
    });
    const composition = createReplayComposition({}, { openMarketDataDb: openDb, commitImport: commit });
    compositionBox.value = composition;
    const result = await composition.importNinjaTrader({
      root: 'NQ', expiryText: '03-16', fileName: 'nq.txt',
      text: '20160301 050100;4200;4201;4199;4200.25;12',
    });
    expect(result).toEqual({ ok: true, message: 'Imported 1 new bars (1 total).' });
    expect(order).toEqual(['open', 'commit']);
    expect(composition.runtime.getSnapshot().importing).toBe(false);
  });
});
