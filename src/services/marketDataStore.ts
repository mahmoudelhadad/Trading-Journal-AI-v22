/**
 * services/marketDataStore.ts
 *
 * B1 — the persistence shell for historical market data.
 *
 * Thin on purpose: every decision lives in the pure planner
 * (marketDataIngestion.ts). This file owns exactly three
 * host-dependent responsibilities — mutual exclusion, ordered writes,
 * and typed failure — and nothing else.
 *
 * MUTUAL EXCLUSION. Every mutation runs inside one origin-wide
 * exclusive Web Lock. Without it the revision model is unsafe: two
 * concurrent imports both reading `Day A → r1` would both allocate r2,
 * collide on the same speculative id, and each commit its own manifest,
 * pairing one writer's provenance with another writer's bytes. The lock
 * is scoped to the origin, so it serializes across tabs, iframes and
 * workers, and the platform releases it when the owning context dies —
 * a crashed tab can never leave a permanent lock behind.
 *
 * THE ORDERING RULE THAT MATTERS: state is re-read INSIDE the lock,
 * never before it. A plan is only as fresh as its inputs, and planning
 * against pre-lock state is exactly the defect the lock exists to
 * prevent.
 *
 * COMMIT ORDER: all immutable chunks first, then ONE `put` of the
 * series record. That single-record put is the only visibility-changing
 * operation, so a failure anywhere before it leaves the previously
 * committed state exactly as it was.
 *
 * DESTRUCTIVE ORDER: make invisible first, remove payload second — the
 * same rule for `deleteSeries` (tombstone, then chunks) and
 * `clearHistoricalCache` (manifests, then chunks).
 *
 * TESTING SEAM: `runExclusive` is injectable. The REAL Web Lock is host
 * behaviour a Node-only harness structurally cannot reach (Playbook
 * §24), so it is proven at Runtime Acceptance; the ordering and
 * decision logic is proven here with an injected passthrough. The seam
 * is on the storage API only — no locking concept reaches the
 * Replay-facing reader.
 */

import {
  MARKET_DATA_MUTATION_LOCK,
  MARKET_DATA_STORE_NAMES,
  CLEAR_STORE_ORDER,
} from './marketDataDb.js';
import {
  affectedUtcDays,
  buildImportPlan,
  buildDeletePlan,
  type ImportProvenanceInput,
} from './marketDataIngestion.js';
import {
  chunkIdOf,
  seriesIdOf,
  type HistoricalBar,
  type HistoricalBarChunk,
  type HistoricalSeriesIdentity,
  type HistoricalSeriesRecord,
  type ImportWarningCounts,
} from '@apptypes/marketData.js';
import type { IndexedDbHandle } from './indexedDb.js';
import type { ChunkSourceRead, HistoricalChunkSource } from './historicalBarReader.js';

const SERIES = MARKET_DATA_STORE_NAMES.SERIES;
const BAR_CHUNKS = MARKET_DATA_STORE_NAMES.BAR_CHUNKS;

// ─── Public result types ──────────────────────────────────────

export interface CommitImportSummary {
  seriesId:             string;
  chunksWritten:        number;
  barsAdded:            number;
  idempotentDuplicates: number;
  barCount:             number;
}

export type MarketDataWriteResult =
  | { ok: true; summary: CommitImportSummary }
  | {
      ok: false;
      reason: 'conflict' | 'series_deleting' | 'empty_import' | 'integrity_violation'
            | 'mutation_lock_unavailable' | 'db_unavailable' | 'write_failed';
      message?: string;
    };

/** Everything one import contributes: canonical bars plus its source-side provenance. */
export interface CommitImportInput {
  series:                    HistoricalSeriesIdentity;
  bars:                      readonly HistoricalBar[];
  sourceRowCount:            number;
  warnings:                  ImportWarningCounts;
  source:                    'ninjatrader';
  dataType:                  'Last';
  sourceTimeZone:            'UTC';
  sourceTimestampConvention: 'end-of-bar';
  /** Lowercase hex SHA-256 of the source text; '' when the host offers no Web Crypto. */
  sourceChecksumSha256:      string;
  importedAt:                number;
}

export type ExclusiveRunner =
  <T>(fn: () => Promise<T>) => Promise<{ acquired: false } | { acquired: true; value: T }>;

export interface MarketDataStoreOptions {
  /** Test seam. Omit in production to use the origin-wide Web Lock. */
  runExclusive?: ExclusiveRunner;
}

// ─── Mutual exclusion ─────────────────────────────────────────

interface LockManagerLike {
  request(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => Promise<void>,
  ): Promise<unknown>;
}

/**
 * Structural lookup rather than a lib.dom type reference, so this
 * compiles regardless of the TypeScript DOM lib vintage and degrades
 * cleanly on a host without the API.
 */
function lockManager(): LockManagerLike | null {
  const navigatorLike = (globalThis as { navigator?: { locks?: unknown } }).navigator;
  const locks = navigatorLike?.locks as LockManagerLike | undefined;
  return locks !== undefined && typeof locks.request === 'function' ? locks : null;
}

