/**
 * services/marketDataIngestion.test.ts
 *
 * B1 — characterization tests for the PURE ingestion planner: UTC-day
 * chunking, immutable revision allocation, union/conflict detection,
 * committed-manifest construction, and the deletion tombstone plan.
 *
 * Everything here is pure. No IndexedDB, no browser, no I/O — which is
 * exactly why the decision logic can be proven in the Node-only test
 * harness while the real host behaviour is proven at Runtime Acceptance.
 *
 * SYNTHETIC DATA ONLY.
 */

import { describe, expect, it } from 'vitest';
import {
  groupBarsByUtcDay,
  affectedUtcDays,
  buildImportPlan,
  buildDeletePlan,
  type ImportProvenanceInput,
} from './marketDataIngestion.js';
import {
  seriesIdOf,
  chunkIdOf,
  utcDayOf,
  isHistoricalRoot,
  HISTORICAL_ROOTS,
  type HistoricalBar,
  type HistoricalBarChunk,
  type HistoricalSeriesIdentity,
  type HistoricalSeriesRecord,
} from '@apptypes/marketData.js';
// Imported by the TEST only, as evidence for the independence assertions
// below. No production market-data module imports this.
import { PIP_TABLE, isFutures, isSupportedSymbol } from '@constants/pipValues.js';

// 2016-03-01T05:00:00Z — derived independently: 16861 days * 86_400_000
// = 1_456_790_400_000 (midnight) + 5h.
const MAR01_0500 = 1_456_808_400_000;
const MAR02_0500 = MAR01_0500 + 86_400_000;
const MINUTE = 60_000;

const NQ_SERIES: HistoricalSeriesIdentity = {
  root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m',
};
const NQ_ID = seriesIdOf(NQ_SERIES);

const ES_SERIES: HistoricalSeriesIdentity = {
  root: 'ES', expiryYear: 2016, expiryMonth: 3, timeframe: '1m',
};

function bar(t: number, close = 4197): HistoricalBar {
  return { t, o: close, h: close, l: close, c: close, v: 1 };
}

const PROVENANCE: ImportProvenanceInput = {
  source:                    'ninjatrader',
  importedAt:                1_700_000_000_000,
  sourceChecksumSha256:      'a'.repeat(64),
  sourceRowCount:            0,
  warnings:                  { offTick: 0, outOfOrder: 0, inFileDuplicates: 0 },
  dataType:                  'Last',
  sourceTimeZone:            'UTC',
  sourceTimestampConvention: 'end-of-bar',
};

