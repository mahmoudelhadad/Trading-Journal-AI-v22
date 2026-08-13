/**
 * services/historicalBarReader.test.ts
 *
 * B1 — characterization tests for the Replay-facing boundary.
 *
 * The single most important property proven here is NEGATIVE: the
 * request carries no provider, no file, and no storage concept. If a
 * provider identifier ever reappears in this contract, Replay would
 * have to know where its data came from, and the future shared
 * historical service could no longer be a drop-in.
 *
 * SYNTHETIC DATA ONLY.
 */

import { describe, expect, it } from 'vitest';
import { createHistoricalBarReader, type HistoricalChunkSource } from './historicalBarReader.js';
import {
  seriesIdOf,
  chunkIdOf,
  utcDayOf,
  type HistoricalBar,
  type HistoricalBarChunk,
  type HistoricalSeriesIdentity,
  type HistoricalSeriesRecord,
} from '@apptypes/marketData.js';

const MAR01_0500 = 1_456_808_400_000; // 2016-03-01T05:00:00Z
const MAR02_0500 = MAR01_0500 + 86_400_000;
const MINUTE = 60_000;

const NQ_SERIES: HistoricalSeriesIdentity = {
  root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m',
};
const NQ_ID = seriesIdOf(NQ_SERIES);

function bar(t: number, close = 4197): HistoricalBar {
  return { t, o: close, h: close, l: close, c: close, v: 1 };
}

function chunk(day: string, revision: number, bars: HistoricalBar[]): HistoricalBarChunk {
  return {
    chunkId: chunkIdOf(NQ_ID, day, revision),
    seriesId: NQ_ID,
    day,
    revision,
    t: bars.map((b) => b.t),
    o: bars.map((b) => b.o),
    h: bars.map((b) => b.h),
    l: bars.map((b) => b.l),
    c: bars.map((b) => b.c),
    v: bars.map((b) => b.v),
  };
}

function record(
  activeChunks: Record<string, number>,
  state: 'active' | 'deleting' = 'active',
  first = MAR01_0500,
  last = MAR02_0500,
  barCount = 4,
): HistoricalSeriesRecord {
  return {
    seriesId: NQ_ID,
    series: NQ_SERIES,
    state,
    committed: { activeChunks, observedFirstUtcMs: first, observedLastUtcMs: last, barCount },
    provenance: { imports: [] },
  };
}

interface FakeSourceOptions {
  series?: HistoricalSeriesRecord | null;
  chunks?: HistoricalBarChunk[];
  /** Series record returned on the SECOND getSeries call — models a concurrent delete. */
  seriesOnRecheck?: HistoricalSeriesRecord | null;
  /** Operational failure on the FIRST getSeries call. */
  failFirstSeriesRead?: boolean;
  /** Operational failure on the SECOND getSeries call — the mandatory re-check. */
  failSeriesRecheck?: boolean;
  /** Operational failure on every getChunk call. */
  failChunkRead?: boolean;
}

function fakeSource(options: FakeSourceOptions): HistoricalChunkSource & { seriesReads: number } {
  const byId = new Map(options.chunks?.map((c) => [c.chunkId, c]) ?? []);
  let seriesReads = 0;
  const source = {
    get seriesReads() { return seriesReads; },
    async getSeries() {
      seriesReads += 1;
      if (seriesReads === 1 && options.failFirstSeriesRead) return { ok: false as const };
      if (seriesReads > 1 && options.failSeriesRecheck) return { ok: false as const };
      if (seriesReads > 1 && options.seriesOnRecheck !== undefined) {
        return { ok: true as const, value: options.seriesOnRecheck };
      }
      return { ok: true as const, value: options.series ?? null };
    },
    async getChunk(chunkId: string) {
      if (options.failChunkRead) return { ok: false as const };
      return { ok: true as const, value: byId.get(chunkId) ?? null };
    },
  };
  return source as HistoricalChunkSource & { seriesReads: number };
}

// ─── Provider-neutral boundary ────────────────────────────────

describe('Replay-facing boundary is provider-neutral', () => {
  it('accepts a request whose identity has exactly four provider-free fields', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500)])],
    }));

    const request = { series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR01_0500 + MINUTE };
    expect(Object.keys(request.series).sort()).toEqual(
      ['expiryMonth', 'expiryYear', 'root', 'timeframe'],
    );
    expect(Object.keys(request).sort()).toEqual(['fromUtcMs', 'series', 'toUtcMs']);
    expect(JSON.stringify(request)).not.toMatch(/ninjatrader|provider|source|file|indexeddb/i);

    const result = await reader.readBars(request);
    expect(result.ok).toBe(true);
  });

  it('exposes only readBars and getLocalAvailability — no locking or storage concepts', () => {
    const reader = createHistoricalBarReader(fakeSource({ series: null }));
    expect(Object.keys(reader).sort()).toEqual(['getLocalAvailability', 'readBars']);
  });
});

// ─── Range reads ──────────────────────────────────────────────

