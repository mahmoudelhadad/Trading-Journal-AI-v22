/**
 * hooks/useSettings.ts
 *
 * Phase 2A hook — manages application-level settings.
 *
 * Settings are stored under key 'fxj_v4_settings' (new in Phase 2A).
 * This key did not exist in the original single-file app, so there
 * is no existing data to migrate or break.
 *
 * Backward compatibility: PRESERVED
 * - No existing LocalStorage keys touched
 * - No existing calculations affected
 * - Settings are entirely additive
 *
 * Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 2): the
 * Phase 4 cloud write-through layer (services/cloudSync.ts) and its
 * hydrate-once-after-migration logic have been removed. This hook is
 * pure local-storage read/write again — no network calls, no auth
 * dependency. Cross-device sync is offline until the new Sync Engine
 * is wired in (§13 Step 5); this is an explicitly sanctioned
 * intermediate state, not a regression.
 *
 * §13 Step 3: internal state is now a `SingletonRecord<AppSettings>` —
 * sync metadata plus the settings content under `.data` — per
 * §3.1/§3.2. This is the PERMANENT local record model; Phase 5 only
 * changes what values a mutation writes into the metadata fields
 * (`syncStatus`, `localUpdatedAt`), never this shape or the
 * `loadSettings`/`saveSettings` contract. `settings` (the value
 * returned to callers) is unchanged — every existing consumer of this
 * hook is unaffected.
 */

import { useState, useEffect, useCallback } from 'react';
import { loadSettings, saveSettings } from '@services/localDatabase.js';
import { createSyncMetadata, refreshForLocalWrite } from '@sync/record.js';
import type { SingletonRecord } from '@sync/record.js';
import { notifyLocalMutation } from '@sync/syncEngine.js';
import { reportLocalPersistenceFailure } from '@services/localPersistenceEvents.js';

// ─── Types ───────────────────────────────────────────────────

// Declared as a type alias rather than an `interface` (Phase 6f): the
// resolver's `saveSettings` takes the opaque `SingletonRecord<Record<
// string, unknown>>` that src/sync/ uses everywhere for singleton
// content, and TypeScript only gives object *type aliases* an implicit
// index signature — an `interface` is not assignable to
// `Record<string, unknown>` even when its fields match. Structurally
// identical for every consumer; purely a type-level change with no
// runtime effect.
export type AppSettings = {
  /** Currency symbol shown in the UI.  Default: '$' */
  currency: string;
  /** Default risk % used in the Position Calculator.  Default: 1 */
  riskPercent: number;
  /**
   * Future fields go here (theme, dateFormat, timezone, etc.).
   * Defined here so Phase 8+ can extend without touching storage keys.
   */
};

// ─── Defaults ────────────────────────────────────────────────

export const DEFAULT_SETTINGS: AppSettings = {
  currency:    '$',
  riskPercent: 1,
};

// ─── Hook ────────────────────────────────────────────────────

export interface UseSettingsReturn {
  /** Current settings object */
  settings: AppSettings;
  /** Update one or more settings fields */
  updateSettings: (patch: Partial<AppSettings>) => void;
  /** Reset all settings to DEFAULT_SETTINGS */
  resetSettings: () => void;
  /** False until the initial async load has completed (Phase 6f). See the hook body. */
  hydrated: boolean;
}

/**
 * useSettings
 *
 * Provides app-level settings with LocalStorage persistence.
 *
 * Usage:
 *   const { settings, updateSettings } = useSettings();
 *   updateSettings({ currency: '€' });
 */
export function useSettings(): UseSettingsReturn {
  // PHASE 6f — ASYNC HYDRATION. Reads now go through the resolver
  // (services/localDatabase.ts), whose API is asynchronous because
  // IndexedDB is (§3.4). The initial state is therefore the
  // "nothing saved yet" branch of what the old synchronous initializer
  // computed; if storage actually held a record, the hydration effect
  // below replaces it. Net result once hydrated is identical to before.
  const [record, setRecord] = useState<SingletonRecord<AppSettings>>(
    () => ({ ...createSyncMetadata(), data: DEFAULT_SETTINGS }),
  );
  const [hydrated, setHydrated] = useState(false);
  // Phase 6g-2 prerequisite (audit Issue #1). Tracks that the initial
  // READ failed, which is a different condition from "not yet loaded":
  // hydration still completes (so the app is never stuck), but this
  // hook's state is now only the placeholder above, NOT the user's
  // stored data — so persisting it would overwrite real records with
  // defaults. See the persist effect below.
  const [loadFailed, setLoadFailed] = useState(false);

  // Cancellation only — deliberately NO "already started" ref guard.
  // <React.StrictMode> runs this effect, then its cleanup, then the
  // effect again in development. A ref guard would let the first run
  // start the load, the cleanup would cancel it, and the second run
  // would return early — leaving the hook permanently unhydrated and
  // the app stuck on its loading gate. Cancellation alone is correct:
  // the re-run starts a fresh load whose own `cancelled` flag is false.
  // Running twice is harmless because nothing is minted in here —
  // `createSyncMetadata()` lives in the useState initializer above, so
  // this effect only ever reads and applies.
  //
  // READ-FAILURE HANDLING (audit Issue #1): a rejected load must not
  // become an unhandled rejection, and must not leave `hydrated` false
  // forever — App.jsx's gate has no timeout, so that would strand the
  // user on the loading spinner permanently with no explanation. The
  // failure is reported through the same §3.4 layer BD-1 uses for write
  // failures, and hydration is completed via `finally` so the UI is
  // always released. Unreachable while the cutover marker is absent:
  // the resolver routes to LocalStorage, whose `storageGet` swallows
  // every error and cannot reject (services/storage.js).
  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          setRecord({ ...saved, data: { ...DEFAULT_SETTINGS, ...(saved.data as Partial<AppSettings>) } });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadFailed(true);
        reportLocalPersistenceFailure('settings', err);
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Persist whenever the record changes — but NEVER before hydration
  // finishes, which would write the placeholder above over real stored
  // data on every app start. The write that fires when `hydrated` flips
  // true is the same redundant write-back the synchronous version
  // performed on mount, so this is behaviour-preserving.
  //
  // `loadFailed` suppresses persistence for the same reason, in the one
  // case where hydration completed WITHOUT the stored data: writing the
  // placeholder then would silently replace the user's real settings
  // with defaults — turning a transient read error into permanent data
  // loss (Principle 1). Releasing the UI gate while refusing to write
  // is the only combination that is both non-blocking and non-destructive.
  useEffect(() => {
    if (!hydrated || loadFailed) return;
    // Phase 6g-1 (BD-1): see useTrades.ts for the full rationale.
    saveSettings(record).catch((err) => reportLocalPersistenceFailure('settings', err));
  }, [record, hydrated, loadFailed]);

  const settings = record.data;

  // §5.1/§6.1/§9.1: an ordinary edit -> `dirty` — never a tombstone;
  // Settings is a singleton, never deleted (same reasoning as
  // useLists.ts's updateList/resetList/resetAllLists).
  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setRecord((r) => {
      const withData = { ...r, data: { ...r.data, ...patch } };
      return { ...withData, ...refreshForLocalWrite(withData) };
    });
    notifyLocalMutation('settings');
  }, []);

  const resetSettings = useCallback(() => {
    setRecord((r) => {
      const withData = { ...r, data: DEFAULT_SETTINGS };
      return { ...withData, ...refreshForLocalWrite(withData) };
    });
    notifyLocalMutation('settings');
  }, []);

  return { settings, updateSettings, resetSettings, hydrated };
}
