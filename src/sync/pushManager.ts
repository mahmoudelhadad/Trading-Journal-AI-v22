// Push Manager — SYNC_ARCHITECTURE_SPEC.md §5.2, §8.2, §9.2, §10.
//
// The single upload path: "the Push Manager is the only code in the
// system that sends record data to Supabase" (§10). This module
// structurally enforces that by being the ONE place a network
// "upsert rows" request is constructed and sent — every category of
// write (ordinary edits, tombstones, Tier 2 bulk reconciliation, the
// migration's catch-up upload) is expected to flow through
// `runPushCycle`/`pushChunk`, never a parallel code path.
//
// DEPENDENCY-INJECTION BOUNDARY: this module performs storage and
// network I/O, but ONLY through the `PushRecordStore` and
// `PushTransport` interfaces below — it never imports storage.js, a
// Supabase client, or any concrete persistence code. A real
// implementation of each interface is built in a later phase; this
// phase ships the orchestration logic plus both interfaces, testable
// today with in-memory fakes.
//
// SCOPE: one table at a time. `PushRecordStore`/`PushTransport` are
// each scoped to a single table (trades, accounts, lists, or
// settings) — the caller (Scheduler, Phase 4f) instantiates one pair
// per table and calls `runPushCycle` once per table per cycle. This
// module never needs to know which table it's operating on, matching
// the "one record model, one mechanism" design established for the
// rest of src/sync/.
//
// PATCH CONTRACT (same convention as backoff.ts/conflictDetector.ts):
// every metadata-changing function returns a partial patch, never a
// complete record. This module never constructs or owns a complete
// record — there remains exactly one record representation in this
// codebase (SyncMetadata / Stamped<T> / SingletonRecord<T>, record.ts).

import { getSyncConfig, type SyncConfig } from '@sync/config.js';
import { isEligibleNow, applyBackoffFailure, resetBackoffOnSuccess, type BackoffState } from '@sync/backoff.js';
import { reportNetworkFailure, reportNetworkSuccess } from '@sync/onlineMonitor.js';
import type { SyncMetadata, SyncStatus } from '@sync/record.js';

// ─── Types ───────────────────────────────────────────────────

/**
 * The subset of a record's sync metadata this module needs, plus its
 * opaque business content. `content` is never interpreted by this
 * module — it is passed through to the wire payload verbatim (see
 * `buildPushRow`). The natural business key (`tid`/`local_id`, per
 * §3.2) is expected to live inside `content`; this module never needs
 * to know it, since matching/upsert-conflict-target selection is a
 * transport (table-specific) concern, not a Push Manager concern.
 */
export interface PushableRecord {
  syncId: string;
  syncStatus: SyncStatus;
  baseUpdatedAt: string | null;
  deletedAt: string | null;
  consecutiveFailures: number;
  nextEligibleAttemptAt: string | null;
  lastError: string | null;
  content: Record<string, unknown>;
}

/** Partial metadata patch — never a complete record. See file header. */
export type PushMetadataPatch = Partial<
  Pick<SyncMetadata, 'syncStatus' | 'baseUpdatedAt' | 'deletedAt' | 'consecutiveFailures' | 'nextEligibleAttemptAt' | 'lastError'>
>;

/**
 * One row as sent over the wire — a structured envelope, NOT a flat
 * spread of `content`. `content` is passed through completely
 * untouched (§9.2/§3.2's "content is opaque, never interpreted" is
 * structural here, not just a convention): it is never merged into
 * the same namespace as `deletedAt`/`cloudId`, so a business content
 * field can never collide with a transport-reserved key, for any
 * table, present or future. Mirrors `PulledRow`'s already-established
 * shape (pullManager.ts) — the same separation, applied consistently
 * on both sides of the wire.
 *
 * `deletedAt` is always present explicitly (§9.2 step 3). `cloudId` is
 * non-null only on this record's first-ever push — the client-
 * generated id to INSERT with (§3.2) — and always null on a
 * subsequent push, since `id` is excluded from the update column set
 * of every upsert. A transport determines the target table's real
 * column names/shape for all three; this module makes no assumption
 * about what the physical schema looks like.
 */
export interface WirePushRow {
  content: Record<string, unknown>;
  deletedAt: string | null;
  cloudId: string | null;
}

export interface PushSuccessRow {
  syncId: string;
  /** Server-returned `updated_at` for this row — mandatory for INV-1. */
  updatedAt: string;
}

