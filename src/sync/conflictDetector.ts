// Conflict Detector — SYNC_ARCHITECTURE_SPEC.md §5.2, §7.3, §8, §9.2a.
//
// Pure decision layer: every export here is a pure function over
// plain in-memory values. Nothing in this file reads or writes
// LocalStorage/IndexedDB, calls Supabase, or holds mutable state.
// Re-evaluation happens fresh, per record, at apply time (§7.3) —
// this module has no cache and no memory of prior calls, which is
// what makes that requirement trivially true rather than something a
// caller has to get right.
//
// SCOPE BOUNDARY: this module decides WHAT should happen to a
// record's *sync metadata* (which of the four fields below change,
// and to what), never HOW a full local record is materialized.
// Constructing a brand-new local record's `syncId`/`localUpdatedAt`
// when nothing existed locally before, actually writing to storage,
// and looking up which local record (if any) corresponds to a given
// incoming pulled row (by natural business key or `syncId`, per
// record.ts's naming invariant) are all Pull Manager responsibilities
// (Phase 4d) — this module is only ever handed an already-paired
// (local, incoming) input.
//
// PATCH CONTRACT (same convention as backoff.ts): every decision
// returns a `metadataPatch` — a partial object covering only
// `syncStatus`/`baseUpdatedAt`/`deletedAt`/`conflictResolutionLog` —
// never a complete record. Callers merge it onto an existing stamped
// record (or, when `local` was `null`, use it as the metadata half of
// a newly-materialized one). This module never constructs or owns a
// complete record — there remains exactly one record representation
// in this codebase (SyncMetadata / Stamped<T> / SingletonRecord<T> in
// record.ts).
//
// SERVER-DERIVED TIME ONLY (INV-4): every timestamp parameter below
// that participates in a sync-correctness comparison (conflict
// resolution, the repeated-conflict window, the retention-window
// check) is a REQUIRED parameter with no default — unlike
// backoff.ts's local-bookkeeping timestamps, which may legitimately
// default to the local clock, nothing in this file may ever read
// `Date.now()` or `new Date()` itself. Callers must supply a
// server-derived value (an incoming row's `updated_at`, or
// `lastServerObservedAt` from sync_cursors, §3.3).

import { getSyncConfig, type SyncConfig } from '@sync/config.js';
import type { SyncMetadata, SyncStatus } from '@sync/record.js';

// ─── Types ───────────────────────────────────────────────────

/** The subset of a local record's metadata this module needs to read. */
export type LocalRecordSyncState = Pick<
  SyncMetadata,
  'syncStatus' | 'baseUpdatedAt' | 'localUpdatedAt' | 'deletedAt' | 'conflictResolutionLog'
>;

/** The subset of an incoming pulled row this module needs to read. */
export interface IncomingPulledRecord {
  /** The cloud row's `updated_at`. */
  updatedAt: string;
  /** Whether the cloud row's `deleted_at` is set (§9). */
  isTombstone: boolean;
}

export type ConflictAction =
  | 'apply_incoming' // materialize/overwrite local content with incoming; record becomes `synced`
  | 'purge' // remove the local record entirely (tombstone applied, nothing survives)
  | 'ignore_incoming' // no-op: base already matches incoming, local dirty edit is untouched
  | 'ignore_orphan_tombstone' // no local record, incoming is a tombstone: do nothing (§9.2a)
  | 'keep_local' // Tier 1 local wins: content stays local, baseUpdatedAt advances
  | 'escalate_tier2' // repeated-conflict threshold exceeded for this record (§8.2 rule 4)
  | 'tie_unresolved'; // incoming and local are exactly equally recent — §8.1 defines no outcome for this; NOT auto-resolved here (see evaluateIncomingRecord's doc)

export type ConflictReason =
  | 'no_local_record_live'
  | 'no_local_record_tombstone'
  | 'local_synced_live'
  | 'local_synced_tombstone'
  | 'base_matches_no_conflict'
  | 'tier1_incoming_wins_live'
  | 'tier1_incoming_wins_tombstone'
  | 'tier1_local_wins'
  | 'repeated_conflict_escalation'
  | 'tier1_exact_tie';