describe('readBars', () => {
  const source = () => fakeSource({
    series: record({ '2016-03-01': 1, '2016-03-02': 2 }),
    chunks: [
      chunk('2016-03-01', 1, [bar(MAR01_0500), bar(MAR01_0500 + MINUTE)]),
      chunk('2016-03-02', 2, [bar(MAR02_0500), bar(MAR02_0500 + MINUTE)]),
    ],
  });

  it('stitches multiple chunks into one strictly ascending series', async () => {
    const reader = createHistoricalBarReader(source());
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500 + 2 * MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars.map((b) => b.t)).toEqual([
      MAR01_0500, MAR01_0500 + MINUTE, MAR02_0500, MAR02_0500 + MINUTE,
    ]);
    for (let i = 1; i < result.bars.length; i++) {
      expect(result.bars[i].t).toBeGreaterThan(result.bars[i - 1].t);
    }
    expect(result.returnedFirstUtcMs).toBe(MAR01_0500);
    expect(result.returnedLastUtcMs).toBe(MAR02_0500 + MINUTE);
  });

  it('applies a half-open [from, to) range', async () => {
    const reader = createHistoricalBarReader(source());
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500 + MINUTE, toUtcMs: MAR02_0500 + MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars.map((b) => b.t)).toEqual([MAR01_0500 + MINUTE, MAR02_0500]);
  });

  it('returns an empty success for an inverted or empty range', async () => {
    const reader = createHistoricalBarReader(source());
    for (const [from, to] of [[MAR01_0500, MAR01_0500], [MAR02_0500, MAR01_0500]]) {
      const result = await reader.readBars({ series: NQ_SERIES, fromUtcMs: from, toUtcMs: to });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bars).toEqual([]);
      expect(result.returnedFirstUtcMs).toBeNull();
    }
  });

  it('treats a legitimately empty window as success, not failure', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500), bar(MAR01_0500 + 3 * MINUTE)])],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500 + MINUTE, toUtcMs: MAR01_0500 + 3 * MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toEqual([]);
  });

  it('preserves gaps — absent minutes stay absent', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500), bar(MAR01_0500 + 3 * MINUTE)])],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR01_0500 + 10 * MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars.map((b) => b.t)).toEqual([MAR01_0500, MAR01_0500 + 3 * MINUTE]);
  });

  it('reads ONLY the revision the manifest references', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 2 }),
      chunks: [
        chunk('2016-03-01', 1, [bar(MAR01_0500, 1111)]),
        chunk('2016-03-01', 2, [bar(MAR01_0500, 2222)]),
        chunk('2016-03-01', 3, [bar(MAR01_0500, 3333)]),
      ],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR01_0500 + MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars[0].c).toBe(2222);
  });

  it('cannot reach a speculative chunk that the manifest does not reference', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [
        chunk('2016-03-01', 1, [bar(MAR01_0500, 1111)]),
        // r2 written by an import that failed before its manifest commit
        chunk('2016-03-01', 2, [bar(MAR01_0500, 2222), bar(MAR01_0500 + MINUTE, 2222)]),
      ],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR01_0500 + 10 * MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toHaveLength(1);
    expect(result.bars[0].c).toBe(1111);
  });
});

// ─── Visibility gating ────────────────────────────────────────

describe('visibility gating', () => {
  it('reports an absent series as unavailable', async () => {
    const reader = createHistoricalBarReader(fakeSource({ series: null }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_unavailable');
  });

  it('hides a series that is being deleted, even though its map survives', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }, 'deleting'),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500)])],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_unavailable');
  });
});

// ─── Missing referenced chunk ─────────────────────────────────

describe('missing referenced chunk', () => {
  it('is an integrity failure while the series is still active', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('read_failed');
  });

  it('re-checks once and reports unavailability when the series was deleted mid-read', async () => {
    const source = fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [],
      seriesOnRecheck: null,
    });
    const reader = createHistoricalBarReader(source);
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_unavailable');
    expect(source.seriesReads).toBe(2);
  });

  it('re-checks once and reports unavailability when the series is now deleting', async () => {
    const source = fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [],
      seriesOnRecheck: record({ '2016-03-01': 1 }, 'deleting'),
    });
    const reader = createHistoricalBarReader(source);
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_unavailable');
  });

  it('never silently skips a missing referenced chunk', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1, '2016-03-02': 1 }),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500)])],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500 + MINUTE,
    });
    expect(result.ok).toBe(false);
  });
});

// ─── Large reads ──────────────────────────────────────────────