export type PushTransportResult =
  | { kind: 'success'; rows: PushSuccessRow[] }
  | { kind: 'systemic_failure'; error: string }
  | { kind: 'per_row_failure'; error: string }
  | { kind: 'ambiguous_failure'; error: string };

/**
 * Network dependency, injected, scoped to one table. A conforming
 * implementation:
 *   - Sends exactly the rows given, as one upsert request, to Supabase.
 *   - Returns the server's `updated_at` for every row that succeeded
 *     (§10: "the push request must therefore be issued so that the
 *     server returns the written rows' updated_at values... a push
 *     whose response does not carry them cannot satisfy INV-1 and is
 *     treated as an ambiguous failure rather than a success").
 *   - Never throws for an HTTP-level or parse-level failure — a
 *     malformed/non-JSON HTTP 200 (§10) must be caught and returned as
 *     `ambiguous_failure`, not thrown. (This module defends against a
 *     non-conforming implementation anyway — see `pushChunk` — but a
 *     conforming transport should not rely on that.)
 *   - Classifies definitively-whole-batch failures (auth error, 5xx,
 *     confirmed network-level rejection) as `systemic_failure`, a
 *     specific-row constraint violation as `per_row_failure`, and
 *     everything else (timeout, malformed response, anything without
 *     a clean signal) as `ambiguous_failure`.
 */
export interface PushTransport {
  push(rows: WirePushRow[]): Promise<PushTransportResult>;
}

/**
 * Storage dependency, injected, scoped to one table. A conforming
 * implementation:
 *   - `getPendingRecords()` returns exactly the pending queue —
 *     `syncStatus IN (dirty, pending_delete)`, per §3.2's exact
 *     definition. `syncing` must never be returned (a record
 *     genuinely mid-flight is not this module's concern; the startup
 *     reconciliation rule, §6.1, is what prevents a stuck `syncing`
 *     record from existing outside an active push in the first place).
 *   - `applyPatch` merges a patch onto the record identified by
 *     `syncId` — the same "read current, merge, write" pattern used
 *     throughout src/sync/.
 *   - `purge` removes the record entirely (§9.2 step 4: a tombstone
 *     push success purges, it does not merely mark synced).
 */
export interface PushRecordStore {
  getPendingRecords(): Promise<PushableRecord[]>;
  applyPatch(syncId: string, patch: PushMetadataPatch): Promise<void>;
  purge(syncId: string): Promise<void>;
}

// ─── Wire payload construction (§9.2, §3.2) ─────────────────────

/**
 * Builds one row for the wire, as a structured envelope (see
 * `WirePushRow`'s doc comment for why this is not a flat spread).
 * `deletedAt` is always present explicitly (§9.2 step 3 — this is what
 * lets a restored record's ordinary push clear an existing cloud
 * tombstone: the payload never merely omits the field). `cloudId` is
 * set ONLY when `baseUpdatedAt` is `null` — i.e., only on this
 * record's first-ever push, the INSERT that creates the cloud row —
 * and is `null` on every subsequent push, satisfying §3.2's "`id` is
 * excluded from the update column set of every upsert — it is written
 * only by the insert that first creates the cloud row, and never
 * changed afterward." A transport maps `cloudId` to whatever its real
 * schema's primary-key column is named, only when non-null.
 */
export function buildPushRow(record: PushableRecord): WirePushRow {
  return {
    content: record.content,
    deletedAt: record.deletedAt,
    cloudId: record.baseUpdatedAt === null ? record.syncId : null,
  };
}

// ─── Metadata patch builders ─────────────────────────────────────

/** INV-1: every successful push sets baseUpdatedAt to the server-returned value and clears backoff/error state. */
export function buildSuccessPatch(serverUpdatedAt: string): PushMetadataPatch {
  const resetBackoff: BackoffState = resetBackoffOnSuccess();
  return { syncStatus: 'synced', baseUpdatedAt: serverUpdatedAt, ...resetBackoff };
}

/**
 * §10: "A record that still fails repeatedly even after isolation to
 * itself remains dirty (no new top-level syncStatus value is
 * introduced)." `syncStatus` is deliberately absent from this patch —
 * only backoff/error state changes on failure.
 */
export function buildFailurePatch(
  record: Pick<PushableRecord, 'consecutiveFailures'>,
  error: string,
  now: string,
  config: SyncConfig = getSyncConfig(),
): PushMetadataPatch {
  return applyBackoffFailure(record, error, now, config);
}

// ─── Chunking / bisection ────────────────────────────────────────

