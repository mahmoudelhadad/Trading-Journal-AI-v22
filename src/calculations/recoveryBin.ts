/**
 * calculations/recoveryBin.ts
 *
 * Phase 18 — Data Safety: Recovery Bin types and pure helpers.
 *
 * NEW module — no original-app equivalent (the original app's delete
 * operations were always immediate and permanent). Explicitly
 * pre-approved in the original migration plan's DATA SAFETY section:
 * *"Automatic Backups. Restore Points. Undo Delete. Soft Delete.
 * Recovery Bin."*
 *
 * SCOPE DECISION (documented, intentional — per this phase's "do not
 * redesign any existing UI" rule): this module — and the hook/
 * components built alongside it — implement a Recovery Bin as new,
 * standalone, opt-in architecture. `hooks/useTrades.ts`'s existing
 * `deleteTrade`/`deleteAllTrades` (Phase 2B, fixed Phase 7B) are NOT
 * modified to automatically soft-delete — doing so would change the
 * existing Raw page's delete workflow's actual behavior (what happens
 * when you click "Del"), which is out of scope here. This mirrors the
 * exact pattern established in Phases 8, 14, 15, and 17: build and
 * validate the capability, defer wiring it into an existing delete
 * flow to a future, explicitly-scoped phase.
 *
 * "Undo Delete" is treated as served by the Recovery Bin itself (the
 * most-recently-deleted item is simply the newest entry, immediately
 * available to restore) rather than a separate toast/snackbar system —
 * avoiding over-engineering two overlapping mechanisms for the same
 * underlying need, per your established "avoid over-engineering" rule.
 */

// ─── Types ───────────────────────────────────────────────────

export interface RecoveryBinEntry<T = unknown> {
  id:        string;
  deletedAt: number; // Date.now()
  /** A snapshot of the deleted item at the moment of deletion */
  item:      T;
  /** Human-readable label for display, e.g. a trade's symbol + date */
  label:     string;
}

// ─── Retention policy ────────────────────────────────────────

/**
 * How long a soft-deleted item remains in the Recovery Bin before it
 * becomes eligible for automatic purging.
 * ASSUMPTION: 30 days is a reasonable default retention window for a
 * trading journal (long enough to notice an accidental delete during
 * normal use, short enough to bound LocalStorage growth). Not
 * user-configurable in this phase — see MIGRATION_NOTES.md.
 */
export const RECOVERY_BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Determine whether a recovery bin entry has passed its retention
 * window and is eligible for automatic purging.
 * FORMULA: (now - entry.deletedAt) > RECOVERY_BIN_RETENTION_MS
 */
export function isExpired(entry: RecoveryBinEntry, now: number = Date.now()): boolean {
  return (now - entry.deletedAt) > RECOVERY_BIN_RETENTION_MS;
}

/**
 * Filter out expired entries from a recovery bin list.
 * Pure function — does not touch storage; callers persist the result.
 */
export function purgeExpiredEntries<T>(entries: RecoveryBinEntry<T>[], now: number = Date.now()): RecoveryBinEntry<T>[] {
  return entries.filter((e) => !isExpired(e, now));
}

// ─── Restore point types ────────────────────────────────────

export interface RestorePoint {
  id:        string;
  label:     string;
  createdAt: number;
  /** Full app-state snapshot — reuses BackupData from backupService.ts, not redefined here */
  backup:    unknown;
}

/**
 * Maximum number of restore points retained at once — oldest is
 * dropped when a new one is created beyond this cap.
 * ASSUMPTION: 10 is a reasonable default balancing usefulness (a
 * meaningful history of safety checkpoints) against LocalStorage
 * growth (each restore point contains a FULL backup of every tracked
 * key, so unbounded retention could grow significantly for a large
 * trade history). Not user-configurable in this phase.
 */
export const MAX_RESTORE_POINTS = 10;

/**
 * Add a new restore point to a list, enforcing the MAX_RESTORE_POINTS
 * cap by dropping the oldest entries first (FIFO).
 * Pure function — does not touch storage; callers persist the result.
 */
export function addRestorePoint(points: RestorePoint[], newPoint: RestorePoint): RestorePoint[] {
  const updated = [...points, newPoint];
  return updated.length > MAX_RESTORE_POINTS
    ? updated.slice(updated.length - MAX_RESTORE_POINTS)
    : updated;
}
