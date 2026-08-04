/**
 * services/backupService.ts
 *
 * Phase 16 — Settings: Full-app Backup & Restore.
 *
 * NEW service — no original-app equivalent (the original app had no
 * backup/restore feature at all). Explicitly pre-approved in the
 * original migration plan's SETTINGS section: *"Improve Settings.
 * Support: ... Backup, Restore, Import, Export."*
 *
 * CENTRALIZATION (per your rules 2 & 3 — keep business logic
 * centralized, do not duplicate storage logic): this service contains
 * ZERO new persistence logic. It is pure composition/orchestration —
 * every read and write goes through EXISTING load/save function pairs.
 * All 10 sections are covered: trades, accounts, lists, propRules,
 * settings, savedFilters, checklistTemplates, checklistCompletions,
 * customFieldDefs, customFieldValues. Adding an 11th in the future
 * requires only adding one line to BACKUP_SECTIONS below — this file
 * does not need to know HOW any given key is stored, only that a
 * load/save pair exists for it.
 *
 * PHASE 6g-1 — FOUR SECTIONS NOW GO THROUGH THE RESOLVER: `trades`,
 * `accounts`, `lists`, `settings` are read/written via
 * services/localDatabase.js instead of services/storage.js directly,
 * so a backup/restore reflects whichever local backend is currently
 * authoritative (§13 Step 6 sub-step 5) rather than being hard-wired to
 * LocalStorage. The other six sections (propRules, savedFilters,
 * checklists, custom fields) are untouched — they were never part of
 * the Step 6 migration and stay on services/storage.js exactly as
 * before. `restorePoints` (below) is likewise untouched — it is not
 * itself a backed-up section (see the Phase 20 audit note) and its own
 * load/save pair was never migrated.
 *
 * WHY BackupSection.load/save ARE NOW MaybePromise-TYPED, NOT PLAINLY
 * ASYNC: reuses src/sync/localStores.ts's own `MaybePromise` (Phase 6b)
 * rather than inventing an equivalent — the exact same "some sections
 * are sync, some are genuinely async, every caller awaits uniformly"
 * situation that type exists for. `buildBackup`/`restoreBackup` and
 * everything built on them are async as a result; every caller in this
 * codebase has been updated to await them (BackupPanel.tsx,
 * SyncConflictReview.tsx, useRestorePoints.ts, RestorePointsPanel.tsx,
 * SettingsModal.tsx).
 *
 * FIXED (gap-analysis G-7 / AN-014): `BackupSection.save: (data:
 * unknown) => MaybePromise<void>` was contravariantly unsound against
 * the specific `save*` functions assigned into BACKUP_SECTIONS (6 of
 * this project's 7 known `tsc` errors). `defineBackupSection()` below
 * localizes the necessary cast to ONE place instead of 6: each section
 * is still defined with its real, specific `load`/`save` pair (T
 * inferred per call), and the cast down to `BackupSection<unknown>`
 * happens once, at construction. This does not change WHAT is unsound
 * — `buildBackup`/`restoreBackup` genuinely can only treat `data` as
 * `unknown` at the generic per-section loop, since a restored value
 * originates from a parsed JSON file whose shape isn't statically
 * known (see restoreBackup's documented "unknown keys ignored" JSON
 * boundary policy below) — only WHERE the codebase admits it: one
 * documented boundary, not six raw compiler errors. Zero runtime
 * behavior change; type-level only.
 */

import {
  loadPropRules, savePropRules,
  loadSavedFilters, saveSavedFilters,
  loadChecklistTemplates, saveChecklistTemplates,
  loadChecklistCompletions, saveChecklistCompletions,
  loadCustomFieldDefs, saveCustomFieldDefs,
  loadCustomFieldValues, saveCustomFieldValues,
  loadRestorePoints, saveRestorePoints,
} from './storage.js';
import {
  loadTrades, saveTrades,
  loadAccounts, saveAccounts,
  loadLists, saveLists,
  loadSettings, saveSettings,
} from './localDatabase.js';
import {
  addRestorePoint, type RestorePoint,
} from '@calculations/recoveryBin.js';
import { nextId } from '@calculations/idGenerator.js';
import { stampIncomingRecord } from '@sync/record.js';
import type { MaybePromise } from '@sync/localStores.js';