/**
 * No `ifAvailable` (we want queuing, not spurious rejection), no
 * `steal` (ever), no timeout (mutations are rare and manual; a wait is
 * correct behaviour, and a genuinely hung mutation is a bug to fix
 * rather than to mask). Release is the platform's job — never manual.
 */
const defaultRunExclusive: ExclusiveRunner = async (fn) => {
  const locks = lockManager();
  if (locks === null) return { acquired: false };
  let value: Awaited<ReturnType<typeof fn>> | undefined;
  await locks.request(MARKET_DATA_MUTATION_LOCK, { mode: 'exclusive' }, async () => {
    value = await fn();
  });
  return { acquired: true, value: value as Awaited<ReturnType<typeof fn>> };
};

const LOCK_UNAVAILABLE = {
  ok: false as const,
  reason: 'mutation_lock_unavailable' as const,
  message: 'No origin-wide mutation lock is available in this context; no market data was written.',
};

async function withMutationLock(
  options: MarketDataStoreOptions | undefined,
  work: () => Promise<MarketDataWriteResult>,
): Promise<MarketDataWriteResult> {
  const run = options?.runExclusive ?? defaultRunExclusive;
  const outcome = await run(work);
  return outcome.acquired ? outcome.value : LOCK_UNAVAILABLE;
}

function writeFailed(message: string): MarketDataWriteResult {
  return { ok: false, reason: 'write_failed', message };
}

// ─── commitImport ─────────────────────────────────────────────

/**
 * Ingest one parsed source file into the canonical store.
 *
 * Phase 1 (planning inputs) and phase 2 (conflict detection) happen
 * before any write, so a rejected import touches nothing. Phase 3
 * writes immutable chunks, phase 4 commits the manifest.
 */
export async function commitImport(
  handle: IndexedDbHandle,
  input: CommitImportInput,
  options?: MarketDataStoreOptions,
): Promise<MarketDataWriteResult> {
  // An import carrying no accepted bars is rejected UNCONDITIONALLY,
  // before any read and before any write, whether or not the series
  // already exists. Committing one would either create an active series
  // with no observations and epoch-zero bounds — which
  // `getLocalAvailability` would then report as available — or append a
  // provenance entry recording an import that contributed nothing.
  if (input.bars.length === 0) {
    return {
      ok: false,
      reason: 'empty_import',
      message: 'The source contained no bars; nothing was written.',
    };
  }

  return withMutationLock(options, async () => {
    const seriesId = seriesIdOf(input.series);

    // Re-read committed state INSIDE the lock. Never before it.
    const recordResult = await handle.get<HistoricalSeriesRecord>(SERIES, seriesId);
    if (recordResult.kind === 'failure') {
      return { ok: false, reason: 'db_unavailable', message: recordResult.error.message };
    }
    const existingRecord = recordResult.value;

    if (existingRecord !== null && existingRecord.state !== 'active') {
      return {
        ok: false,
        reason: 'series_deleting',
        message: `Series ${seriesId} is being deleted; finish the deletion before importing into it.`,
      };
    }

    const existingChunks = new Map<string, HistoricalBarChunk | null>();
    for (const day of affectedUtcDays(input.bars)) {
      const revision = existingRecord?.committed.activeChunks[day];
      if (revision === undefined) {
        existingChunks.set(day, null);
        continue;
      }
      const chunkId = chunkIdOf(seriesId, day, revision);
      const chunkResult = await handle.get<HistoricalBarChunk>(BAR_CHUNKS, chunkId);
      if (chunkResult.kind === 'failure') {
        return { ok: false, reason: 'db_unavailable', message: chunkResult.error.message };
      }
      if (chunkResult.value === null) {
        // The manifest references this chunk and the read PROVED it
        // absent. Treating that as "this day has no bars" would silently
        // replace the missing data with only the incoming bars and
        // produce a barCount that still counts the lost ones. The reader
        // already calls this state an integrity violation; the writer
        // must not quietly repair what the reader refuses to trust.
        return {
          ok: false,
          reason: 'integrity_violation',
          message: `Committed chunk ${chunkId} is referenced by the manifest but missing; the import was rejected rather than overwriting the day.`,
        };
      }
      existingChunks.set(day, chunkResult.value);
    }

    const provenance: ImportProvenanceInput = {
      source:                    input.source,
      importedAt:                input.importedAt,
      sourceChecksumSha256:      input.sourceChecksumSha256,
      sourceRowCount:            input.sourceRowCount,
      warnings:                  input.warnings,
      dataType:                  input.dataType,
      sourceTimeZone:            input.sourceTimeZone,
      sourceTimestampConvention: input.sourceTimestampConvention,
    };

    const planned = buildImportPlan({
      series: input.series,
      seriesId,
      bars: input.bars,
      existingRecord,
      existingChunks,
      provenance,
    });
    if (!planned.ok) return { ok: false, reason: planned.reason, message: planned.message };

    // Immutable chunks first — invisible until the manifest names them.
    for (const chunk of planned.plan.chunksToWrite) {
      const written = await handle.put(BAR_CHUNKS, chunk);
      if (written.kind === 'failure') {
        return writeFailed(`Chunk ${chunk.chunkId} could not be written: ${written.error.message}`);
      }
    }

    // The single visibility-changing operation.
    const committed = await handle.put(SERIES, planned.plan.nextRecord);
    if (committed.kind === 'failure') {
      return writeFailed(`Series manifest ${seriesId} could not be committed: ${committed.error.message}`);
    }

    return {
      ok: true,
      summary: {
        seriesId,
        chunksWritten:        planned.plan.chunksToWrite.length,
        barsAdded:            planned.plan.barsAdded,
        idempotentDuplicates: planned.plan.idempotentDuplicates,
        barCount:             planned.plan.nextRecord.committed.barCount,
      },
    };
  });
}