describe('large reads do not depend on argument-count limits', () => {
  it('returns a single oversized chunk without throwing', async () => {
    // Deliberately larger than any UTC day of 1-minute data could hold.
    // The reader must not rely on that invariant to stay safe, because
    // sub-minute timeframes would invalidate it.
    const many = Array.from({ length: 150_000 }, (_, i) => bar(MAR01_0500 + i * MINUTE, 4000 + (i % 8) * 0.25));
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [chunk('2016-03-01', 1, many)],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR01_0500 + 150_000 * MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toHaveLength(150_000);
    expect(result.bars[0].t).toBe(MAR01_0500);
    expect(result.bars[result.bars.length - 1].t).toBe(MAR01_0500 + 149_999 * MINUTE);
  });

  it('stitches many chunks preserving order, half-open bounds and exact values', async () => {
    const DAY = 86_400_000;
    const perDay = 1_200;
    const days = 120;
    const chunks = [];
    const activeChunks: Record<string, number> = {};
    for (let d = 0; d < days; d++) {
      const dayStart = MAR01_0500 + d * DAY;
      const dayKey = utcDayOf(dayStart);
      activeChunks[dayKey] = 1;
      chunks.push(chunk(dayKey, 1,
        Array.from({ length: perDay }, (_, i) => bar(dayStart + i * MINUTE, 4000 + ((d + i) % 8) * 0.25))));
    }
    const reader = createHistoricalBarReader(fakeSource({
      series: record(activeChunks, 'active', MAR01_0500, MAR01_0500 + (days - 1) * DAY, days * perDay),
      chunks,
    }));

    // Half-open: excludes the very last bar of the final day.
    const to = MAR01_0500 + (days - 1) * DAY + (perDay - 1) * MINUTE;
    const result = await reader.readBars({ series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: to });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toHaveLength(days * perDay - 1);
    for (let i = 1; i < result.bars.length; i++) {
      expect(result.bars[i].t).toBeGreaterThan(result.bars[i - 1].t);
    }
    expect(result.bars.every((b) => b.t >= MAR01_0500 && b.t < to)).toBe(true);
    // Exact values preserved, not merely counts.
    expect(result.bars[0]).toEqual({ t: MAR01_0500, o: 4000, h: 4000, l: 4000, c: 4000, v: 1 });
    expect(result.returnedFirstUtcMs).toBe(MAR01_0500);
  });
});

// ─── Storage failure is not absence ───────────────────────────

describe('operational read failure is never reported as absence', () => {
  it('reports read_failed when the series manifest itself cannot be read', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      failFirstSeriesRead: true,
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Absence was never established, so it must NOT claim series_unavailable.
    expect(result.reason).toBe('read_failed');
  });

  it('reports read_failed when a committed chunk cannot be read', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500)])],
      failChunkRead: true,
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('read_failed');
  });

  it('reports read_failed when the mandatory re-check cannot prove absence', async () => {
    const source = fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [],                 // referenced chunk missing
      failSeriesRecheck: true,    // and the re-read fails
    });
    const reader = createHistoricalBarReader(source);
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A failed re-read proves nothing; reporting series_unavailable here
    // would assert absence that was never established.
    expect(result.reason).toBe('read_failed');
    expect(source.seriesReads).toBe(2);
  });

  it('still reports series_unavailable when absence IS established', async () => {
    const source = fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [],
      seriesOnRecheck: null,
    });
    const reader = createHistoricalBarReader(source);
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR02_0500,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_unavailable');
  });
});

// ─── Observed availability ────────────────────────────────────

describe('getLocalAvailability', () => {
  it('reports OBSERVED availability, never guaranteed completeness', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-02': 2, '2016-03-01': 1 }),
    }));
    const availability = await reader.getLocalAvailability(NQ_SERIES);
    expect(availability.available).toBe(true);
    if (!availability.available) return;
    expect(availability.observedDays).toEqual(['2016-03-01', '2016-03-02']);
    expect(availability.observedFirstUtcMs).toBe(MAR01_0500);
    expect(availability.observedLastUtcMs).toBe(MAR02_0500);
    // No field may assert coverage/completeness of any kind.
    expect(Object.keys(availability).sort()).toEqual(
      ['available', 'observedDays', 'observedFirstUtcMs', 'observedLastUtcMs'],
    );
    expect(availability).not.toHaveProperty('complete');
    expect(availability).not.toHaveProperty('coverage');
  });

  it('is unavailable for an absent series', async () => {
    const reader = createHistoricalBarReader(fakeSource({ series: null }));
    expect(await reader.getLocalAvailability(NQ_SERIES)).toEqual({ available: false });
  });

  it('is unavailable for a deleting series and leaks no observed values', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }, 'deleting'),
    }));
    const availability = await reader.getLocalAvailability(NQ_SERIES);
    expect(availability).toEqual({ available: false });
    expect(availability).not.toHaveProperty('observedFirstUtcMs');
    expect(availability).not.toHaveProperty('observedDays');
  });
});

// ─── Independent grids ────────────────────────────────────────

describe('independent instrument grids', () => {
  it('returns only what a series actually holds — no cross-series alignment', async () => {
    const reader = createHistoricalBarReader(fakeSource({
      series: record({ '2016-03-01': 1 }),
      chunks: [chunk('2016-03-01', 1, [bar(MAR01_0500), bar(MAR01_0500 + 2 * MINUTE)])],
    }));
    const result = await reader.readBars({
      series: NQ_SERIES, fromUtcMs: MAR01_0500, toUtcMs: MAR01_0500 + 3 * MINUTE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A neighbouring instrument may have a bar at +1m; this one does not,
    // and no alignment candle is fabricated to make the grids match.
    expect(result.bars).toHaveLength(2);
  });
});