// ─── Backup format ───────────────────────────────────────────

const BACKUP_VERSION = 1;

interface BackupSection<T = unknown> {
  key:  string;
  load: () => MaybePromise<T>;
  save: (data: T) => MaybePromise<void>;
  /**
   * Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 3
   * follow-up): transforms a restored value before it's written back,
   * for the sections whose records carry sync metadata (trades,
   * accounts, lists, settings — §3.2). A record restored verbatim
   * from an old snapshot could carry a stale `syncStatus: 'synced'`,
   * making it invisible to the future Push Manager's pending queue
   * (§3.2: pending queue is exactly `syncStatus IN (dirty,
   * pending_delete)`) even though the user just explicitly asked for
   * this content to come back. `stampIncomingRecord` (src/sync/
   * record.ts) fixes that by marking every restored record dirty
   * again with a fresh `localUpdatedAt`, while preserving its
   * `syncId`/`baseUpdatedAt` so it's still recognized as the same
   * logical record. Defaults to identity — sections with no sync
   * metadata (propRules, savedFilters, ...) restore verbatim, exactly
   * as before this fix.
   */
  reviveForRestore?: (data: unknown) => unknown;
}

const stampCollectionForRestore = (data: unknown): unknown =>
  Array.isArray(data) ? data.map((item) => stampIncomingRecord(item as object)) : data;

const stampSingletonForRestore = (data: unknown): unknown =>
  data && typeof data === 'object' ? stampIncomingRecord(data as object) : data;

/**
 * Constructs one `BackupSection<unknown>` entry from a specifically-
 * typed load/save/reviveForRestore triple, performing the single,
 * documented narrowing cast this file needs (see the file header's
 * "FIXED (gap-analysis G-7 / AN-014)" note) at construction time only.
 *
 * `L` (load's return) and `S` (save's parameter) are inferred
 * INDEPENDENTLY, not unified into one shared type parameter — because
 * they genuinely are not the same type for three sections:
 * `loadAccounts`/`loadLists`/`loadSettings` return `T | null` (nothing
 * saved yet), while `saveAccounts`/`saveLists`/`saveSettings` accept
 * non-null `T`. That's an existing, correct, real-world contract (an
 * empty/first-run local database has no saved accounts yet), not a
 * mismatch to unify away — `buildBackup()` stores whatever `load()`
 * returns, including null, into a generic `unknown` bag, and
 * `restoreBackup()` never feeds a `load()` result into `save()`
 * directly; the value `save()` receives always comes from a parsed
 * backup file. Every call site below still keeps its real, specific
 * function types, so a genuine typo pairing (e.g. accidentally passing
 * `saveAccounts` where `saveTrades` belongs) is still caught by `tsc`
 * at that call site, before the cast erases it.
 */
function defineBackupSection<L, S>(section: {
  key: string;
  load: () => MaybePromise<L>;
  save: (data: S) => MaybePromise<void>;
  reviveForRestore?: (data: unknown) => unknown;
}): BackupSection<unknown> {
  return section as unknown as BackupSection<unknown>;
}

/**
 * Every backed-up section, paired with its EXISTING load/save
 * functions. This is the single place a future key needs to be added
 * to be covered by backup/restore — no other file needs to change.
 *
 * PHASE 20 AUDIT NOTE (documented, not silently changed — see
 * MIGRATION_NOTES.md): this list deliberately does NOT include
 * RESTORE_POINTS or RECOVERY_BIN, for two different reasons:
 *   - RESTORE_POINTS is correctly excluded: including a snapshot of
 *     "all restore points" inside each restore point would be
 *     self-referential (restoring an old backup would overwrite your
 *     CURRENT restore-point list with a stale one, silently discarding
 *     any restore points created afterward). This exclusion is
 *     intentional and should remain.
 *   - RECOVERY_BIN's exclusion is a genuine, low-severity gap
 *     (classified as Technical Debt in the Phase 20 audit): if
 *     restored, an old backup would not bring back the Recovery Bin
 *     state as it was at that time. Currently has ZERO practical
 *     impact, since useTrades().deleteTrade is not yet connected to
 *     softDelete() (see AN-011) — the bin is always empty today. Worth
 *     revisiting in whichever future phase makes that connection.
 */