function chunkOf(day: string, revision: number, bars: HistoricalBar[]): HistoricalBarChunk {
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

function plan(input: {
  bars: HistoricalBar[];
  existingRecord?: HistoricalSeriesRecord | null;
  existingChunks?: Map<string, HistoricalBarChunk | null>;
}) {
  return buildImportPlan({
    series:         NQ_SERIES,
    seriesId:       NQ_ID,
    bars:           input.bars,
    existingRecord: input.existingRecord ?? null,
    existingChunks: input.existingChunks ?? new Map(),
    provenance:     { ...PROVENANCE, sourceRowCount: input.bars.length },
  });
}

// ─── Keys and identity ────────────────────────────────────────

describe('canonical keys', () => {
  it('builds a provider-neutral series id with a zero-padded month', () => {
    expect(NQ_ID).toBe('NQ|2016|03|1m');
    expect(seriesIdOf({ ...NQ_SERIES, expiryMonth: 12 })).toBe('NQ|2016|12|1m');
    expect(seriesIdOf(ES_SERIES)).toBe('ES|2016|03|1m');
  });

  it('never leaks a provider token into a key', () => {
    expect(NQ_ID).not.toMatch(/ninjatrader/i);
    expect(chunkIdOf(NQ_ID, '2016-03-01', 1)).not.toMatch(/ninjatrader/i);
  });

  it('keeps the expiry unambiguous — no MM-YY survives into identity', () => {
    expect(NQ_ID).not.toContain('03-16');
    expect(NQ_ID).toContain('2016');
  });

  it('builds a revision-bearing chunk id', () => {
    expect(chunkIdOf(NQ_ID, '2016-03-01', 2)).toBe('NQ|2016|03|1m|2016-03-01|r2');
  });

  it('derives the UTC day of an instant', () => {
    expect(utcDayOf(MAR01_0500)).toBe('2016-03-01');
    expect(utcDayOf(1_456_790_400_000)).toBe('2016-03-01');
    expect(utcDayOf(1_456_790_400_000 - 1)).toBe('2016-02-29');
  });
});

// ─── Day grouping ─────────────────────────────────────────────

describe('UTC-day chunk boundary', () => {
  it('groups bars into UTC calendar days', () => {
    const grouped = groupBarsByUtcDay([bar(MAR01_0500), bar(MAR01_0500 + MINUTE), bar(MAR02_0500)]);
    expect([...grouped.keys()].sort()).toEqual(['2016-03-01', '2016-03-02']);
    expect(grouped.get('2016-03-01')).toHaveLength(2);
    expect(grouped.get('2016-03-02')).toHaveLength(1);
  });

  it('places a 23:59 bar in its own UTC day, not the next one', () => {
    const lastMinute = 1_456_790_400_000 + 86_400_000 - MINUTE; // 2016-03-01T23:59:00Z
    expect(utcDayOf(lastMinute)).toBe('2016-03-01');
    const grouped = groupBarsByUtcDay([bar(lastMinute), bar(lastMinute + MINUTE)]);
    expect([...grouped.keys()].sort()).toEqual(['2016-03-01', '2016-03-02']);
  });

  it('reports affected days in ascending order', () => {
    expect(affectedUtcDays([bar(MAR02_0500), bar(MAR01_0500)])).toEqual(['2016-03-01', '2016-03-02']);
  });
});

// ─── First import ─────────────────────────────────────────────

describe('first import', () => {
  it('writes r1 chunks for every day and builds an active manifest', () => {
    const result = plan({ bars: [bar(MAR01_0500), bar(MAR01_0500 + MINUTE), bar(MAR02_0500)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.plan.chunksToWrite.map((c) => c.chunkId)).toEqual([
      chunkIdOf(NQ_ID, '2016-03-01', 1),
      chunkIdOf(NQ_ID, '2016-03-02', 1),
    ]);
    expect(result.plan.nextRecord.state).toBe('active');
    expect(result.plan.nextRecord.committed.activeChunks).toEqual({
      '2016-03-01': 1, '2016-03-02': 1,
    });
    expect(result.plan.nextRecord.committed.barCount).toBe(3);
    expect(result.plan.nextRecord.committed.observedFirstUtcMs).toBe(MAR01_0500);
    expect(result.plan.nextRecord.committed.observedLastUtcMs).toBe(MAR02_0500);
  });

  it('stores column arrays of equal length in ascending t order', () => {
    const result = plan({ bars: [bar(MAR01_0500 + MINUTE, 10), bar(MAR01_0500, 20)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chunk = result.plan.chunksToWrite[0];
    expect(chunk.t).toEqual([MAR01_0500, MAR01_0500 + MINUTE]);
    expect(chunk.c).toEqual([20, 10]);
    expect(chunk.o).toHaveLength(chunk.t.length);
    expect(chunk.v).toHaveLength(chunk.t.length);
  });

  it('records provenance without a universal absence count', () => {
    const result = plan({ bars: [bar(MAR01_0500)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.plan.nextRecord.provenance.imports[0];
    expect(entry.source).toBe('ninjatrader');
    expect(entry.acceptedBarCount).toBe(1);
    expect(entry.normalizedConvention).toBe('start-of-bar');
    expect(entry.sourceTimestampConvention).toBe('end-of-bar');
    expect(entry).not.toHaveProperty('missingBarCount');
    expect(entry).not.toHaveProperty('absenceCount');
    expect(entry).not.toHaveProperty('plausibility');
    expect(entry.warnings).not.toHaveProperty('plausibility');
  });

  it('preserves gaps — a chunk holds exactly the observed bars', () => {
    const result = plan({ bars: [bar(MAR01_0500), bar(MAR01_0500 + 3 * MINUTE)] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chunksToWrite[0].t).toEqual([MAR01_0500, MAR01_0500 + 3 * MINUTE]);
    expect(result.plan.nextRecord.committed.barCount).toBe(2);
  });
});

// ─── Updates ──────────────────────────────────────────────────

describe('update of an already-committed series', () => {
  const existingRecord: HistoricalSeriesRecord = {
    seriesId: NQ_ID,
    series:   NQ_SERIES,
    state:    'active',
    committed: {
      activeChunks:       { '2016-03-01': 1 },
      observedFirstUtcMs: MAR01_0500,
      observedLastUtcMs:  MAR01_0500 + MINUTE,
      barCount:           2,
    },
    provenance: { imports: [] },
  };
  const existingChunk = chunkOf('2016-03-01', 1, [bar(MAR01_0500), bar(MAR01_0500 + MINUTE)]);

  it('adds a new day at r1 and leaves committed days untouched', () => {
    const result = plan({
      bars: [bar(MAR02_0500)],
      existingRecord,
      existingChunks: new Map([['2016-03-02', null]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chunksToWrite.map((c) => c.chunkId)).toEqual([
      chunkIdOf(NQ_ID, '2016-03-02', 1),
    ]);
    expect(result.plan.nextRecord.committed.activeChunks).toEqual({
      '2016-03-01': 1, '2016-03-02': 1,
    });
    expect(result.plan.nextRecord.committed.barCount).toBe(3);
  });

  it('allocates activeRevision + 1 when a committed day gains bars', () => {
    const result = plan({
      bars: [bar(MAR01_0500 + 2 * MINUTE)],
      existingRecord,
      existingChunks: new Map([['2016-03-01', existingChunk]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chunksToWrite).toHaveLength(1);
    expect(result.plan.chunksToWrite[0].revision).toBe(2);
    expect(result.plan.chunksToWrite[0].chunkId).toBe(chunkIdOf(NQ_ID, '2016-03-01', 2));
    expect(result.plan.chunksToWrite[0].t).toEqual([
      MAR01_0500, MAR01_0500 + MINUTE, MAR01_0500 + 2 * MINUTE,
    ]);
    expect(result.plan.nextRecord.committed.activeChunks['2016-03-01']).toBe(2);
    expect(result.plan.nextRecord.committed.barCount).toBe(3);
  });

  it('never targets the id of a currently committed chunk', () => {
    const result = plan({
      bars: [bar(MAR01_0500 + 2 * MINUTE)],
      existingRecord,
      existingChunks: new Map([['2016-03-01', existingChunk]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chunksToWrite.map((c) => c.chunkId)).not.toContain(existingChunk.chunkId);
  });

  it('is idempotent for an identical re-import — no chunk written, committed unchanged', () => {
    const result = plan({
      bars: [bar(MAR01_0500), bar(MAR01_0500 + MINUTE)],
      existingRecord,
      existingChunks: new Map([['2016-03-01', existingChunk]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.chunksToWrite).toHaveLength(0);
    expect(result.plan.idempotentDuplicates).toBe(2);
    expect(result.plan.nextRecord.committed).toEqual(existingRecord.committed);
    expect(result.plan.nextRecord.provenance.imports).toHaveLength(1);
  });

  it('rejects the whole import when an overlapping bar differs', () => {
    const result = plan({
      bars: [{ ...bar(MAR01_0500), c: 9999 }],
      existingRecord,
      existingChunks: new Map([['2016-03-01', existingChunk]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
  });

  it('refuses to import into a series that is being deleted', () => {
    const result = plan({
      bars: [bar(MAR02_0500)],
      existingRecord: { ...existingRecord, state: 'deleting' },
      existingChunks: new Map([['2016-03-02', null]]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_deleting');
  });

  it('appends provenance rather than replacing it', () => {
    const withHistory: HistoricalSeriesRecord = {
      ...existingRecord,
      provenance: {
        imports: [{
          ...PROVENANCE,
          acceptedBarCount: 2,
          idempotentDuplicates: 0,
          observedFirstUtcMs: MAR01_0500,
          observedLastUtcMs: MAR01_0500 + MINUTE,
          normalizedConvention: 'start-of-bar',
          normalizationVersion: 1,
        }],
      },
    };
    const result = plan({
      bars: [bar(MAR02_0500)],
      existingRecord: withHistory,
      existingChunks: new Map([['2016-03-02', null]]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextRecord.provenance.imports).toHaveLength(2);
  });
});

// ─── Empty imports ────────────────────────────────────────────

describe('an import carrying zero accepted bars is rejected unconditionally', () => {
  const existing: HistoricalSeriesRecord = {
    seriesId: NQ_ID,
    series:   NQ_SERIES,
    state:    'active',
    committed: {
      activeChunks:       { '2016-03-01': 2 },
      observedFirstUtcMs: MAR01_0500,
      observedLastUtcMs:  MAR01_0500 + MINUTE,
      barCount:           2,
    },
    provenance: { imports: [] },
  };

  it('creates no zero-bar series when none exists', () => {
    const result = plan({ bars: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_import');
  });

  it('leaves an existing series entirely unchanged', () => {
    const before = JSON.stringify(existing);
    const result = plan({ bars: [], existingRecord: existing });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_import');
    // No manifest, revision, or provenance mutation may be planned.
    expect(JSON.stringify(existing)).toBe(before);
  });

  it('is rejected even for a series that is being deleted', () => {
    const result = plan({ bars: [], existingRecord: { ...existing, state: 'deleting' } });
    expect(result.ok).toBe(false);
  });

  it('never produces an active manifest with epoch-zero observed bounds', () => {
    const result = plan({ bars: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_import');
    expect(typeof result.message).toBe('string');
    expect(result).not.toHaveProperty('plan');
  });
});

// ─── Large imports ────────────────────────────────────────────

describe('very large imports', () => {
  it('plans 150,000 bars without throwing, preserving exact first/last', () => {
    const bars = Array.from({ length: 150_000 }, (_, i) => bar(MAR01_0500 + i * MINUTE));
    const result = plan({ bars });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextRecord.committed.barCount).toBe(150_000);
    expect(result.plan.nextRecord.committed.observedFirstUtcMs).toBe(MAR01_0500);
    expect(result.plan.nextRecord.committed.observedLastUtcMs).toBe(MAR01_0500 + 149_999 * MINUTE);
  });

  it('extends an existing series from a large import with correct merged bounds', () => {
    const earlier = MAR01_0500 - 10 * MINUTE;
    const existingRecord: HistoricalSeriesRecord = {
      seriesId: NQ_ID,
      series:   NQ_SERIES,
      state:    'active',
      committed: {
        activeChunks:       { [utcDayOf(earlier)]: 1 },
        observedFirstUtcMs: earlier,
        observedLastUtcMs:  earlier,
        barCount:           1,
      },
      provenance: { imports: [] },
    };
    const bars = Array.from({ length: 150_000 }, (_, i) => bar(MAR01_0500 + i * MINUTE));
    const result = plan({ bars, existingRecord });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Earlier existing bound wins the min; the large import wins the max.
    expect(result.plan.nextRecord.committed.observedFirstUtcMs).toBe(earlier);
    expect(result.plan.nextRecord.committed.observedLastUtcMs).toBe(MAR01_0500 + 149_999 * MINUTE);
    expect(result.plan.nextRecord.committed.barCount).toBe(150_001);
  });

  it('computes identical bounds to a spread-free reference for an unsorted large input', () => {
    const bars = Array.from({ length: 150_000 }, (_, i) => bar(MAR01_0500 + ((i * 7919) % 150_000) * MINUTE));
    let expectedMin = Infinity, expectedMax = -Infinity;
    for (const b of bars) { if (b.t < expectedMin) expectedMin = b.t; if (b.t > expectedMax) expectedMax = b.t; }
    const result = plan({ bars });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.nextRecord.committed.observedFirstUtcMs).toBe(expectedMin);
    expect(result.plan.nextRecord.committed.observedLastUtcMs).toBe(expectedMax);
  });
});

// ─── Independent instrument grids ─────────────────────────────

describe('independent NQ / ES grids', () => {
  it('plans each series from its own bars, with no alignment or borrowing', () => {
    const nq = buildImportPlan({
      series: NQ_SERIES, seriesId: NQ_ID,
      bars: [bar(MAR01_0500), bar(MAR01_0500 + 2 * MINUTE)],
      existingRecord: null, existingChunks: new Map(),
      provenance: { ...PROVENANCE, sourceRowCount: 2 },
    });
    const esId = seriesIdOf(ES_SERIES);
    const es = buildImportPlan({
      series: ES_SERIES, seriesId: esId,
      bars: [bar(MAR01_0500), bar(MAR01_0500 + MINUTE), bar(MAR01_0500 + 2 * MINUTE)],
      existingRecord: null, existingChunks: new Map(),
      provenance: { ...PROVENANCE, sourceRowCount: 3 },
    });

    expect(nq.ok && es.ok).toBe(true);
    if (!nq.ok || !es.ok) return;
    expect(nq.plan.chunksToWrite[0].t).toHaveLength(2);
    expect(es.plan.chunksToWrite[0].t).toHaveLength(3);
    expect(nq.plan.chunksToWrite[0].seriesId).not.toBe(es.plan.chunksToWrite[0].seriesId);
  });
});

// ─── Deletion plan ────────────────────────────────────────────

describe('deletion plan', () => {
  const active: HistoricalSeriesRecord = {
    seriesId: NQ_ID,
    series:   NQ_SERIES,
    state:    'active',
    committed: {
      activeChunks:       { '2016-03-01': 3, '2016-03-02': 1 },
      observedFirstUtcMs: MAR01_0500,
      observedLastUtcMs:  MAR02_0500,
      barCount:           10,
    },
    provenance: { imports: [] },
  };

  it('tombstones the record while PRESERVING the cleanup map', () => {
    const { tombstone } = buildDeletePlan(active);
    expect(tombstone.state).toBe('deleting');
    expect(tombstone.committed.activeChunks).toEqual({ '2016-03-01': 3, '2016-03-02': 1 });
    expect(tombstone.committed.barCount).toBe(10);
  });

  it('enumerates r1 through r(active + 1) for every committed day', () => {
    const { chunkIdsToDelete } = buildDeletePlan(active);
    expect(chunkIdsToDelete).toEqual([
      chunkIdOf(NQ_ID, '2016-03-01', 1),
      chunkIdOf(NQ_ID, '2016-03-01', 2),
      chunkIdOf(NQ_ID, '2016-03-01', 3),
      chunkIdOf(NQ_ID, '2016-03-01', 4),
      chunkIdOf(NQ_ID, '2016-03-02', 1),
      chunkIdOf(NQ_ID, '2016-03-02', 2),
    ]);
  });

  it('resumes from a persisted deleting record with an identical cleanup set', () => {
    const interrupted: HistoricalSeriesRecord = { ...active, state: 'deleting' };
    expect(buildDeletePlan(interrupted).chunkIdsToDelete)
      .toEqual(buildDeletePlan(active).chunkIdsToDelete);
    expect(buildDeletePlan(interrupted).tombstone.committed.activeChunks)
      .toEqual(active.committed.activeChunks);
  });
});

// ─── Domain independence ──────────────────────────────────────

/**
 * The property under test is BEHAVIOURAL: the market-data domain's root
 * authority is its own HISTORICAL_ROOTS list, not the Journal's
 * PIP_TABLE. Proving that by behaviour is stronger than a source-text
 * scan — a scan can be satisfied by a module that reimplements the
 * coupling under another name, whereas these assertions cannot.
 *
 * pipValues is imported HERE, in the test, purely as evidence that the
 * roots being rejected really are present in the Journal table.
 */
describe('market-data domain independence', () => {
  it('rejects roots that PIP_TABLE supports but the market-data domain does not', () => {
    // Present in PIP_TABLE, absent from the market-data domain.
    for (const root of ['MNQ', 'MES', 'YM', 'GC', 'CL']) {
      expect(isHistoricalRoot(root), `${root} must not be a historical root`).toBe(false);
      expect(isSupportedSymbol(root), `${root} is expected to exist in PIP_TABLE`).toBe(true);
    }
  });

  it('declares its own root authority, not a projection of PIP_TABLE', () => {
    expect([...HISTORICAL_ROOTS]).toEqual(['NQ', 'ES']);
    const pipFutures = Object.keys(PIP_TABLE).filter((s) => isFutures(s));
    expect(pipFutures.length).toBeGreaterThan(HISTORICAL_ROOTS.length);
    expect(HISTORICAL_ROOTS.length).toBe(2);
  });

  it('keeps the canonical identity free of Journal instrument notation', () => {
    // The Journal stores 'NQ 09-26'-style sourceInstrument strings; the
    // market-data domain must not adopt that ambiguous form as identity.
    expect(NQ_ID).not.toMatch(/\s/);
    expect(NQ_ID).not.toMatch(/\d{2}-\d{2}/);
  });
});