export function chunkRecords<T>(records: readonly T[], batchSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < records.length; i += batchSize) chunks.push(records.slice(i, i + batchSize));
  return chunks;
}

/** Splits a batch into two halves for bisection (§10). Assumes length >= 2. */
export function bisectChunk<T>(chunk: readonly T[]): [T[], T[]] {
  const mid = Math.ceil(chunk.length / 2);
  return [chunk.slice(0, mid), chunk.slice(mid)];
}

// ─── Core per-chunk push (§10's partial-failure handling) ────────

export interface PushChunkOutcome {
  succeededCount: number;
  purgedCount: number;
  failedCount: number;
  /** Newest server `updated_at` observed among this chunk's successful rows, or null. Feeds `lastServerObservedAt` (§3.3) — the caller aggregates across chunks/tables. */
  newestServerTimestamp: string | null;
}

function mergeOutcomes(a: PushChunkOutcome, b: PushChunkOutcome): PushChunkOutcome {
  const newest =
    a.newestServerTimestamp && b.newestServerTimestamp
      ? new Date(a.newestServerTimestamp).getTime() > new Date(b.newestServerTimestamp).getTime()
        ? a.newestServerTimestamp
        : b.newestServerTimestamp
      : (a.newestServerTimestamp ?? b.newestServerTimestamp);
  return {
    succeededCount: a.succeededCount + b.succeededCount,
    purgedCount: a.purgedCount + b.purgedCount,
    failedCount: a.failedCount + b.failedCount,
    newestServerTimestamp: newest,
  };
}

/**
 * Sends one chunk and handles the outcome per §10:
 *   - success: apply INV-1 patches (or purge, for a tombstone push).
 *   - systemic_failure: durable backoff applied to the WHOLE chunk;
 *     never bisects (re-sending smaller pieces of a definitively
 *     whole-batch failure — an auth error, a 5xx — would not help;
 *     every sub-chunk would fail identically). Exactly one network
 *     attempt; this function does not retry.
 *   - per_row_failure: bisects immediately (a clean, definitive
 *     failure signal, not a retry of the same thing — each half is a
 *     genuinely different, smaller attempt), recursing until the bad
 *     record(s) are isolated to chunks of 1.
 *   - ambiguous_failure: durable backoff applied to the WHOLE chunk,
 *     exactly like systemic_failure. This function does NOT retry and
 *     does NOT bisect on an ambiguous failure.
 *
 * RESPONSIBILITY BOUNDARY (§5.2): this module is responsible for a
 * single push attempt and interpreting its outcome — never for retry
 * TIMING or repeated attempts across cycles, which belong to the
 * Scheduler (§5.2: "decides *when* a sync cycle runs"). Per-row
 * bisection stays here because it has no timing dimension — it is
 * immediate, deterministic re-chunking in response to a clean signal,
 * a natural extension of "chunks them" (§5.2's own description of
 * this component), not a scheduling decision. The §10 rule that an
 * ambiguous failure escalates to bisection after N *consecutive*
 * occurrences is deliberately NOT implemented in this module: deciding
 * when to re-attempt an ambiguously-failing composition, and tracking
 * how many consecutive ambiguous failures that specific composition
 * has accumulated across separate cycles, is the Scheduler's job
 * (Phase 4f) — this function has no memory between calls and only
 * ever sees one attempt, so it cannot and does not try to count
 * "consecutive" anything. The Scheduler will call this function again
 * for the same (or a bisected) set of records when it decides to.
 */
