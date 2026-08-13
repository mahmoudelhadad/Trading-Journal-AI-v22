/**
 * services/marketDataIngestion.ts
 *
 * B1 — the PURE ingestion planner.
 *
 * All decision logic that determines what gets written lives here:
 * UTC-day chunking, immutable revision allocation, union/conflict
 * detection, committed-manifest construction, provenance assembly, and
 * the deletion cleanup set. No IndexedDB, no locks, no I/O — which is
 * what lets the storage semantics be proven in a Node-only harness
 * while services/marketDataStore.ts stays a thin, host-dependent shell.
 *
 * ATOMIC VISIBILITY (the property this file exists to serve):
 * a new version of a UTC day is NEVER planned at the id of the
 * currently committed chunk. It is planned at `activeRevision + 1`, so
 * all writes are additive and invisible until one single-record
 * manifest `put` swaps them in. A failure at any point before that put
 * leaves the previously committed state exactly as it was.
 *
 * The reader resolves the manifest first and never derives a chunk id,
 * so an uncommitted chunk is unreachable by construction rather than by
 * convention.
 */

import {
  chunkIdOf,
  utcDayOf,
  NORMALIZATION_VERSION,
  type HistoricalBar,
  type HistoricalBarChunk,
  type HistoricalSeriesIdentity,
  type HistoricalSeriesRecord,
  type ImportProvenanceEntry,
  type ImportWarningCounts,
} from '@apptypes/marketData.js';

/** The source-side provenance the caller knows; derived fields are filled in here. */
export interface ImportProvenanceInput {
  source:                    'ninjatrader';
  importedAt:                number;
  sourceChecksumSha256:      string;
  sourceRowCount:            number;
  warnings:                  ImportWarningCounts;
  dataType:                  'Last';
  sourceTimeZone:            'UTC';
  sourceTimestampConvention: 'end-of-bar';
}

export interface ImportCommitPlan {
  /** Immutable chunks to write BEFORE the manifest. Only changed days appear. */
  chunksToWrite: HistoricalBarChunk[];
  /** The single record whose `put` is the sole visibility-changing operation. */
  nextRecord:    HistoricalSeriesRecord;
  idempotentDuplicates: number;
  barsAdded:     number;
}

export type BuildImportPlanResult =
  | { ok: true; plan: ImportCommitPlan }
  | { ok: false; reason: 'conflict' | 'series_deleting' | 'empty_import'; message: string };

export interface BuildImportPlanInput {
  series:         HistoricalSeriesIdentity;
  seriesId:       string;
  bars:           readonly HistoricalBar[];
  existingRecord: HistoricalSeriesRecord | null;
  /** UTC day → the currently committed chunk for that day, or null when there is none. */
  existingChunks: ReadonlyMap<string, HistoricalBarChunk | null>;
  provenance:     ImportProvenanceInput;
}

// ─── Day grouping ─────────────────────────────────────────────

/** Group bars by the UTC calendar day of their canonical start instant. */
export function groupBarsByUtcDay(bars: readonly HistoricalBar[]): Map<string, HistoricalBar[]> {
  const grouped = new Map<string, HistoricalBar[]>();
  for (const bar of bars) {
    const day = utcDayOf(bar.t);
    const existing = grouped.get(day);
    if (existing === undefined) grouped.set(day, [bar]);
    else existing.push(bar);
  }
  return grouped;
}

/** Ascending list of UTC days these bars touch — what the caller must read before planning. */
export function affectedUtcDays(bars: readonly HistoricalBar[]): string[] {
  return [...new Set(bars.map((bar) => utcDayOf(bar.t)))].sort();
}

// ─── Chunk assembly ───────────────────────────────────────────

function chunkToBars(chunk: HistoricalBarChunk): HistoricalBar[] {
  const bars: HistoricalBar[] = [];
  for (let i = 0; i < chunk.t.length; i++) {
    bars.push({ t: chunk.t[i], o: chunk.o[i], h: chunk.h[i], l: chunk.l[i], c: chunk.c[i], v: chunk.v[i] });
  }
  return bars;
}

