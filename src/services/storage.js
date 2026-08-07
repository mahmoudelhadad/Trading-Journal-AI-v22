/**
 * services/storage.js
 *
 * LocalStorage service — thin wrapper around localStorage.
 *
 * CRITICAL: Key names are copied VERBATIM from the original single-file app.
 * Changing any key name would silently lose all existing user data.
 *
 * Original app used an inline LS object:
 *   var LS = {
 *     get: (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
 *     set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
 *   };
 *
 * This service wraps that exact behavior with named constants for keys.
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same key names
 * - Same JSON serialization
 * - Same error handling (silent catch)
 * - Same null-on-miss behavior
 *
 * Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 3):
 * `loadLists`/`saveLists`/`loadSettings`/`saveSettings` now read and
 * write the full `SingletonRecord` shape (sync metadata + `data`),
 * not just the bare lists/settings content — this is the permanent
 * contract those four functions use from this point forward, per
 * §3.1/§4. `loadTrades`/`saveTrades`/`loadAccounts`/`saveAccounts` are
 * unchanged: collections carry their metadata as extra fields on each
 * element, which never requires a signature change here.
 */

import { isStamped } from '@sync/record.js';
import { USER_STORAGE_LOGICAL_KEYS } from '@services/storageNamespace.js';

// ─── Storage Key Constants ───────────────────────────────────
// These match the exact strings used in the original app.
// DO NOT rename these — existing user data depends on them.
export const STORAGE_KEYS = {
  TRADES:     'fxj_v4_trades',     // Array of RawTrade
  ACCOUNTS:   'fxj_v4_accounts',   // Array of Account
  LISTS:      'fxj_v4_lists',      // Object: { [listName]: string[] }
  PROP_RULES: 'fxj_prop_rules',    // Object: { rules: PropRule[] }
  // Added Phase 2A — new key, no existing user data affected
  SETTINGS:   'fxj_v4_settings',   // AppSettings object
  // Added Phase 14 — new key, no existing user data affected
  SAVED_FILTERS: 'fxj_v4_saved_filters', // Array of SavedFilter
  // Added Phase 15 — new keys, no existing user data affected
  CHECKLIST_TEMPLATES:  'fxj_v4_checklist_templates',  // Array of ChecklistTemplate
  CHECKLIST_COMPLETIONS: 'fxj_v4_checklist_completions', // ChecklistCompletions (Record<tid, Record<itemId,bool>>)
  CUSTOM_FIELD_DEFS:    'fxj_v4_custom_field_defs',    // Array of CustomFieldDef
  CUSTOM_FIELD_VALUES:  'fxj_v4_custom_field_values',  // CustomFieldValues (Record<tid, Record<fieldId,string>>)
  // Added Phase 18 — new keys, no existing user data affected
  RECOVERY_BIN:   'fxj_v4_recovery_bin',   // Array of RecoveryBinEntry
  RESTORE_POINTS: 'fxj_v4_restore_points', // Array of RestorePoint
  // Added Phase 5a (SYNC_ARCHITECTURE_SPEC.md §3.3) — new key, no
  // existing user data affected
  SYNC_CURSORS: 'fxj_v4_sync_cursors', // Record<SyncTableName, TableCursorRow>
  // Added — Backtesting Foundation (AD-014: Class B, unsynced) — new
  // key, no existing user data affected
  BACKTEST_RESULTS: 'fxj_v4_backtest_results', // Array of BacktestResult
};

export { USER_STORAGE_LOGICAL_KEYS };

// ─── Core Primitives ────────────────────────────────────────

/**
 * Read and JSON-parse a value from LocalStorage.
 * Returns null on any error (missing key, parse error, storage unavailable).
 * Matches original: LS.get(k)
 *
 * @param {string} key
 * @returns {any|null}
 */
export const storageGet = (key) => {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/**
 * JSON-serialize and write a value to LocalStorage.
 * Silently ignores errors (storage full, private mode, etc.).
 * Matches original: LS.set(k, v)
 *
 * @param {string} key
 * @param {any} value
 * @returns {void}
 */
export const storageSet = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Silent — matches original app behavior
  }
};

/**
 * Remove a key from LocalStorage.
 * Not present in original app, added for future use (undo delete, recovery).
 *
 * @param {string} key
 * @returns {void}
 */
export const storageRemove = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Silent
  }
};