/** Partial metadata patch — never a complete record. See file header. */
export type SyncMetadataPatch = Partial<
  Pick<SyncMetadata, 'syncStatus' | 'baseUpdatedAt' | 'deletedAt' | 'conflictResolutionLog'>
>;

export interface ConflictResolution {
  action: ConflictAction;
  reason: ConflictReason;
  metadataPatch: SyncMetadataPatch;
}

// ─── conflictResolutionLog helpers ──────────────────────────────

/**
 * Drop entries older than the repeated-conflict window, relative to
 * `nowServerTimestamp` (must be server-derived — INV-4). Entries are
 * themselves server-derived timestamps (§3.2), so this comparison
 * never touches the local clock either.
 */
export function pruneConflictLog(
  log: readonly string[],
  nowServerTimestamp: string,
  config: SyncConfig = getSyncConfig(),
): string[] {
  const cutoff = new Date(nowServerTimestamp).getTime() - config.repeatedConflictWindowHours * 60 * 60 * 1000;
  return log.filter((entry) => new Date(entry).getTime() >= cutoff);
}

/**
 * Append a new Tier 1 resolution's triggering timestamp to the log
 * and prune in the same step — §3.2/§8.1: "Whenever an entry is
 * appended, entries older than the repeated-conflict window are
 * pruned from the list in the same write."
 */
export function appendConflictLogEntry(
  log: readonly string[],
  incomingUpdatedAt: string,
  nowServerTimestamp: string,
  config: SyncConfig = getSyncConfig(),
): string[] {
  return pruneConflictLog([...log, incomingUpdatedAt], nowServerTimestamp, config);
}

// ─── Tier 1 — per-record evaluation (§8.1, §9.2a) ───────────────

/**
 * The single per-record entry point. Given the local record's current
 * sync state (or `null` if no local record exists for this key) and
 * an incoming pulled row, returns exactly one deterministic decision.
 *
 * `nowServerTimestamp` must be server-derived (INV-4) — typically the
 * incoming record's own `updatedAt`, or the table's
 * `lastServerObservedAt` (§3.3), whichever is more current. It is
 * used only to prune/evaluate `conflictResolutionLog` against the
 * repeated-conflict window (§8.1, §8.2 rule 4) — never for the Tier 1
 * newer/older comparison itself, which compares two already-supplied
 * server/local timestamps directly.
 *
 * POLICY BOUNDARY — exact ties are NOT resolved here: §8.1 defines
 * only two outcomes, "incoming is newer" and "local is newer." It
 * does not define a policy for `incoming.updatedAt` and
 * `local.localUpdatedAt` being exactly equally recent. Rather than
 * this module silently picking a winner for a case the specification
 * never decided, an exact tie is surfaced as its own explicit outcome
 * — `action: 'tie_unresolved'` — and returned untouched (no metadata
 * change, no conflictResolutionLog entry, since nothing was actually
 * resolved). Choosing what to do with a tie (favor local, favor
 * incoming, escalate to Tier 2, something else) is left entirely to
 * the caller (Pull Manager / Scheduler, Phase 4d/4f).
 *
 * ASSUMPTIONS made where the specification is silent (flagged, not
 * silently decided — see the accompanying implementation report):
 *   1. `pending_delete` local records: §8.1's conflict-existence
 *      condition and §9.2a's bullets literally enumerate only `dirty`
 *      and `syncing` as eligible local states. A `pending_delete`
 *      record IS an unsynced local change in every other sense this
 *      document uses that phrase (it is part of the pending queue,
 *      §3.2), so this implementation extends Tier 1 eligibility to
 *      `pending_delete` as well, and reuses the exact `deletedAt ?
 *      'pending_delete' : 'dirty'` branch the specification itself
 *      already uses for startup reconciliation (§6.1) to decide the
 *      "local wins" target status, rather than inventing new
 *      resolution semantics. This is the module's one genuine
 *      extension beyond literal text; everything else below is a
 *      direct implementation of §8.1/§9.2a/§6.1's transition table.
 */