function barsToChunk(
  seriesId: string,
  day: string,
  revision: number,
  bars: readonly HistoricalBar[],
): HistoricalBarChunk {
  return {
    chunkId: chunkIdOf(seriesId, day, revision),
    seriesId,
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

function sameBar(a: HistoricalBar, b: HistoricalBar): boolean {
  return a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.v === b.v;
}

/**
 * Earliest and latest observation in one O(n) pass, with no argument
 * spreading — see the call site for why that matters. Requires a
 * non-empty input, which the zero-bar guard already establishes.
 */
function observedExtremes(bars: readonly HistoricalBar[]): { first: number; last: number } {
  let first = bars[0].t;
  let last = bars[0].t;
  for (let i = 1; i < bars.length; i++) {
    const t = bars[i].t;
    if (t < first) first = t;
    if (t > last) last = t;
  }
  return { first, last };
}

// ─── Import planning ──────────────────────────────────────────

/**
 * Plan one import against freshly read committed state.
 *
 * CALLER CONTRACT: `existingRecord` and `existingChunks` MUST have been
 * read after the mutation lock was acquired. Planning against state
 * read earlier is the concurrency defect this design exists to prevent
 * — the plan is only as fresh as its inputs.
 *
 * A day whose union with the incoming bars adds no new timestamp is
 * left completely alone: no revision bump, no chunk written, committed
 * state byte-identical. That is what makes an identical re-import a
 * structural no-op rather than merely an eventually-consistent one.
 */
export function buildImportPlan(input: BuildImportPlanInput): BuildImportPlanResult {
  const { series, seriesId, bars, existingRecord, existingChunks, provenance } = input;

  // Checked FIRST and unconditionally. A zero-bar import is invalid
  // regardless of whether the series exists, is active, or is being
  // deleted: it can only produce an empty active manifest with
  // epoch-zero bounds, or a provenance entry for an import that
  // contributed nothing.
  if (bars.length === 0) {
    return {
      ok: false,
      reason: 'empty_import',
      message: `No bars were supplied for ${seriesId}; nothing was planned.`,
    };
  }

  if (existingRecord !== null && existingRecord.state !== 'active') {
    return {
      ok: false,
      reason: 'series_deleting',
      message: `Series ${seriesId} is being deleted; finish the deletion before importing into it.`,
    };
  }

  const previousActive = existingRecord?.committed.activeChunks ?? {};
  const grouped = groupBarsByUtcDay(bars);
  const chunksToWrite: HistoricalBarChunk[] = [];
  const nextActive: Record<string, number> = { ...previousActive };

  let idempotentDuplicates = 0;
  let barsAdded = 0;

  for (const day of [...grouped.keys()].sort()) {
    const incoming = grouped.get(day) ?? [];
    const existingChunk = existingChunks.get(day) ?? null;
    const existingBars = existingChunk === null ? [] : chunkToBars(existingChunk);

    const merged = new Map<number, HistoricalBar>();
    for (const bar of existingBars) merged.set(bar.t, bar);

    let added = 0;
    for (const bar of incoming) {
      const current = merged.get(bar.t);
      if (current === undefined) {
        merged.set(bar.t, bar);
        added++;
        continue;
      }
      if (!sameBar(current, bar)) {
        return {
          ok: false,
          reason: 'conflict',
          message: `Observation at ${new Date(bar.t).toISOString()} already exists for ${seriesId} with different values; the import was rejected rather than overwriting it.`,
        };
      }
      idempotentDuplicates++;
    }

    if (added === 0) continue;

    const nextRevision = (previousActive[day] ?? 0) + 1;
    const ordered = [...merged.values()].sort((left, right) => left.t - right.t);
    chunksToWrite.push(barsToChunk(seriesId, day, nextRevision, ordered));
    nextActive[day] = nextRevision;
    barsAdded += added;
  }

  // A single linear pass, NOT `Math.min(...bars.map(...))`. Spreading an
  // array into a call passes one argument per element, so a large but
  // entirely valid import overflows the engine's argument limit and
  // throws RangeError — measured here at roughly 130,000 elements,
  // which one contract-quarter of 1-minute data (~123,000 bars) already
  // approaches. `commitImport` contracts to return typed failures rather
  // than throw, so an unbounded input must not be able to break it.
  //
  // Safe without a null fallback: the zero-bar case returned above, so
  // there is always at least one observation. The former `?? 0` fallback
  // is what produced epoch-zero observed bounds.
  const extremes = observedExtremes(bars);
  const incomingFirst = extremes.first;
  const incomingLast = extremes.last;

  const provenanceEntry: ImportProvenanceEntry = {
    source:                    provenance.source,
    importedAt:                provenance.importedAt,
    sourceChecksumSha256:      provenance.sourceChecksumSha256,
    sourceRowCount:            provenance.sourceRowCount,
    acceptedBarCount:          bars.length,
    idempotentDuplicates,
    warnings:                  { ...provenance.warnings },
    observedFirstUtcMs:        incomingFirst,
    observedLastUtcMs:         incomingLast,
    sourceTimestampConvention: provenance.sourceTimestampConvention,
    normalizedConvention:      'start-of-bar',
    normalizationVersion:      NORMALIZATION_VERSION,
    dataType:                  provenance.dataType,
    sourceTimeZone:            provenance.sourceTimeZone,
  };

  const previousCommitted = existingRecord?.committed ?? null;
  const observedFirstUtcMs = previousCommitted === null
    ? incomingFirst
    : Math.min(previousCommitted.observedFirstUtcMs, incomingFirst);
  const observedLastUtcMs = previousCommitted === null
    ? incomingLast
    : Math.max(previousCommitted.observedLastUtcMs, incomingLast);

  const nextRecord: HistoricalSeriesRecord = {
    seriesId,
    series,
    state: 'active',
    committed: {
      activeChunks:       nextActive,
      observedFirstUtcMs,
      observedLastUtcMs,
      barCount:           (previousCommitted?.barCount ?? 0) + barsAdded,
    },
    provenance: {
      imports: [...(existingRecord?.provenance.imports ?? []), provenanceEntry],
    },
  };

  return { ok: true, plan: { chunksToWrite, nextRecord, idempotentDuplicates, barsAdded } };
}

// ─── Deletion planning ────────────────────────────────────────

export interface DeletePlan {
  /** The record to `put` so the series becomes invisible while its cleanup map survives. */
  tombstone:        HistoricalSeriesRecord;
  /** Every chunk id this series can deterministically account for. */
  chunkIdsToDelete: string[];
}

/**
 * Plan a deletion.
 *
 * The tombstone PRESERVES `committed.activeChunks`. Emptying it would
 * hide the series and simultaneously destroy the only record of which
 * chunk ids exist, leaving a crash mid-cleanup unrecoverable without
 * scanning the chunk store — which this design never does.
 *
 * Cleanup spans revisions `r1 … r(active + 1)` per day: `r1..active`
 * covers superseded revisions (which a successful commit deliberately
 * does not delete, so an in-flight reader holding an older manifest can
 * still finish), and `active + 1` covers the single speculative chunk a
 * failed import may have left behind for that day.
 *
 * KNOWN AND ACCEPTED LIMITATION: a failed import may also have written
 * a speculative chunk for a day that was never in the committed
 * manifest. Such a chunk is not enumerable from this record. It is
 * never reader-visible, it cannot affect committed state, a retry
 * reuses its id, and clearHistoricalCache or deleting the database
 * removes it. B1 deliberately adds no staging store, orphan index, GC,
 * or chunk-store scan to eliminate that unreachable residue.
 */
export function buildDeletePlan(record: HistoricalSeriesRecord): DeletePlan {
  const chunkIdsToDelete: string[] = [];
  for (const day of Object.keys(record.committed.activeChunks).sort()) {
    const active = record.committed.activeChunks[day];
    for (let revision = 1; revision <= active + 1; revision++) {
      chunkIdsToDelete.push(chunkIdOf(record.seriesId, day, revision));
    }
  }
  return {
    tombstone: record.state === 'deleting' ? record : { ...record, state: 'deleting' },
    chunkIdsToDelete,
  };
}
