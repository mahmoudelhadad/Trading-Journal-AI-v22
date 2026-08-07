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
 * Phase 27 covers 12 sections: trades, accounts, lists, propRules,
 * settings, savedFilters, checklistTemplates, checklistCompletions,
 * customFieldDefs, customFieldValues, Recovery Bin, and saved Backtest
 * Results. Adding another section in the future
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
  loadRecoveryBin, saveRecoveryBin,
  loadBacktestResults, saveBacktestResults,
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
import type { createStorageService } from './storage.js';
import type { ScopedLocalDatabase } from './localDatabase.js';

// ─── Backup format ───────────────────────────────────────────

const BACKUP_VERSION = 2;
const SUPPORTED_BACKUP_VERSIONS = new Set([1, 2]);

type SectionValidator = (data: unknown) => string | null;

interface BackupSection<T = unknown> {
  key:  string;
  load: () => MaybePromise<T>;
  save: (data: T) => MaybePromise<void>;
  validate: SectionValidator;
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
  validate: SectionValidator;
  reviveForRestore?: (data: unknown) => unknown;
}): BackupSection<unknown> {
  return section as unknown as BackupSection<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const validateArrayOf = (
  value: unknown,
  validateItem: (item: Record<string, unknown>) => boolean,
): string | null => {
  if (!Array.isArray(value)) return 'expected an array.';
  if (!value.every((item) => isRecord(item) && validateItem(item))) return 'contains an invalid record.';
  return null;
};

const validateTrades: SectionValidator = (value) => validateArrayOf(
  value,
  (item) => isFiniteNumber(item._tid),
);

const validateAccounts: SectionValidator = (value) => value === null ? null : validateArrayOf(
  value,
  (item) => typeof item.id === 'string'
    && typeof item.name === 'string'
    && isFiniteNumber(item.capital)
    && typeof item.color === 'string',
);

const validateNullableRecord: SectionValidator = (value) =>
  value === null || isRecord(value) ? null : 'expected an object or null.';

const validatePropRules: SectionValidator = (value) => {
  if (!isRecord(value) || !Array.isArray(value.rules)) return 'expected an object with a rules array.';
  return value.rules.every(isRecord) ? null : 'rules contains an invalid record.';
};

const validateSavedFilters: SectionValidator = (value) => validateArrayOf(
  value,
  (item) => typeof item.id === 'string'
    && typeof item.name === 'string'
    && isRecord(item.group)
    && typeof item.isFavorite === 'boolean'
    && isFiniteNumber(item.createdAt),
);

const validateChecklistTemplates: SectionValidator = (value) => validateArrayOf(
  value,
  (item) => typeof item.id === 'string'
    && typeof item.name === 'string'
    && Array.isArray(item.items)
    && item.items.every(isRecord),
);

const validateNestedRecord = (
  value: unknown,
  validateLeaf: (leaf: unknown) => boolean,
): string | null => {
  if (!isRecord(value)) return 'expected an object.';
  const valid = Object.values(value).every((nested) =>
    isRecord(nested) && Object.values(nested).every(validateLeaf));
  return valid ? null : 'contains an invalid nested value.';
};

const validateCustomFieldDefs: SectionValidator = (value) => validateArrayOf(
  value,
  (item) => typeof item.id === 'string'
    && typeof item.name === 'string'
    && (item.type === 'text' || item.type === 'number' || item.type === 'boolean'),
);

const validateRecoveryBin: SectionValidator = (value) => validateArrayOf(
  value,
  (item) => typeof item.id === 'string'
    && isFiniteNumber(item.deletedAt)
    && typeof item.label === 'string'
    && isRecord(item.item),
);

const validateBacktestResults: SectionValidator = (value) => validateArrayOf(
  value,
  (item) => typeof item.id === 'string'
    && typeof item.name === 'string'
    && isFiniteNumber(item.createdAt)
    && isRecord(item.filterGroup)
    && isFiniteNumber(item.startingCapital)
    && Array.isArray(item.matchedTradeIds)
    && item.matchedTradeIds.every(isFiniteNumber)
    && Number.isInteger(item.tradeCount)
    && (item.tradeCount as number) >= 0
    && isRecord(item.summary)
    && isRecord(item.drawdown)
    && isRecord(item.streaks)
    && isRecord(item.averageStreaks)
    && isRecord(item.longestStreaks)
    && isRecord(item.core)
    && (!Object.prototype.hasOwnProperty.call(item, 'equityPath')
      || (Array.isArray(item.equityPath) && item.equityPath.every(isFiniteNumber))),
);

const semanticEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => semanticEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && semanticEqual(left[key], right[key]));
};