// ─── deleteSeries ─────────────────────────────────────────────

/**
 * Remove one series.
 *
 * The tombstone `put` hides the series immediately while PRESERVING
 * `committed.activeChunks`, so an interruption anywhere after it leaves
 * a record that a later call can resume from deterministically — no
 * scan, no background worker, no lost cleanup map.
 */
export async function deleteSeries(
  handle: IndexedDbHandle,
  seriesId: string,
  options?: MarketDataStoreOptions,
): Promise<MarketDataWriteResult> {
  return withMutationLock(options, async () => {
    const recordResult = await handle.get<HistoricalSeriesRecord>(SERIES, seriesId);
    if (recordResult.kind === 'failure') {
      return { ok: false, reason: 'db_unavailable', message: recordResult.error.message };
    }
    const record = recordResult.value;
    if (record === null) {
      return { ok: true, summary: emptySummary(seriesId) };
    }

    const plan = buildDeletePlan(record);

    if (record.state === 'active') {
      const tombstoned = await handle.put(SERIES, plan.tombstone);
      if (tombstoned.kind === 'failure') {
        return writeFailed(`Series ${seriesId} could not be tombstoned: ${tombstoned.error.message}`);
      }
    }

    for (const chunkId of plan.chunkIdsToDelete) {
      const removed = await handle.delete(BAR_CHUNKS, chunkId);
      if (removed.kind === 'failure') {
        return writeFailed(`Chunk ${chunkId} could not be deleted: ${removed.error.message}`);
      }
    }

    const removedRecord = await handle.delete(SERIES, seriesId);
    if (removedRecord.kind === 'failure') {
      return writeFailed(`Series ${seriesId} could not be removed: ${removedRecord.error.message}`);
    }

    return { ok: true, summary: emptySummary(seriesId) };
  });
}

// ─── clearHistoricalCache ─────────────────────────────────────

/**
 * Remove the entire historical cache.
 *
 * Manifests are cleared FIRST. If chunk clearing then fails, nothing is
 * visible and nothing is reachable, and re-running finishes the job.
 * The reverse order would leave visible manifests pointing at deleted
 * payload — a strictly worse state than either endpoint.
 */
export async function clearHistoricalCache(
  handle: IndexedDbHandle,
  options?: MarketDataStoreOptions,
): Promise<MarketDataWriteResult> {
  return withMutationLock(options, async () => {
    for (const store of CLEAR_STORE_ORDER) {
      const cleared = await handle.clear(store);
      if (cleared.kind === 'failure') {
        return writeFailed(`Store "${store}" could not be cleared: ${cleared.error.message}`);
      }
    }
    return { ok: true, summary: emptySummary('') };
  });
}

function emptySummary(seriesId: string): CommitImportSummary {
  return { seriesId, chunksWritten: 0, barsAdded: 0, idempotentDuplicates: 0, barCount: 0 };
}

// ─── Reader adapter ───────────────────────────────────────────

/**
 * The single point where IndexedDB meets the Replay-facing reader.
 *
 * A future shared historical service supplies a different
 * implementation of this same interface; the reader, and therefore
 * Replay, does not change.
 */
export function createIndexedDbChunkSource(handle: IndexedDbHandle): HistoricalChunkSource {
  return {
    async getSeries(seriesId: string): Promise<ChunkSourceRead<HistoricalSeriesRecord>> {
      const result = await handle.get<HistoricalSeriesRecord>(SERIES, seriesId);
      // A failed read PROVES NOTHING. Reporting it as `value: null`
      // would let the reader treat a storage error as established
      // absence.
      return result.kind === 'success' ? { ok: true, value: result.value } : { ok: false };
    },
    async getChunk(chunkId: string): Promise<ChunkSourceRead<HistoricalBarChunk>> {
      const result = await handle.get<HistoricalBarChunk>(BAR_CHUNKS, chunkId);
      return result.kind === 'success' ? { ok: true, value: result.value } : { ok: false };
    },
  };
}
