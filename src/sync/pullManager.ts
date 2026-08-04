// Pull Manager — SYNC_ARCHITECTURE_SPEC.md §5.2, §7, §9.2a.
//
// DEPENDENCY-INJECTION BOUNDARY: this module performs storage and
// network I/O, but ONLY through the `PullRecordStore` and
// `PullTransport` interfaces below — it never imports storage.js, a
// Supabase client, or any concrete persistence code. Mirrors the same
// pattern established for the Push Manager (Phase 4c).
//
// SCOPE: one table at a time. Both interfaces are scoped to a single
// table — the caller (Scheduler, Phase 4f) instantiates one pair per
// table and calls `runPullOperation` once per table per cycle.
//
// RESPONSIBILITY BOUNDARY (§5.2, matching the split agreed for the
// Push Manager in Phase 4c): this module performs ONE pull operation
// for one table — walking every page until the cloud reports no more
// data, or a page fails — and returns a deterministic result. It does
// NOT decide when to run again, does not retry a failed page itself,
// and owns no timers. Those are the Scheduler's job.
//
// TIER 2 RULES 1–3 ARE DELIBERATELY NOT EVALUATED HERE. Rule 2
// ("conflict volume") is explicitly defined as a GLOBAL count across
// all four tables (§8.2) — only the Scheduler, which calls this
// function once per table, can aggregate that. Rules 1 ("first sync")
// and 3 ("expired retention window") are single-table, but deciding
// whether to escalate — and therefore whether to run this function's
// ordinary incremental pull AT ALL for a given table this cycle — is
// itself the kind of cross-cutting cycle decision that belongs to the
// Scheduler, not something this module gates internally. This
// function always does the same thing when called: pull incrementally
// from the current cursor. `runPullOperation`'s result includes
// everything the Scheduler needs (conflict tally, cursor/timestamp
// state) to evaluate all three rules itself, via conflictDetector.ts's
// `evaluateFirstSyncEscalation` / `evaluateConflictVolumeEscalation` /
// `evaluateRetentionWindowEscalation`. Rule 4 ("repeated conflict") IS
// already fully handled — it's evaluated per-record inside
// `evaluateIncomingRecord` itself (Conflict Detector), and this module
// simply applies whatever `escalate_tier2` patch comes back, exactly
// like any other decision.
//
// WHY NO NATURAL-KEY-FALLBACK MATCHING: §3.2's "Record identity" note
// describes a device adopting the cloud's `id` when it differs from
// its own locally-generated `syncId` — this can only happen when two
// devices independently stamped the same pre-existing record (§13
// Step 3) with different syncIds before ever syncing. That exact
// situation is precisely what Tier 2 escalation rule 1 ("first sync")
// exists to catch (§8.2): the local device has records with
// `baseUpdatedAt = null` and an uninitialized cursor. Per the
// boundary above, the Scheduler is expected to route a table through
// Tier 2 review BEFORE ever calling this function's ordinary
// incremental pull for it. Once a table has been through first-sync
// resolution (or was never ambiguous — a genuinely new device/table
// has nothing to mismatch against), every local record's `syncId`
// either already equals the cloud `id` it will map to, or is
// literally created from the cloud's `id` directly (Tier 2's "Use
// Cloud Data" path, §8.2). So by the time this module's ordinary
// per-record loop runs, a `syncId` mismatch cannot occur, and
// `findLocalRecordBySyncId` matching by `syncId` alone is sufficient
// and correct — not a simplification with a residual gap.
//
// PRECONDITIONS (binding on the caller, not just an inference this
// module happens to rely on):
//   1. Tier 2 admission has already been evaluated by the Scheduler
//      before `runPullOperation` is called for a given table this
//      cycle — i.e. `evaluateFirstSyncEscalation` (and rules 2/3) have
//      already been checked, using this table's *previous* cycle's
//      result plus whatever cross-table state the Scheduler tracks.
//   2. This module is never invoked for a table currently awaiting
//      first-sync (or any other Tier 2) review — the Scheduler routes
//      such a table to the review flow instead of calling this
//      function for it.
//   3. Therefore, every incoming row this module processes is
//      guaranteed matchable by `syncId` alone. Natural-key fallback
//      matching is intentionally out of scope for this module — not
//      because the underlying identity-mismatch scenario can't occur
//      in the system as a whole, but because precondition 2 guarantees
//      it can never reach this module's input. If a future caller
//      violates these preconditions (e.g. calls this function for a
//      table that hasn't cleared Tier 2 admission), `findLocalRecordBySyncId`
//      returning `null` for a record that actually exists locally
//      under a different `syncId` is the observable failure mode —
//      that row would be treated as brand-new (§9.2a: "no local
//      record exists") rather than matched, which is exactly the kind
//      of silent-duplication risk these preconditions exist to rule out.