const BACKUP_SECTIONS: BackupSection<unknown>[] = [
  defineBackupSection({ key: 'trades',                load: loadTrades,                save: saveTrades,   reviveForRestore: stampCollectionForRestore }),
  defineBackupSection({ key: 'accounts',              load: loadAccounts,               save: saveAccounts, reviveForRestore: stampCollectionForRestore }),
  defineBackupSection({ key: 'lists',                 load: loadLists,                  save: saveLists,    reviveForRestore: stampSingletonForRestore }),
  defineBackupSection({ key: 'propRules',             load: loadPropRules,              save: savePropRules }),
  defineBackupSection({ key: 'settings',              load: loadSettings,               save: saveSettings, reviveForRestore: stampSingletonForRestore }),
  defineBackupSection({ key: 'savedFilters',          load: loadSavedFilters,           save: saveSavedFilters }),
  defineBackupSection({ key: 'checklistTemplates',    load: loadChecklistTemplates,     save: saveChecklistTemplates }),
  defineBackupSection({ key: 'checklistCompletions',  load: loadChecklistCompletions,   save: saveChecklistCompletions }),
  defineBackupSection({ key: 'customFieldDefs',       load: loadCustomFieldDefs,        save: saveCustomFieldDefs }),
  defineBackupSection({ key: 'customFieldValues',     load: loadCustomFieldValues,      save: saveCustomFieldValues }),
];

export interface BackupData {
  version:     number;
  exportedAt:  string; // ISO timestamp
  data:        Record<string, unknown>;
}

// ─── Export ──────────────────────────────────────────────────

/**
 * Build a full backup object by calling every existing load* function.
 * Pure function — does not touch the DOM or trigger a download itself
 * (see downloadBackup() for that), so it's independently testable.
 */
export async function buildBackup(): Promise<BackupData> {
  const data: Record<string, unknown> = {};
  for (const section of BACKUP_SECTIONS) {
    data[section.key] = await section.load();
  }
  return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
}

/**
 * Trigger a browser download of a full backup as a JSON file.
 * Filename convention: trading_journal_backup_{YYYY-MM-DD}.json
 */
export async function downloadBackup(): Promise<void> {
  const backup = await buildBackup();
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trading_journal_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Restore ─────────────────────────────────────────────────

export interface RestoreResult {
  success:        boolean;
  error?:         string;
  restoredKeys?:  string[];
}

/**
 * Validate and apply a backup object, writing each section via its
 * EXISTING save* function.
 * VALIDATION: the backup must have a numeric `version` and an object
 *          `data`. Unknown keys in `data` (e.g. from a newer app
 *          version) are silently ignored, not treated as an error —
 *          this keeps older app versions able to restore a subset of
 *          a newer backup rather than failing outright. Missing keys
 *          (e.g. from an older backup) simply leave that section
 *          untouched, not cleared.
 * EDGE CASES: Returns {success:false, error} for malformed JSON or a
 *          backup object missing the expected top-level shape, without
 *          writing anything (all-or-nothing validation before any
 *          write occurs).
 */
export async function restoreBackup(raw: unknown): Promise<RestoreResult> {
  if (!raw || typeof raw !== 'object') {
    return { success: false, error: 'Invalid backup file: not a JSON object.' };
  }
  const backup = raw as Partial<BackupData>;
  if (typeof backup.version !== 'number' || !backup.data || typeof backup.data !== 'object') {
    return { success: false, error: 'Invalid backup file: missing version or data.' };
  }

  const restoredKeys: string[] = [];
  for (const section of BACKUP_SECTIONS) {
    if (Object.prototype.hasOwnProperty.call(backup.data as object, section.key)) {
      const raw = (backup.data as Record<string, unknown>)[section.key];
      await section.save(section.reviveForRestore ? section.reviveForRestore(raw) : raw);
      restoredKeys.push(section.key);
    }
  }

  return { success: true, restoredKeys };
}

/**
 * Parse a raw JSON string (e.g. from a file upload) and restore it.
 * Wraps JSON.parse errors into the same RestoreResult shape as
 * restoreBackup(), so callers only need to handle one error path.
 */
export async function restoreBackupFromJSON(jsonText: string): Promise<RestoreResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { success: false, error: 'Could not parse file as JSON.' };
  }
  return restoreBackup(parsed);
}

