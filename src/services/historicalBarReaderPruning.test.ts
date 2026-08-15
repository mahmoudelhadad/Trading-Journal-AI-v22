import { describe, expect, it, vi } from 'vitest';
import { createHistoricalBarReader, isCanonicalUtcDay, type HistoricalChunkSource } from './historicalBarReader.js';
import { chunkIdOf, seriesIdOf, type HistoricalBarChunk, type HistoricalSeriesRecord } from '@apptypes/marketData.js';

const SERIES = { root: 'NQ' as const, expiryYear: 2016, expiryMonth: 3, timeframe: '1m' as const };
const ID = seriesIdOf(SERIES);
const DAY1 = Date.parse('2016-03-01T00:00:00Z');
const DAY2 = Date.parse('2016-03-02T00:00:00Z');

function record(days: Record<string, number>): HistoricalSeriesRecord {
  return { seriesId: ID, series: SERIES, state: 'active', committed: { activeChunks: days, observedFirstUtcMs: DAY1, observedLastUtcMs: DAY2, barCount: 2 }, provenance: { imports: [] } };
}
function chunk(day: string, t: number): HistoricalBarChunk {
  return { chunkId: chunkIdOf(ID, day, 1), seriesId: ID, day, revision: 1, t: [t], o: [1], h: [1], l: [1], c: [1], v: [1] };
}

describe('HistoricalBarReader UTC-day range pruning', () => {
  it('validates canonical dates by real calendar round trip', () => {
    expect(isCanonicalUtcDay('2016-02-29')).toBe(true);
    expect(isCanonicalUtcDay('2016-02-30')).toBe(false);
    expect(isCanonicalUtcDay('2016-03-99')).toBe(false);
    expect(isCanonicalUtcDay('2016-3-01')).toBe(false);
  });
  it('uses to-1 at exact midnight and ignores missing out-of-range payload', async () => {
    const getChunk = vi.fn(async (id: string) => id.includes('2016-03-01') ? { ok: true as const, value: chunk('2016-03-01', DAY1) } : { ok: true as const, value: null });
    const source: HistoricalChunkSource = { getSeries: async () => ({ ok: true, value: record({ '2016-03-01': 1, '2016-03-02': 1 }) }), getChunk };
    const result = await createHistoricalBarReader(source).readBars({ series: SERIES, fromUtcMs: DAY1, toUtcMs: DAY2 });
    expect(result.ok).toBe(true); expect(getChunk).toHaveBeenCalledTimes(1);
  });
  it('fails closed for missing in-range payload', async () => {
    const source: HistoricalChunkSource = { getSeries: async () => ({ ok: true, value: record({ '2016-03-01': 1 }) }), getChunk: async () => ({ ok: true, value: null }) };
    expect(await createHistoricalBarReader(source).readBars({ series: SERIES, fromUtcMs: DAY1, toUtcMs: DAY2 })).toMatchObject({ ok: false, reason: 'read_failed' });
  });
  it('falls back to the legacy full-manifest scan for malformed days', async () => {
    const getChunk = vi.fn(async () => ({ ok: true as const, value: null }));
    const source: HistoricalChunkSource = { getSeries: async () => ({ ok: true, value: record({ '2016-03-99': 1 }) }), getChunk };
    await createHistoricalBarReader(source).readBars({ series: SERIES, fromUtcMs: DAY1, toUtcMs: DAY2 });
    expect(getChunk).toHaveBeenCalledWith(chunkIdOf(ID, '2016-03-99', 1));
  });
  it('falls back for unsafe numeric bounds', async () => {
    const getChunk = vi.fn(async () => ({ ok: true as const, value: chunk('2016-03-01', DAY1) }));
    const source: HistoricalChunkSource = { getSeries: async () => ({ ok: true, value: record({ '2016-03-01': 1 }) }), getChunk };
    await createHistoricalBarReader(source).readBars({ series: SERIES, fromUtcMs: 0.5, toUtcMs: DAY2 });
    expect(getChunk).toHaveBeenCalledTimes(1);
  });
  it('falls back without throwing when safe integers are outside the Date domain', async () => {
    const getChunk = vi.fn(async () => ({ ok: true as const, value: chunk('2016-03-01', DAY1) }));
    const source: HistoricalChunkSource = { getSeries: async () => ({ ok: true, value: record({ '2016-03-01': 1 }) }), getChunk };
    await expect(createHistoricalBarReader(source).readBars({ series: SERIES, fromUtcMs: Number.MAX_SAFE_INTEGER - 1, toUtcMs: Number.MAX_SAFE_INTEGER })).resolves.toBeDefined();
    expect(getChunk).toHaveBeenCalledTimes(1);
  });
  it('fails closed for an unreadable in-range payload', async () => {
    const source: HistoricalChunkSource = { getSeries: async () => ({ ok: true, value: record({ '2016-03-01': 1 }) }), getChunk: async () => ({ ok: false }) };
    expect(await createHistoricalBarReader(source).readBars({ series: SERIES, fromUtcMs: DAY1, toUtcMs: DAY2 })).toMatchObject({ ok: false, reason: 'read_failed' });
  });
});