import { getSyncConfig, type SyncConfig } from '@sync/config.js';
import { reportNetworkFailure, reportNetworkSuccess } from '@sync/onlineMonitor.js';
import {
  evaluateIncomingRecord,
  type ConflictAction,
  type ConflictReason,
  type IncomingPulledRecord,
  type LocalRecordSyncState,
  type SyncMetadataPatch,
} from '@sync/conflictDetector.js';

// ─── Types ───────────────────────────────────────────────────

/** One row as received from the wire, already parsed into its metadata/content halves. */
export interface PulledRow {
  /** The cloud row's primary key — matches (or becomes) this record's local `syncId`. */
  id: string;
  updatedAt: string;
  /** Maps to the cloud row's `deleted_at`; `null` for a live row. */
  deletedAt: string | null;
  /** Opaque business content — everything else on the row. Never interpreted by this module. */
  content: Record<string, unknown>;
}

export interface PullCursor {
  updatedAt: string | null;
  id: string | null;
}

export interface PullPage {
  /** Ordered `updated_at ASC, id ASC` — the transport's contract (§7.2); this module trusts it. */
  rows: PulledRow[];
  /** True when this page returned fewer rows than requested — no more data this operation. */
  isLastPage: boolean;
}

export type PullTransportResult = { kind: 'success'; page: PullPage } | { kind: 'failure'; error: string };

/**
 * Network dependency, injected, scoped to one table. A conforming
 * implementation issues one keyset-paginated query per call — `ORDER
 * BY updated_at ASC, id ASC`, filtered by `WHERE (updated_at, id) >
 * (cursor.updatedAt, cursor.id)` as a row/tuple comparison when the
 * cursor is set, unfiltered when both are `null` (§7.2) — and must
 * never throw for a malformed/non-JSON response; caught and returned
 * as `{kind: 'failure', ...}` instead (§10's malformed-response
 * handling applies to any network operation, §11).
 */
export interface PullTransport {
  fetchPage(cursor: PullCursor, pageSize: number): Promise<PullTransportResult>;
}

export interface MatchedLocalRecord extends LocalRecordSyncState {
  syncId: string;
}

/**
 * Storage dependency, injected, scoped to one table. A conforming
 * implementation:
 *   - `advanceCursor` is called only after every record in a page has
 *     been successfully applied (§7.2) — never mid-page, never on a
 *     page that failed. This module also never calls it backward
 *     (INV-3).
 *   - `setLastServerObservedAt` is called whenever a newer server
 *     timestamp is observed — cross-table by nature (§3.3), but this
 *     store instance is table-scoped, so it persists only this
 *     table's own write; aggregating the true cross-table maximum for
 *     display/decision purposes is the Scheduler's job.
 *   - `findLocalRecordBySyncId` matches by `syncId` only — see the
 *     module header for why that's sufficient.
 *   - `upsertRecord`/`applyMetadataPatch`/`purge` mirror the
 *     "read current, merge, write" pattern used throughout src/sync/.
 */