// ─── Phase 18: Restore Points ─────────────────────────────────
//
// A "restore point" is a NAMED, IN-APP-STORED snapshot — conceptually
// the same data as a downloaded backup file, but kept inside
// LocalStorage itself (under STORAGE_KEYS.RESTORE_POINTS) so the user
// can revert to it without leaving the app or managing a file. This
// section contains ZERO new snapshot-building or snapshot-applying
// logic of its own: `createRestorePoint()` calls the EXISTING
// `buildBackup()` (above), and `restoreFromPoint()` calls the EXISTING
// `restoreBackup()` (above) — both already validated in Phase 16. This
// is pure orchestration over the SAME functions "Automatic Backups"
// and manual Backup/Restore already use, per your "keep business logic
// centralized, do not duplicate" rules.

/**
 * Create a new restore point from the CURRENT app state.
 * Reuses buildBackup() — no new snapshot logic.
 * Enforces the MAX_RESTORE_POINTS cap via addRestorePoint()
 * (calculations/recoveryBin.ts) — oldest points are dropped first.
 */
export async function createRestorePoint(label: string): Promise<RestorePoint> {
  const point: RestorePoint = {
    id: nextId('restore'),
    label: label || 'Restore Point',
    createdAt: Date.now(),
    backup: await buildBackup(),
  };
  const existing = loadRestorePoints() as RestorePoint[];
  saveRestorePoints(addRestorePoint(existing, point));
  return point;
}

/** List all saved restore points, most-recently-created not guaranteed sorted — callers sort as needed. */
export function listRestorePoints(): RestorePoint[] {
  return loadRestorePoints() as RestorePoint[];
}

/**
 * Restore the app to a previously saved restore point.
 * Reuses restoreBackup() — no new restoration logic.
 */
export async function restoreFromPoint(pointId: string): Promise<RestoreResult> {
  const points = loadRestorePoints() as RestorePoint[];
  const point = points.find((p) => p.id === pointId);
  if (!point) return { success: false, error: 'Restore point not found.' };
  return restoreBackup(point.backup);
}

/** Delete a single restore point by id. */
export function deleteRestorePoint(pointId: string): void {
  const points = loadRestorePoints() as RestorePoint[];
  saveRestorePoints(points.filter((p) => p.id !== pointId));
}

/**
 * Minimum time between automatic backups, in milliseconds.
 * ASSUMPTION: 24 hours is a reasonable default — frequent enough to
 * catch a day's worth of changes, infrequent enough to avoid quickly
 * filling the MAX_RESTORE_POINTS cap with near-duplicate snapshots
 * from a single session. Not user-configurable in this phase.
 */
export const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Create an automatic restore point IF enough time has passed since
 * the most recent auto-generated one. Intended to be called on app
 * startup (once wired into a future phase's App Shell — see the
 * "not wired in" scope note at the top of this file's Phase 18
 * additions).
 *
 * CENTRALIZATION: reuses createRestorePoint() directly — an automatic
 * backup IS a restore point (same data shape, same storage, same
 * MAX_RESTORE_POINTS cap), just created on a timer instead of by a
 * user click, distinguished only by its label prefix ("Auto: ").
 * Zero duplicated snapshot logic.
 *
 * @returns The newly created restore point, or null if the interval hasn't elapsed yet.
 */
export async function maybeCreateAutoBackup(): Promise<RestorePoint | null> {
  const points = loadRestorePoints() as RestorePoint[];
  const lastAuto = points
    .filter((p) => p.label.startsWith('Auto: '))
    .reduce<RestorePoint | null>((latest, p) => (!latest || p.createdAt > latest.createdAt ? p : latest), null);

  if (lastAuto && (Date.now() - lastAuto.createdAt) < AUTO_BACKUP_INTERVAL_MS) {
    return null;
  }

  return createRestorePoint(`Auto: ${new Date().toLocaleString()}`);
}