export async function pushChunk(
  chunk: readonly PushableRecord[],
  store: PushRecordStore,
  transport: PushTransport,
  now: string,
  config: SyncConfig = getSyncConfig(),
): Promise<PushChunkOutcome> {
  if (chunk.length === 0) {
    return { succeededCount: 0, purgedCount: 0, failedCount: 0, newestServerTimestamp: null };
  }

  let result: PushTransportResult;
  try {
    result = await transport.push(chunk.map(buildPushRow));
  } catch (err) {
    // Defensive: §10 requires a conforming transport to never throw
    // uncleanly. If one does anyway, this module still does not abort
    // the cycle — it treats the failure as ambiguous.
    result = { kind: 'ambiguous_failure', error: err instanceof Error ? err.message : String(err) };
  }

  if (result.kind === 'success') {
    reportNetworkSuccess();
    let succeededCount = 0;
    let purgedCount = 0;
    let newestServerTimestamp: string | null = null;
    for (const row of result.rows) {
      const record = chunk.find((r) => r.syncId === row.syncId);
      if (!record) continue; // defensive: ignore a row the transport returned that we didn't ask about
      if (!newestServerTimestamp || new Date(row.updatedAt).getTime() > new Date(newestServerTimestamp).getTime()) {
        newestServerTimestamp = row.updatedAt;
      }
      if (record.syncStatus === 'pending_delete' || record.deletedAt !== null) {
        await store.purge(record.syncId);
        purgedCount += 1;
      } else {
        await store.applyPatch(record.syncId, buildSuccessPatch(row.updatedAt));
        succeededCount += 1;
      }
    }
    return { succeededCount, purgedCount, failedCount: 0, newestServerTimestamp };
  }

  if (result.kind === 'systemic_failure') {
    reportNetworkFailure();
    for (const record of chunk) {
      await store.applyPatch(record.syncId, buildFailurePatch(record, result.error, now, config));
    }
    return { succeededCount: 0, purgedCount: 0, failedCount: chunk.length, newestServerTimestamp: null };
  }

  if (result.kind === 'per_row_failure') {
    reportNetworkFailure();
    if (chunk.length === 1) {
      await store.applyPatch(chunk[0].syncId, buildFailurePatch(chunk[0], result.error, now, config));
      return { succeededCount: 0, purgedCount: 0, failedCount: 1, newestServerTimestamp: null };
    }
    const [left, right] = bisectChunk(chunk);
    const leftOutcome = await pushChunk(left, store, transport, now, config);
    const rightOutcome = await pushChunk(right, store, transport, now, config);
    return mergeOutcomes(leftOutcome, rightOutcome);
  }

  // result.kind === 'ambiguous_failure' — same treatment as
  // systemic_failure: durable backoff on the whole chunk, one
  // attempt, no retry, no bisection. See the RESPONSIBILITY BOUNDARY
  // note above for why escalation-after-N-consecutive-failures is not
  // implemented here.
  reportNetworkFailure();
  for (const record of chunk) {
    await store.applyPatch(record.syncId, buildFailurePatch(record, result.error, now, config));
  }
  return { succeededCount: 0, purgedCount: 0, failedCount: chunk.length, newestServerTimestamp: null };
}

// ─── Top-level orchestration ──────────────────────────────────────

export interface PushCycleResult {
  succeededCount: number;
  purgedCount: number;
  failedCount: number;
  newestServerTimestamp: string | null;
}

/**
 * Runs one push cycle for one table: fetches the pending queue,
 * excludes records whose backoff hasn't elapsed (§10: "Batch assembly
 * excludes any record whose nextEligibleAttemptAt is still in the
 * future"), chunks the rest (bounded batch size, §10), and pushes
 * every chunk via `pushChunk`.
 *
 * `now` must be server-derived where correctness depends on it
 * (backoff eligibility is local-clock-tolerant per INV-4 — timers are
 * explicitly the one place a local clock is sanctioned, §3.6) — a
 * local `new Date().toISOString()` is an acceptable caller-supplied
 * value here, unlike in conflictDetector.ts.
 */
export async function runPushCycle(
  store: PushRecordStore,
  transport: PushTransport,
  now: string,
  config: SyncConfig = getSyncConfig(),
): Promise<PushCycleResult> {
  const pending = await store.getPendingRecords();
  // Defensive re-filter: this module's only contract with the pending
  // queue is §3.2's exact definition, regardless of what a given store
  // implementation actually returns.
  const inQueue = pending.filter((r) => r.syncStatus === 'dirty' || r.syncStatus === 'pending_delete');
  const eligible = inQueue.filter((r) => isEligibleNow(r.nextEligibleAttemptAt, now));
  const chunks = chunkRecords(eligible, config.pushBatchSize);

  let result: PushCycleResult = { succeededCount: 0, purgedCount: 0, failedCount: 0, newestServerTimestamp: null };
  for (const chunk of chunks) {
    const outcome = await pushChunk(chunk, store, transport, now, config);
    result = {
      succeededCount: result.succeededCount + outcome.succeededCount,
      purgedCount: result.purgedCount + outcome.purgedCount,
      failedCount: result.failedCount + outcome.failedCount,
      newestServerTimestamp:
        result.newestServerTimestamp && outcome.newestServerTimestamp
          ? new Date(result.newestServerTimestamp).getTime() > new Date(outcome.newestServerTimestamp).getTime()
            ? result.newestServerTimestamp
            : outcome.newestServerTimestamp
          : (result.newestServerTimestamp ?? outcome.newestServerTimestamp),
    };
  }
  return result;
}