export interface PullRecordStore {
  getCursor(): Promise<PullCursor>;
  advanceCursor(cursor: PullCursor): Promise<void>;
  getLastServerObservedAt(): Promise<string | null>;
  setLastServerObservedAt(timestamp: string): Promise<void>;
  findLocalRecordBySyncId(syncId: string): Promise<MatchedLocalRecord | null>;
  upsertRecord(syncId: string, content: Record<string, unknown>, metadataPatch: SyncMetadataPatch): Promise<void>;
  applyMetadataPatch(syncId: string, metadataPatch: SyncMetadataPatch): Promise<void>;
  purge(syncId: string): Promise<void>;
}

// ─── Per-record application ──────────────────────────────────────

/**
 * Matches the incoming row to a local record (if any), runs it
 * through the Conflict Detector, and applies whatever the decision
 * requires — a content+metadata write (`apply_incoming`), a removal
 * (`purge`), a metadata-only write (`keep_local`, `escalate_tier2`),
 * or nothing at all (`ignore_incoming`, `ignore_orphan_tombstone`,
 * `tie_unresolved`). Re-reads the local record fresh for every row
 * (via `findLocalRecordBySyncId`, called once per row, right before
 * evaluation) — never a bulk snapshot taken once per page/pull — which
 * is what makes §7.3's "conflict detection is evaluated fresh, per
 * record, at apply time" hold structurally rather than by convention.
 */
export async function applyPulledRow(
  row: PulledRow,
  store: PullRecordStore,
  nowServerTimestamp: string,
  config: SyncConfig = getSyncConfig(),
): Promise<{ action: ConflictAction; reason: ConflictReason }> {
  const local = await store.findLocalRecordBySyncId(row.id);
  const localState: LocalRecordSyncState | null = local;
  const incoming: IncomingPulledRecord = { updatedAt: row.updatedAt, isTombstone: row.deletedAt !== null };

  const resolution = evaluateIncomingRecord(localState, incoming, nowServerTimestamp, config);

  switch (resolution.action) {
    case 'apply_incoming':
      await store.upsertRecord(row.id, row.content, resolution.metadataPatch);
      break;
    case 'purge':
      await store.purge(row.id);
      break;
    case 'keep_local':
    case 'escalate_tier2':
      await store.applyMetadataPatch(row.id, resolution.metadataPatch);
      break;
    case 'ignore_incoming':
    case 'ignore_orphan_tombstone':
    case 'tie_unresolved':
      // No write — nothing to apply.
      break;
  }

  return { action: resolution.action, reason: resolution.reason };
}

// ─── Top-level orchestration ──────────────────────────────────────

export interface PullConflictTally {
  /** Count of rows whose resolution was a genuine Tier-1-eligible conflict — feeds §8.2 rule 2 (the caller sums this across all four tables). */
  total: number;
  byReason: Partial<Record<ConflictReason, number>>;
}

export interface PullOperationResult {
  pagesProcessed: number;
  rowsProcessed: number;
  appliedCount: number;
  purgedCount: number;
  keptLocalCount: number;
  ignoredCount: number;
  tieUnresolvedCount: number;
  escalatedCount: number;
  conflictTally: PullConflictTally;
  cursorBefore: PullCursor;
  cursorAfter: PullCursor;
  /** Newest server timestamp observed this operation (or already known), for the caller's lastServerObservedAt aggregation (§3.3). */
  newestServerTimestamp: string | null;
  /** True if a page fetch (or a per-row apply) failed and the operation stopped early. A fact, not a retry decision — see the module header. */
  stoppedEarlyDueToFailure: boolean;
  failureError: string | null;
}

const CONFLICT_REASONS: ReadonlySet<ConflictReason> = new Set([
  'tier1_incoming_wins_live',
  'tier1_incoming_wins_tombstone',
  'tier1_local_wins',
  'repeated_conflict_escalation',
  'tier1_exact_tie',
]);

