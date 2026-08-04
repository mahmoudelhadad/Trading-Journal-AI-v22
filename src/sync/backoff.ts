// Retry/Backoff Controller — SYNC_ARCHITECTURE_SPEC.md §5.2, §10.
//
// Tracked strictly PER RECORD, never globally (§10: "each record's own
// consecutiveFailures and nextEligibleAttemptAt are durable fields on
// the record itself... A success on one record must never reset
// another, unrelated record's backoff state"). This module is pure
// functions only — it does not read or write any record itself; the
// Push Manager (Phase 4c) is what threads these through actual
// records. Deliberately has no dependency on any other part of
// src/sync/ besides the operational config (§14).
//
// CONTRACT: every function below (computeBackoffIntervalMs and
// computeNextEligibleAttemptAt aside, which are plain value
// computations) returns a PARTIAL metadata PATCH — never a complete
// record. `BackoffState` is a narrow projection of SyncMetadata
// (src/sync/record.ts), covering only the fields this controller
// manages; it is not, and must never become, an alternative record
// shape. This module never constructs or owns a complete record —
// callers are expected to merge a patch onto an existing stamped
// record, e.g. `{ ...record, ...applyBackoffFailure(record, err) }`.

import { getSyncConfig, type SyncConfig } from '@sync/config.js';

// The exact subset of SyncMetadata (src/sync/record.ts) this
// controller operates on. Defined locally rather than imported, so
// this module has no dependency on the record model — any object
// with these three fields (in particular, a real SyncMetadata) works.
export interface BackoffState {
  consecutiveFailures: number;
  nextEligibleAttemptAt: string | null;
  lastError: string | null;
}

/**
 * Exponential backoff interval for the Nth consecutive failure
 * (1-indexed), capped — §10: "2s -> 4s -> 8s -> ... -> 60s ceiling".
 * 0 (or negative) consecutive failures has no backoff.
 */
export function computeBackoffIntervalMs(
  consecutiveFailures: number,
  config: SyncConfig = getSyncConfig(),
): number {
  if (consecutiveFailures <= 0) return 0;
  const interval = config.backoffInitialMs * 2 ** (consecutiveFailures - 1);
  return Math.min(interval, config.backoffCapMs);
}

/** The earliest timestamp a record with this many consecutive failures may be retried. */
export function computeNextEligibleAttemptAt(
  consecutiveFailures: number,
  now: string = new Date().toISOString(),
  config: SyncConfig = getSyncConfig(),
): string | null {
  if (consecutiveFailures <= 0) return null;
  const intervalMs = computeBackoffIntervalMs(consecutiveFailures, config);
  return new Date(new Date(now).getTime() + intervalMs).toISOString();
}

/**
 * True if a record with this `nextEligibleAttemptAt` may be included
 * in a push batch right now (§10: "Batch assembly excludes any record
 * whose nextEligibleAttemptAt is still in the future").
 */
export function isEligibleNow(
  nextEligibleAttemptAt: string | null,
  now: string = new Date().toISOString(),
): boolean {
  if (nextEligibleAttemptAt === null) return true;
  return new Date(nextEligibleAttemptAt).getTime() <= new Date(now).getTime();
}

/**
 * Advance a record's backoff state after a push failure — increments
 * `consecutiveFailures`, recomputes `nextEligibleAttemptAt`, records
 * `lastError`. Only the failing record's own state is touched; the
 * caller is responsible for never applying this to any other record.
 */
export function applyBackoffFailure(
  current: Pick<BackoffState, 'consecutiveFailures'>,
  error: string,
  now: string = new Date().toISOString(),
  config: SyncConfig = getSyncConfig(),
): BackoffState {
  const consecutiveFailures = current.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    nextEligibleAttemptAt: computeNextEligibleAttemptAt(consecutiveFailures, now, config),
    lastError: error,
  };
}

/**
 * Reset a record's backoff state after a push SUCCESS — §10: "On push
 * success: ... consecutiveFailures/nextEligibleAttemptAt/lastError
 * are cleared." All three fields reset.
 */
export function resetBackoffOnSuccess(): BackoffState {
  return { consecutiveFailures: 0, nextEligibleAttemptAt: null, lastError: null };
}

/**
 * The `online` trigger's sanctioned backoff bypass (§6.3): "Clears
 * per-record backoff state first — consecutiveFailures reset to 0 and
 * nextEligibleAttemptAt to null for every record in the pending
 * queue." Deliberately narrower than resetBackoffOnSuccess() — it
 * does NOT touch `lastError`, since nothing has actually succeeded
 * yet; the record is only being made eligible for a fresh attempt.
 * The narrower return type (no `lastError` key) makes it impossible
 * for a caller to accidentally clear it via this path.
 */
export function bypassBackoffForOnlineTrigger(): Pick<
  BackoffState,
  'consecutiveFailures' | 'nextEligibleAttemptAt'
> {
  return { consecutiveFailures: 0, nextEligibleAttemptAt: null };
}