/**
 * Every backed-up section, paired with its EXISTING load/save
 * functions. This is the single place a future key needs to be added
 * to be covered by backup/restore — no other file needs to change.
 *
 * RESTORE_POINTS remains deliberately excluded: including a snapshot of
 *     "all restore points" inside each restore point would be
 *     self-referential (restoring an old backup would overwrite your
 *     CURRENT restore-point list with a stale one, silently discarding
 *     any restore points created afterward). This exclusion is
 *     intentional and should remain.
 * Recovery Bin and saved Backtest Results are ordinary sections in
 * Phase 27. Restore Points inherit them through buildBackup(), while
 * the Restore Point list itself never becomes recursive payload data.
 */
type ScopedStorageService = ReturnType<typeof createStorageService>;
interface BackupRuntime { storage: ScopedStorageService; database: ScopedLocalDatabase }
const adaptSave = (save: (data: never) => MaybePromise<void>) => (value: unknown) => save(value as never);

function getBackupSections(runtime?: BackupRuntime): BackupSection<unknown>[] {
  const direct = runtime?.storage;
  const database = runtime?.database;
  return [
    defineBackupSection({ key: 'trades',               load: database ? () => database.loadTrades() : loadTrades,                  save: database ? (value) => database.saveTrades(value as never) : adaptSave(saveTrades),       validate: validateTrades,             reviveForRestore: stampCollectionForRestore }),
    defineBackupSection({ key: 'accounts',             load: database ? () => database.loadAccounts() : loadAccounts,              save: database ? (value) => database.saveAccounts(value as never) : adaptSave(saveAccounts),    validate: validateAccounts,           reviveForRestore: stampCollectionForRestore }),
    defineBackupSection({ key: 'lists',                load: database ? () => database.loadLists() : loadLists,                    save: database ? (value) => database.saveLists(value as never) : adaptSave(saveLists),          validate: validateNullableRecord,     reviveForRestore: stampSingletonForRestore }),
    defineBackupSection({ key: 'propRules',            load: direct ? () => direct.loadPropRules() : loadPropRules,                 save: direct ? (value) => direct.savePropRules(value) : adaptSave(savePropRules),                validate: validatePropRules }),
    defineBackupSection({ key: 'settings',             load: database ? () => database.loadSettings() : loadSettings,              save: database ? (value) => database.saveSettings(value as never) : adaptSave(saveSettings),    validate: validateNullableRecord,     reviveForRestore: stampSingletonForRestore }),
    defineBackupSection({ key: 'savedFilters',         load: direct ? () => direct.loadSavedFilters() : loadSavedFilters,           save: direct ? (value) => direct.saveSavedFilters(value) : adaptSave(saveSavedFilters),          validate: validateSavedFilters }),
    defineBackupSection({ key: 'checklistTemplates',   load: direct ? () => direct.loadChecklistTemplates() : loadChecklistTemplates, save: direct ? (value) => direct.saveChecklistTemplates(value) : saveChecklistTemplates, validate: validateChecklistTemplates }),
    defineBackupSection({ key: 'checklistCompletions', load: direct ? () => direct.loadChecklistCompletions() : loadChecklistCompletions, save: direct ? (value) => direct.saveChecklistCompletions(value) : saveChecklistCompletions, validate: (value) => validateNestedRecord(value, (leaf) => typeof leaf === 'boolean') }),
    defineBackupSection({ key: 'customFieldDefs',      load: direct ? () => direct.loadCustomFieldDefs() : loadCustomFieldDefs,     save: direct ? (value) => direct.saveCustomFieldDefs(value) : saveCustomFieldDefs,    validate: validateCustomFieldDefs }),
    defineBackupSection({ key: 'customFieldValues',    load: direct ? () => direct.loadCustomFieldValues() : loadCustomFieldValues, save: direct ? (value) => direct.saveCustomFieldValues(value) : saveCustomFieldValues, validate: (value) => validateNestedRecord(value, (leaf) => typeof leaf === 'string') }),
    defineBackupSection({ key: 'recoveryBin',          load: direct ? () => direct.loadRecoveryBin() : loadRecoveryBin,             save: direct ? (value) => direct.saveRecoveryBin(value) : saveRecoveryBin,            validate: validateRecoveryBin }),
    defineBackupSection({ key: 'backtestResults',      load: direct ? () => direct.loadBacktestResults() : loadBacktestResults,     save: direct ? (value) => direct.saveBacktestResults(value) : saveBacktestResults,    validate: validateBacktestResults }),
  ];
}

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
export async function buildBackup(runtime?: BackupRuntime): Promise<BackupData> {
  const data: Record<string, unknown> = {};
  for (const section of getBackupSections(runtime)) {
    data[section.key] = await section.load();
  }
  return { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data };
}

/**
 * Trigger a browser download of a full backup as a JSON file.
 * Filename convention: trading_journal_backup_{YYYY-MM-DD}.json
 */
