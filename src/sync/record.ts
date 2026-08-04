// Local sync-record model — SYNC_ARCHITECTURE_SPEC.md §3.1, §3.2.
//
// PERMANENT NAMING INVARIANT — `syncId` <-> cloud `id`:
//
//   The spec's `id` field (§3.2: "the record's cloud-side primary key,
//   and the tie-breaker half of the compound cursor", §7.2, INV-5) is
//   always the CLOUD row's primary key. Locally it is represented as
//   `syncId`, never as a property literally named `id` — because `id`
//   is already a pre-existing, unrelated business field on `Account`
//   (the natural business key, mapped to the cloud `local_id` column,
//   used for local account matching/lookup throughout the app; see
//   §3.2's "Record identity" note and §10). Using one distinct name
//   uniformly across all four record types (trades, accounts, lists,
//   settings) avoids that collision and keeps the local record model
//   consistent across every table — the same move the spec itself
//   makes when it renames this identical concept to `cursorId` inside
//   the local `sync_cursors` store (§3.3).
//
//   This mapping holds for every later phase:
//     - Every push (serialization to Supabase, §10) maps `syncId -> id`.
//     - Every pull (deserialization from Supabase, §7) maps `id -> syncId`.
//     - `Account.id` remains exclusively the business identifier
//       (`local_id` on the cloud side) and never participates in
//       cursor ordering (§7.2) or sync record identity.
//     - No code outside src/sync/ may reference the cloud `id` column
//       directly — every other module works with `syncId`.
//   The Push/Pull Managers (§10, §7 — built in Phase 4c/4d) are the
//   concrete implementation of this mapping; this file is the single
//   place the invariant itself is documented.

export type SyncStatus = 'synced' | 'dirty' | 'pending_delete' | 'syncing';

// The full §3.2 metadata field set, required on every record —
// collection row or singleton — regardless of table.
export interface SyncMetadata {
  syncId: string;
  syncStatus: SyncStatus;
  localUpdatedAt: string;
  baseUpdatedAt: string | null;
  deletedAt: string | null;
  consecutiveFailures: number;
  nextEligibleAttemptAt: string | null;
  lastError: string | null;
  conflictResolutionLog: string[];
}

// A stamped collection element (trades, accounts): business content
// plus metadata, flattened onto one object — §3.1's "each row is its
// own record with its own sync state."
export type Stamped<T> = T & SyncMetadata;

// A stamped singleton (lists, settings): §3.1's "the whole object is
// one record with one sync state" — business content lives under
// `data`, sitting alongside the same metadata fields used everywhere
// else, so the record model is uniform across all four tables.
export type SingletonRecord<T> = SyncMetadata & { data: T };

/**
 * Fresh metadata for a record with no prior sync history — the shape
 * produced by the Step 3 stamping pass (src/sync/stamp.ts) for an
 * existing pre-sync record, and by a hook's own initializer when a
 * singleton record doesn't exist yet at all (§6.1's "User creates a
 * record" -> `dirty` transition).
 */
export function createSyncMetadata(now: string = new Date().toISOString()): SyncMetadata {
  return {
    syncId: crypto.randomUUID(),
    syncStatus: 'dirty',
    localUpdatedAt: now,
    baseUpdatedAt: null,
    deletedAt: null,
    consecutiveFailures: 0,
    nextEligibleAttemptAt: null,
    lastError: null,
    conflictResolutionLog: [],
  };
}

/** True if `value` already carries the full sync metadata shape. */
export function isStamped(value: unknown): value is SyncMetadata {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).syncId === 'string' &&
    typeof (value as Record<string, unknown>).syncStatus === 'string'
  );
}

/**
 * Refresh a record for a fresh local write — the same transition as
 * §6.1's "user edits" -> `dirty`. Preserves `syncId`, `baseUpdatedAt`,
 * and every backoff/error/conflict-log field exactly as they were:
 * §10 resets backoff only on a push *success*, never on an edit, so
 * this must not reset it either. Only `syncStatus` and
 * `localUpdatedAt` change. `deletedAt` decides the target status,
 * mirroring the startup-reconciliation rule (§6.1): a record that was
 * mid-delete stays targeting `pending_delete`, not `dirty`.
 */
export function refreshForLocalWrite(
  metadata: SyncMetadata,
  now: string = new Date().toISOString(),
): SyncMetadata {
  return {
    ...metadata,
    syncStatus: metadata.deletedAt ? 'pending_delete' : 'dirty',
    localUpdatedAt: now,
  };
}

/**
 * Stamp a record arriving from outside the normal hook mutation path
 * (Restore Points / Backup restore, CSV/Excel import) for a fresh
 * local write. Two cases, distinguished by whether the incoming value
 * already carries sync identity:
 *   - Already stamped (restoring a record that previously went through
 *     this app, or re-importing one): refreshed in place via
 *     `refreshForLocalWrite` — same `syncId`, same `baseUpdatedAt`, so
 *     it's recognized as the same logical record and Tier 1 conflict
 *     detection compares it against the correct cloud row.
 *   - Not yet stamped (a genuinely external record — a CSV/Excel row,
 *     or a backup taken before this app had sync metadata at all):
 *     treated as a brand-new record (§6.1: "User creates a record" ->
 *     `dirty`), given fresh metadata including a NEW `syncId`.
 */
export function stampIncomingRecord<T extends object>(
  item: T,
  now: string = new Date().toISOString(),
): T & SyncMetadata {
  if (isStamped(item)) {
    return { ...item, ...refreshForLocalWrite(item, now) };
  }
  return { ...createSyncMetadata(now), ...item };
}
