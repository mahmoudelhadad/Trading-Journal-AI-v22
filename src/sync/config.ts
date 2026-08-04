// Sync Engine operational configuration — SYNC_ARCHITECTURE_SPEC.md §14.
//
// These values are load-bearing for data-safety behavior (they determine
// what silently auto-resolves vs. what requires human review) and per §14
// must not be reachable ONLY by shipping a new client build. `DEFAULT_SYNC_CONFIG`
// below is the hardcoded fallback the spec explicitly sanctions; `getSyncConfig()`
// is the single call site the rest of the sync engine uses, so that swapping in a
// real remote-config source (Phase 8) touches only this file's implementation,
// not its callers.

export interface SyncConfig {
  /** §8.2 rule 3, §9.2 — how long a cloud tombstone is retained before permanent purge. */
  tombstoneRetentionDays: number;
  /** §8.2 rule 2 — global (all four tables) Tier-1-eligible conflict count in one cycle that escalates to Tier 2. */
  tier2ConflictVolumeThreshold: number;
  /** §8.1, §8.2 rule 4 — number of Tier 1 auto-resolutions for the same record within the window that escalates it to Tier 2. */
  repeatedConflictThreshold: number;
  /** §8.1, §8.2 rule 4 — rolling window (hours) the above count is evaluated over. Server-derived time only (INV-4). */
  repeatedConflictWindowHours: number;
  /** §10 — consecutive ambiguous (timeout/malformed) failures for the same batch composition before bisection begins without a definitive per-row signal. */
  ambiguousFailureEscalationCount: number;
  /** §10 — max records per push request/transaction. */
  pushBatchSize: number;
  /** §10 — exponential backoff starting interval (ms), per record. */
  backoffInitialMs: number;
  /** §10 — exponential backoff ceiling (ms), per record. */
  backoffCapMs: number;
  /** §6.3 — periodic full push/pull cycle interval (ms), leader tab, while online. */
  periodicSyncIntervalMs: number;
  /** §3.2 — max ms a device clock may run ahead of the last server-derived reference before `localUpdatedAt` is clamped. */
  clockSanityToleranceMs: number;
}

// Defaults mirror the §14 table exactly. Where the spec gives a range
// ("push batch size 200–500", "periodic sync interval 2–5 min"), the value
// chosen here is a starting point within that range, not a reinterpretation
// of the range itself — §10/§6.3 both call these values "tuned empirically."
export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  tombstoneRetentionDays: 90,
  tier2ConflictVolumeThreshold: 10,
  repeatedConflictThreshold: 3,
  repeatedConflictWindowHours: 24,
  ambiguousFailureEscalationCount: 3,
  pushBatchSize: 300,
  backoffInitialMs: 2_000,
  backoffCapMs: 60_000,
  periodicSyncIntervalMs: 3 * 60 * 1000,
  clockSanityToleranceMs: 5 * 60 * 1000,
};

/**
 * Single call site for sync-config values used throughout `src/sync/`.
 * Returns the hardcoded default today. Phase 8 (§14) replaces this
 * implementation with a fetched/remote-config-backed value, falling back
 * to `DEFAULT_SYNC_CONFIG` when the fetch itself fails while offline —
 * callers do not change.
 */
export function getSyncConfig(): SyncConfig {
  return DEFAULT_SYNC_CONFIG;
}