export async function downloadBackup(runtime?: BackupRuntime): Promise<void> {
  const backup = await buildBackup(runtime);
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
export async function restoreBackup(raw: unknown, runtime?: BackupRuntime): Promise<RestoreResult> {
  if (!isRecord(raw)) {
    return { success: false, error: 'Invalid backup file: not a JSON object.' };
  }
  const backup = raw as Partial<BackupData>;
  if (!Number.isInteger(backup.version) || !SUPPORTED_BACKUP_VERSIONS.has(backup.version as number)) {
    return { success: false, error: 'Invalid backup file: unsupported version.' };
  }
  if (typeof backup.exportedAt !== 'string' || !isRecord(backup.data)) {
    return { success: false, error: 'Invalid backup file: missing version or data.' };
  }

  const sections = getBackupSections(runtime);
  for (const section of sections) {
    if (!Object.prototype.hasOwnProperty.call(backup.data, section.key)) continue;
    const error = section.validate(backup.data[section.key]);
    if (error) return { success: false, error: `Invalid backup section '${section.key}': ${error}` };
  }

  const restoredKeys: string[] = [];
  for (const section of sections) {
    if (!Object.prototype.hasOwnProperty.call(backup.data, section.key)) continue;
    const sectionData = backup.data[section.key];
    if (sectionData === null) continue;
    const expected = section.reviveForRestore ? section.reviveForRestore(sectionData) : sectionData;
    try {
      await section.save(expected);
      const persisted = await section.load();
      if (!semanticEqual(persisted, expected)) throw new Error('read-back mismatch');
    } catch {
      return { success: false, error: `Failed to persist backup section '${section.key}'.`, restoredKeys };
    }
    restoredKeys.push(section.key);
  }

  return { success: true, restoredKeys };
}

/**
 * Parse a raw JSON string (e.g. from a file upload) and restore it.
 * Wraps JSON.parse errors into the same RestoreResult shape as
 * restoreBackup(), so callers only need to handle one error path.
 */
export async function restoreBackupFromJSON(jsonText: string, runtime?: BackupRuntime): Promise<RestoreResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { success: false, error: 'Could not parse file as JSON.' };
  }
  return restoreBackup(parsed, runtime);
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
export async function createRestorePoint(label: string, runtime?: BackupRuntime): Promise<RestorePoint> {
  const point: RestorePoint = {
    id: nextId('restore'),
    label: label || 'Restore Point',
    createdAt: Date.now(),
    backup: await buildBackup(runtime),
  };
  const existing = runtime ? runtime.storage.loadRestorePoints() as RestorePoint[] : loadRestorePoints() as RestorePoint[];
  const updated = addRestorePoint(existing, point);
  if (runtime) runtime.storage.saveRestorePoints(updated);
  else saveRestorePoints(updated);
  return point;
}

/** List all saved restore points, most-recently-created not guaranteed sorted — callers sort as needed. */
export function listRestorePoints(runtime?: BackupRuntime): RestorePoint[] {
  return runtime ? runtime.storage.loadRestorePoints() as RestorePoint[] : loadRestorePoints() as RestorePoint[];
}

/**
 * Restore the app to a previously saved restore point.
 * Reuses restoreBackup() — no new restoration logic.
 */
export async function restoreFromPoint(pointId: string, runtime?: BackupRuntime): Promise<RestoreResult> {
  const points = listRestorePoints(runtime);
  const point = points.find((p) => p.id === pointId);
  if (!point) return { success: false, error: 'Restore point not found.' };
  return restoreBackup(point.backup, runtime);
}

/** Delete a single restore point by id. */
export function deleteRestorePoint(pointId: string, runtime?: BackupRuntime): void {
  const updated = listRestorePoints(runtime).filter((p) => p.id !== pointId);
  if (runtime) runtime.storage.saveRestorePoints(updated);
  else saveRestorePoints(updated);
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
export async function maybeCreateAutoBackup(runtime?: BackupRuntime): Promise<RestorePoint | null> {
  const points = listRestorePoints(runtime);
  const lastAuto = points
    .filter((p) => p.label.startsWith('Auto: '))
    .reduce<RestorePoint | null>((latest, p) => (!latest || p.createdAt > latest.createdAt ? p : latest), null);

  if (lastAuto && (Date.now() - lastAuto.createdAt) < AUTO_BACKUP_INTERVAL_MS) {
    return null;
  }

  return createRestorePoint(`Auto: ${new Date().toLocaleString()}`, runtime);
}

export function createBackupService(storage: ScopedStorageService, database: ScopedLocalDatabase) {
  const runtime = Object.freeze({ storage, database });
  return Object.freeze({
    buildBackup: () => buildBackup(runtime),
    downloadBackup: () => downloadBackup(runtime),
    restoreBackup: (raw: unknown) => restoreBackup(raw, runtime),
    restoreBackupFromJSON: (json: string) => restoreBackupFromJSON(json, runtime),
    createRestorePoint: (label: string) => createRestorePoint(label, runtime),
    listRestorePoints: () => listRestorePoints(runtime),
    restoreFromPoint: (id: string) => restoreFromPoint(id, runtime),
    deleteRestorePoint: (id: string) => deleteRestorePoint(id, runtime),
    maybeCreateAutoBackup: () => maybeCreateAutoBackup(runtime),
  });
}