export function evaluateIncomingRecord(
  local: LocalRecordSyncState | null,
  incoming: IncomingPulledRecord,
  nowServerTimestamp: string,
  config: SyncConfig = getSyncConfig(),
): ConflictResolution {
  // No local record at all (§9.2a bullet 3 / ordinary first-time pull).
  if (local === null) {
    if (incoming.isTombstone) {
      return { action: 'ignore_orphan_tombstone', reason: 'no_local_record_tombstone', metadataPatch: {} };
    }
    return {
      action: 'apply_incoming',
      reason: 'no_local_record_live',
      metadataPatch: { syncStatus: 'synced', baseUpdatedAt: incoming.updatedAt, deletedAt: null },
    };
  }

  // Local has no unsynced change (§6.1 "synced" rows; §9.2a bullet 1).
  if (local.syncStatus === 'synced') {
    if (incoming.isTombstone) {
      return { action: 'purge', reason: 'local_synced_tombstone', metadataPatch: {} };
    }
    return {
      action: 'apply_incoming',
      reason: 'local_synced_live',
      metadataPatch: { syncStatus: 'synced', baseUpdatedAt: incoming.updatedAt, deletedAt: null },
    };
  }

  // Local has an unsynced change: dirty | syncing | pending_delete (assumption 1 above).
  if (incoming.updatedAt === local.baseUpdatedAt) {
    // §8.1: "If syncStatus is dirty but the incoming updated_at equals
    // baseUpdatedAt, there is no conflict — the cloud hasn't moved."
    // Nothing to apply; the local unsynced change is left untouched.
    return { action: 'ignore_incoming', reason: 'base_matches_no_conflict', metadataPatch: {} };
  }

  const incomingTime = new Date(incoming.updatedAt).getTime();
  const localTime = new Date(local.localUpdatedAt).getTime();

  // Exact tie — see the POLICY BOUNDARY note above. Checked BEFORE the
  // repeated-conflict log is touched: a tie is explicitly not a
  // "resolution" (§8.1's log is "one entry per Tier 1 auto-resolution"
  // — nothing was auto-resolved here), so it must not consume the
  // repeated-conflict budget or appear in the log at all.
  if (incomingTime === localTime) {
    return { action: 'tie_unresolved', reason: 'tier1_exact_tie', metadataPatch: {} };
  }

  // Genuine, resolvable Tier 1 conflict. Update the repeated-conflict
  // log first — §8.1: "every Tier 1 resolution appends... in the same
  // write" — then decide whether this occurrence itself must escalate
  // (§8.2 rule 4) instead of auto-resolving.
  const updatedLog = appendConflictLogEntry(local.conflictResolutionLog, incoming.updatedAt, nowServerTimestamp, config);
  if (updatedLog.length > config.repeatedConflictThreshold) {
    return {
      action: 'escalate_tier2',
      reason: 'repeated_conflict_escalation',
      metadataPatch: { conflictResolutionLog: updatedLog },
    };
  }

  const incomingIsNewer = incomingTime > localTime;

  if (incomingIsNewer) {
    if (incoming.isTombstone) {
      return {
        action: 'purge',
        reason: 'tier1_incoming_wins_tombstone',
        metadataPatch: { conflictResolutionLog: updatedLog },
      };
    }
    return {
      action: 'apply_incoming',
      reason: 'tier1_incoming_wins_live',
      metadataPatch: {
        syncStatus: 'synced',
        baseUpdatedAt: incoming.updatedAt,
        deletedAt: null,
        conflictResolutionLog: updatedLog,
      },
    };
  }

  // Local wins: content stays local; baseUpdatedAt still advances so
  // the next push targets the correct base (§8.1, §6.1). Target
  // status mirrors the startup-reconciliation branch (§6.1) rather
  // than always forcing `dirty`, so a local delete-in-flight is not
  // silently turned back into an ordinary edit (assumption 1 above).
  return {
    action: 'keep_local',
    reason: 'tier1_local_wins',
    metadataPatch: {
      syncStatus: local.deletedAt ? 'pending_delete' : 'dirty',
      baseUpdatedAt: incoming.updatedAt,
      conflictResolutionLog: updatedLog,
    },
  };
}