const parseRaw = (raw) => {
  try {
    return raw !== null ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

/** Build the complete typed storage API over one immutable user scope. */
export const createStorageService = (scope) => {
  const get = (key) => {
    try { return parseRaw(scope.getRaw(key)); } catch { return null; }
  };
  const set = (key, value) => {
    try { scope.setRaw(key, JSON.stringify(value)); } catch { /* Preserve legacy silent-write behavior. */ }
  };
  const remove = (key) => {
    try { scope.remove(key); } catch { /* Preserve legacy silent-remove behavior. */ }
  };
  const loadArray = (key) => {
    const data = get(key);
    return Array.isArray(data) ? data : [];
  };

  return Object.freeze({
    scope,
    storageGet: get,
    storageSet: set,
    storageRemove: remove,
    loadTrades: () => loadArray(STORAGE_KEYS.TRADES),
    saveTrades: (value) => set(STORAGE_KEYS.TRADES, value),
    loadAccounts: () => {
      const value = get(STORAGE_KEYS.ACCOUNTS);
      return Array.isArray(value) && value.length > 0 ? value : null;
    },
    saveAccounts: (value) => set(STORAGE_KEYS.ACCOUNTS, value),
    loadLists: () => {
      const value = get(STORAGE_KEYS.LISTS);
      return isStamped(value) ? value : null;
    },
    saveLists: (value) => set(STORAGE_KEYS.LISTS, value),
    loadPropRules: () => {
      const value = get(STORAGE_KEYS.PROP_RULES);
      return value && Array.isArray(value.rules) ? value : { rules: [] };
    },
    savePropRules: (value) => set(STORAGE_KEYS.PROP_RULES, value),
    loadSettings: () => {
      const value = get(STORAGE_KEYS.SETTINGS);
      return isStamped(value) ? value : null;
    },
    saveSettings: (value) => set(STORAGE_KEYS.SETTINGS, value),
    loadSavedFilters: () => loadArray(STORAGE_KEYS.SAVED_FILTERS),
    saveSavedFilters: (value) => set(STORAGE_KEYS.SAVED_FILTERS, value),
    loadChecklistTemplates: () => loadArray(STORAGE_KEYS.CHECKLIST_TEMPLATES),
    saveChecklistTemplates: (value) => set(STORAGE_KEYS.CHECKLIST_TEMPLATES, value),
    loadChecklistCompletions: () => {
      const value = get(STORAGE_KEYS.CHECKLIST_COMPLETIONS);
      return value && typeof value === 'object' ? value : {};
    },
    saveChecklistCompletions: (value) => set(STORAGE_KEYS.CHECKLIST_COMPLETIONS, value),
    loadCustomFieldDefs: () => loadArray(STORAGE_KEYS.CUSTOM_FIELD_DEFS),
    saveCustomFieldDefs: (value) => set(STORAGE_KEYS.CUSTOM_FIELD_DEFS, value),
    loadCustomFieldValues: () => {
      const value = get(STORAGE_KEYS.CUSTOM_FIELD_VALUES);
      return value && typeof value === 'object' ? value : {};
    },
    saveCustomFieldValues: (value) => set(STORAGE_KEYS.CUSTOM_FIELD_VALUES, value),
    loadRecoveryBin: () => loadArray(STORAGE_KEYS.RECOVERY_BIN),
    saveRecoveryBin: (value) => set(STORAGE_KEYS.RECOVERY_BIN, value),
    loadRestorePoints: () => loadArray(STORAGE_KEYS.RESTORE_POINTS),
    saveRestorePoints: (value) => set(STORAGE_KEYS.RESTORE_POINTS, value),
    loadSyncCursors: () => {
      const value = get(STORAGE_KEYS.SYNC_CURSORS);
      return value && typeof value === 'object' ? value : {};
    },
    saveSyncCursors: (value) => set(STORAGE_KEYS.SYNC_CURSORS, value),
    loadBacktestResults: () => loadArray(STORAGE_KEYS.BACKTEST_RESULTS),
    saveBacktestResults: (value) => set(STORAGE_KEYS.BACKTEST_RESULTS, value),
  });
};

// ─── Typed Accessors ────────────────────────────────────────
// Convenience wrappers for each data type.
// Each one preserves the exact same read/write behavior as the original.

/**
 * Load trades from LocalStorage.
 * Returns empty array if nothing saved yet (new user).
 *
 * Original: LS.get('fxj_v4_trades') → if(r && Array.isArray(r)) setRaw(r)
 *
 * @returns {import('../types/trade.js').RawTrade[]}
 */
export const loadTrades = () => {
  const data = storageGet(STORAGE_KEYS.TRADES);
  return Array.isArray(data) ? data : [];
};

/**
 * Save trades to LocalStorage.
 *
 * @param {import('../types/trade.js').RawTrade[]} trades
 * @returns {void}
 */
export const saveTrades = (trades) => {
  storageSet(STORAGE_KEYS.TRADES, trades);
};

/**
 * Load accounts from LocalStorage.
 * Returns null if nothing saved (caller should use DEFAULT_ACCOUNTS).
 *
 * Original: LS.get('fxj_v4_accounts') → if(a && Array.isArray(a) && a.length) setAccounts(a)
 *
 * @returns {import('../types/account.js').Account[]|null}
 */
export const loadAccounts = () => {
  const data = storageGet(STORAGE_KEYS.ACCOUNTS);
  return Array.isArray(data) && data.length > 0 ? data : null;
};

/**
 * Save accounts to LocalStorage.
 *
 * @param {import('../types/account.js').Account[]} accounts
 * @returns {void}
 */
export const saveAccounts = (accounts) => {
  storageSet(STORAGE_KEYS.ACCOUNTS, accounts);
};

/**
 * Load the lists SingletonRecord from LocalStorage (sync metadata +
 * `data`, see src/sync/record.ts). Returns null if nothing stamped
 * yet — caller (useLists) creates a fresh record in that case.
 *
 * @returns {import('../sync/record.js').SingletonRecord<Object>|null}
 */
export const loadLists = () => {
  const data = storageGet(STORAGE_KEYS.LISTS);
  return isStamped(data) ? data : null;
};

/**
 * Save the lists SingletonRecord to LocalStorage.
 *
 * @param {import('../sync/record.js').SingletonRecord<Object>} record
 * @returns {void}
 */
export const saveLists = (record) => {
  storageSet(STORAGE_KEYS.LISTS, record);
};

/**
 * Load prop firm rules from LocalStorage.
 * Returns default shape { rules: [] } if nothing saved.
 *
 * Original: LS.get('fxj_prop_rules') || { rules: [] }
 *
 * @returns {{ rules: any[] }}
 */
export const loadPropRules = () => {
  const data = storageGet(STORAGE_KEYS.PROP_RULES);
  return data && Array.isArray(data.rules) ? data : { rules: [] };
};

/**
 * Save prop firm rules to LocalStorage.
 *
 * @param {{ rules: any[] }} data
 * @returns {void}
 */
export const savePropRules = (data) => {
  storageSet(STORAGE_KEYS.PROP_RULES, data);
};

/**
 * Load the settings SingletonRecord from LocalStorage (sync metadata +
 * `data`, see src/sync/record.ts). Returns null if nothing stamped
 * yet — caller (useSettings) creates a fresh record in that case.
 *
 * @returns {import('../sync/record.js').SingletonRecord<Object>|null}
 */
export const loadSettings = () => {
  const data = storageGet(STORAGE_KEYS.SETTINGS);
  return isStamped(data) ? data : null;
};

/**
 * Save the settings SingletonRecord to LocalStorage.
 *
 * @param {import('../sync/record.js').SingletonRecord<Object>} record
 * @returns {void}
 */
export const saveSettings = (record) => {
  storageSet(STORAGE_KEYS.SETTINGS, record);
};

/**
 * Load saved filters from LocalStorage.
 * Returns [] if nothing saved yet (new key, added Phase 14).
 *
 * @returns {Array}
 */
export const loadSavedFilters = () => {
  const data = storageGet(STORAGE_KEYS.SAVED_FILTERS);
  return Array.isArray(data) ? data : [];
};

/**
 * Save the saved-filters list to LocalStorage.
 * Added Phase 14.
 *
 * @param {Array} filters
 * @returns {void}
 */
export const saveSavedFilters = (filters) => {
  storageSet(STORAGE_KEYS.SAVED_FILTERS, filters);
};

// ─── Phase 15: Checklist storage ─────────────────────────────

/** Load checklist templates. Returns [] if nothing saved yet. */
export const loadChecklistTemplates = () => {
  const data = storageGet(STORAGE_KEYS.CHECKLIST_TEMPLATES);
  return Array.isArray(data) ? data : [];
};

/** Save checklist templates. */
export const saveChecklistTemplates = (templates) => {
  storageSet(STORAGE_KEYS.CHECKLIST_TEMPLATES, templates);
};

/** Load per-trade checklist completions. Returns {} if nothing saved yet. */
export const loadChecklistCompletions = () => {
  const data = storageGet(STORAGE_KEYS.CHECKLIST_COMPLETIONS);
  return data && typeof data === 'object' ? data : {};
};

/** Save per-trade checklist completions. */
export const saveChecklistCompletions = (completions) => {
  storageSet(STORAGE_KEYS.CHECKLIST_COMPLETIONS, completions);
};

// ─── Phase 15: Custom Fields storage ──────────────────────────

/** Load custom field definitions. Returns [] if nothing saved yet. */
export const loadCustomFieldDefs = () => {
  const data = storageGet(STORAGE_KEYS.CUSTOM_FIELD_DEFS);
  return Array.isArray(data) ? data : [];
};

/** Save custom field definitions. */
export const saveCustomFieldDefs = (defs) => {
  storageSet(STORAGE_KEYS.CUSTOM_FIELD_DEFS, defs);
};

/** Load per-trade custom field values. Returns {} if nothing saved yet. */
export const loadCustomFieldValues = () => {
  const data = storageGet(STORAGE_KEYS.CUSTOM_FIELD_VALUES);
  return data && typeof data === 'object' ? data : {};
};

/** Save per-trade custom field values. */
export const saveCustomFieldValues = (values) => {
  storageSet(STORAGE_KEYS.CUSTOM_FIELD_VALUES, values);
};

// ─── Phase 18: Data Safety storage ───────────────────────────
//
// loadArrayOrDefault() is a small internal helper introduced here to
// avoid writing a 6th near-identical copy of the
// "Array.isArray(data) ? data : []" pattern already repeated across
// loadTrades/loadAccounts/loadSavedFilters/loadChecklistTemplates/
// loadCustomFieldDefs. It is used ONLY for the two NEW key pairs added
// in this phase (RECOVERY_BIN, RESTORE_POINTS) — the 10 existing
// load*/save* pairs above are deliberately left untouched rather than
// retroactively refactored to use it. Retroactively changing already-
// validated Phase 1-16 code carries its own regression risk for zero
// behavioral benefit (the existing functions are correct as written);
// consolidating only the NEW additions avoids adding to the pattern's
// duplication without touching stable, already-shipped code. See
// MIGRATION_NOTES.md Phase 18 entry.

const loadArrayOrDefault = (key) => {
  const data = storageGet(key);
  return Array.isArray(data) ? data : [];
};

/** Load recovery bin entries (soft-deleted trades). Returns [] if empty. */
export const loadRecoveryBin = () => loadArrayOrDefault(STORAGE_KEYS.RECOVERY_BIN);

/** Save recovery bin entries. */
export const saveRecoveryBin = (entries) => {
  storageSet(STORAGE_KEYS.RECOVERY_BIN, entries);
};

/** Load restore points (full-app-state snapshots). Returns [] if empty. */
export const loadRestorePoints = () => loadArrayOrDefault(STORAGE_KEYS.RESTORE_POINTS);

/** Save restore points. */
export const saveRestorePoints = (points) => {
  storageSet(STORAGE_KEYS.RESTORE_POINTS, points);
};

// ─── Phase 5a: Sync cursor storage (SYNC_ARCHITECTURE_SPEC.md §3.3) ──

/**
 * Load the per-table cursor map. Returns {} if nothing saved yet (new
 * device, or a table not yet synced) — callers apply their own
 * per-table default row (see src/sync/localStores.ts's
 * DEFAULT_CURSOR_ROW) for any missing key.
 *
 * @returns {Object<string, import('../sync/localStores.js').TableCursorRow>}
 */
export const loadSyncCursors = () => {
  const data = storageGet(STORAGE_KEYS.SYNC_CURSORS);
  return data && typeof data === 'object' ? data : {};
};

/**
 * Save the per-table cursor map.
 *
 * @param {Object<string, import('../sync/localStores.js').TableCursorRow>} cursors
 * @returns {void}
 */
export const saveSyncCursors = (cursors) => {
  storageSet(STORAGE_KEYS.SYNC_CURSORS, cursors);
};

// ─── Backtesting Foundation: backtest result storage (AD-014) ───

/** Load backtest results. Returns [] if nothing saved yet. */
export const loadBacktestResults = () => loadArrayOrDefault(STORAGE_KEYS.BACKTEST_RESULTS);

/** Save backtest results. */
export const saveBacktestResults = (results) => {
  storageSet(STORAGE_KEYS.BACKTEST_RESULTS, results);
};