/**
 * Runs one full pull operation for one table: reads the current
 * cursor, requests successive pages (page size mirrors the push batch
 * size, §7.2's "same order of magnitude"), applies every row via
 * `applyPulledRow`, and advances the persisted cursor once a page is
 * fully applied without error. Stops — without advancing past the
 * failed page — on the first page-fetch failure or per-row apply
 * exception, per §7.2's "a page that is only partially applied...
 * leaves the persisted cursor at its previous value."
 *
 * `nowServerTimestamp` must be server-derived (INV-4) — supplied once
 * by the caller for the whole operation (e.g. the table's own
 * `lastServerObservedAt`, or the freshest cross-table value the
 * Scheduler is tracking).
 *
 * `maxPages` is a defensive safety valve only (default 1000, not a
 * spec requirement) — guards against an infinite loop if a transport
 * implementation never correctly reports `isLastPage`.
 */
export async function runPullOperation(
  store: PullRecordStore,
  transport: PullTransport,
  nowServerTimestamp: string,
  config: SyncConfig = getSyncConfig(),
  maxPages = 1000,
): Promise<PullOperationResult> {
  const cursorBefore = await store.getCursor();
  let cursor = cursorBefore;
  let newestServerTimestamp = await store.getLastServerObservedAt();

  let pagesProcessed = 0;
  let rowsProcessed = 0;
  let appliedCount = 0;
  let purgedCount = 0;
  let keptLocalCount = 0;
  let ignoredCount = 0;
  let tieUnresolvedCount = 0;
  let escalatedCount = 0;
  const byReason: Partial<Record<ConflictReason, number>> = {};
  let conflictTotal = 0;
  let stoppedEarlyDueToFailure = false;
  let failureError: string | null = null;

  while (pagesProcessed < maxPages) {
    let result: PullTransportResult;
    try {
      result = await transport.fetchPage(cursor, config.pushBatchSize);
    } catch (err) {
      result = { kind: 'failure', error: err instanceof Error ? err.message : String(err) };
    }

    if (result.kind === 'failure') {
      reportNetworkFailure();
      stoppedEarlyDueToFailure = true;
      failureError = result.error;
      break;
    }
    reportNetworkSuccess();

    const { rows, isLastPage } = result.page;

    let pageFailed = false;
    let pageNewestTimestamp: string | null = null;
    for (const row of rows) {
      try {
        const { action, reason } = await applyPulledRow(row, store, nowServerTimestamp, config);
        rowsProcessed += 1;
        if (action === 'apply_incoming') appliedCount += 1;
        else if (action === 'purge') purgedCount += 1;
        else if (action === 'keep_local') keptLocalCount += 1;
        else if (action === 'escalate_tier2') escalatedCount += 1;
        else if (action === 'tie_unresolved') tieUnresolvedCount += 1;
        else ignoredCount += 1; // ignore_incoming, ignore_orphan_tombstone

        if (CONFLICT_REASONS.has(reason)) {
          conflictTotal += 1;
          byReason[reason] = (byReason[reason] ?? 0) + 1;
        }

        if (!pageNewestTimestamp || new Date(row.updatedAt).getTime() > new Date(pageNewestTimestamp).getTime()) {
          pageNewestTimestamp = row.updatedAt;
        }
      } catch (err) {
        pageFailed = true;
        failureError = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    if (pageFailed) {
      stoppedEarlyDueToFailure = true;
      break;
    }

    pagesProcessed += 1;

    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      cursor = { updatedAt: last.updatedAt, id: last.id };
      await store.advanceCursor(cursor);
    }

    if (pageNewestTimestamp && (!newestServerTimestamp || new Date(pageNewestTimestamp).getTime() > new Date(newestServerTimestamp).getTime())) {
      newestServerTimestamp = pageNewestTimestamp;
      await store.setLastServerObservedAt(newestServerTimestamp);
    }

    if (isLastPage) break;
  }

  return {
    pagesProcessed,
    rowsProcessed,
    appliedCount,
    purgedCount,
    keptLocalCount,
    ignoredCount,
    tieUnresolvedCount,
    escalatedCount,
    conflictTally: { total: conflictTotal, byReason },
    cursorBefore,
    cursorAfter: cursor,
    newestServerTimestamp,
    stoppedEarlyDueToFailure,
    failureError,
  };
}