// ─── Tier 2 — structural escalation rules (§8.2) ────────────────

/**
 * Escalation rule 1 — "First sync": a table's cursor has never been
 * initialized on this device AND the local database already contains
 * one or more records for that table with `baseUpdatedAt = null`.
 * Both inputs are pre-computed by the caller (Pull Manager, Phase
 * 4d) — this module never queries local storage.
 */
export function evaluateFirstSyncEscalation(input: {
  cursorInitialized: boolean;
  hasRecordsWithNullBaseUpdatedAt: boolean;
}): boolean {
  return !input.cursorInitialized && input.hasRecordsWithNullBaseUpdatedAt;
}

/**
 * Escalation rule 2 — "Conflict volume": a single pull cycle produces
 * more than the configured threshold of Tier-1-eligible conflicts,
 * counted globally across all four tables and accumulated across
 * every page (§8.2: "never evaluated per page"). The caller is
 * responsible for maintaining `cycleConflictCount` — incrementing it
 * once per `evaluateIncomingRecord` call whose result was a genuine
 * conflict (`tier1_incoming_wins_*`, `tier1_local_wins`,
 * `escalate_tier2`, or `tie_unresolved` — a tie is still a Tier-1-
 * eligible conflict for volume-counting purposes, even though it
 * doesn't touch conflictResolutionLog), across the whole cycle, and
 * resetting it to zero only at the start of the next cycle.
 */
export function evaluateConflictVolumeEscalation(
  cycleConflictCount: number,
  config: SyncConfig = getSyncConfig(),
): boolean {
  return cycleConflictCount > config.tier2ConflictVolumeThreshold;
}

export type RetentionWindowStatus = 'expired' | 'not_expired' | 'unknown';

/**
 * Escalation rule 3 — "Expired retention window": server-derived time
 * only (INV-4) — `lastServerObservedAt - cursorUpdatedAt > retention
 * window`. Neither side of this comparison is a "now" value; it is
 * the gap between two already-recorded server timestamps.
 *
 * POLICY BOUNDARY: returns `'unknown'`, never `'not_expired'`, when no
 * server-derived reference exists yet this session
 * (`lastServerObservedAt === null`) — §8.2: "the table's staleness is
 * treated as unknown, not as 'definitely fine.'" This module does
 * nothing further with that fact. It does NOT treat `'unknown'` as
 * safe (that would silently violate §8.2), and it does NOT treat
 * `'unknown'` as expired/escalate on its behalf either — doing either
 * would be this module embedding a policy decision the specification
 * never assigned to the Conflict Detector. `'unknown'` is returned as
 * its own explicit state precisely so that decision stays entirely
 * with the caller (Pull Manager / Scheduler, Phase 4d/4f), which is
 * also where the cross-table nature of `lastServerObservedAt` (§3.3)
 * and the re-evaluation-on-every-cycle behavior naturally belong.
 */
export function evaluateRetentionWindowEscalation(
  lastServerObservedAt: string | null,
  cursorUpdatedAt: string | null,
  config: SyncConfig = getSyncConfig(),
): RetentionWindowStatus {
  if (lastServerObservedAt === null) return 'unknown';
  // An uninitialized cursor is not this rule's concern (that is rule
  // 1's job) — treat it as not expired so the two rules don't overlap.
  if (cursorUpdatedAt === null) return 'not_expired';

  const gapMs = new Date(lastServerObservedAt).getTime() - new Date(cursorUpdatedAt).getTime();
  const retentionMs = config.tombstoneRetentionDays * 24 * 60 * 60 * 1000;
  return gapMs > retentionMs ? 'expired' : 'not_expired';
}
