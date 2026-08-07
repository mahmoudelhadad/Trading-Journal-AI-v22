/**
 * hooks/useLists.ts
 *
 * Phase 2A hook — manages custom dropdown lists.
 *
 * Replicates EXACTLY the customLists state from the original App component:
 *
 *   var ls = useState(DEFAULT_LISTS);
 *   var customLists = ls[0], setCustomLists = ls[1];
 *
 *   useEffect(function() {
 *     var l = LS.get("fxj_v4_lists");
 *     if (l && typeof l === "object") {
 *       var merged = {};
 *       Object.keys(DEFAULT_LISTS).forEach(function(k) {
 *         merged[k] = l[k] || DEFAULT_LISTS[k];
 *       });
 *       setCustomLists(merged);
 *     }
 *   }, []);
 *
 *   useEffect(function() {
 *     LS.set("fxj_v4_lists", customLists);
 *   }, [customLists]);
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same LocalStorage key: 'fxj_v4_lists'
 * - Same merge logic: saved values override defaults per key
 * - Missing keys fall back to DEFAULT_LISTS values
 * - Same update / reset functions as original updateList / resetList
 *
 * Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 2): the
 * Phase 4 cloud write-through layer (services/cloudSync.ts) and its
 * hydrate-once-after-migration logic have been removed. This hook is
 * pure local-storage read/write again — no network calls, no auth
 * dependency. Cross-device sync is offline until the new Sync Engine
 * is wired in (§13 Step 5); this is an explicitly sanctioned
 * intermediate state, not a regression.
 *
 * §13 Step 3: internal state is now a `SingletonRecord<ListsState>` —
 * sync metadata plus the list content under `.data` — per §3.1/§3.2.
 * This is the PERMANENT local record model; Phase 5 only changes what
 * values a mutation writes into the metadata fields (`syncStatus`,
 * `localUpdatedAt`), never this shape or the `loadLists`/`saveLists`
 * contract. `lists` (the value returned to callers) is unchanged —
 * every existing consumer of this hook is unaffected.
 */

import { useState, useEffect, useCallback } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import { DEFAULT_LISTS } from '@constants/lists.js';
import { createSyncMetadata, refreshForLocalWrite } from '@sync/record.js';
import type { SingletonRecord } from '@sync/record.js';
import { notifyLocalMutation } from '@sync/syncEngine.js';
import { reportLocalPersistenceFailure } from '@services/localPersistenceEvents.js';

// ─── Types ───────────────────────────────────────────────────

/** Shape of the lists object — each key maps to an ordered string array */
export type ListsState = Record<string, string[]>;

export interface UseListsReturn {
  /** The currently active lists (custom or default) */
  lists: ListsState;
  /**
   * Replace the items for a single list key.
   * Matches original: updateList(key, items) in App component.
   *
   * @param key  - List name, e.g. 'Session', 'EntrySetup'
   * @param items - New ordered array of string values
   */
  updateList: (key: string, items: string[]) => void;
  /**
   * Reset one list back to its DEFAULT_LISTS value.
   * Matches original: resetList(key) in App component.
   *
   * @param key - List name to reset
   */
  resetList: (key: string) => void;
  /**
   * Reset ALL lists back to DEFAULT_LISTS.
   * New utility — not in original app, added for Settings page.
   */
  resetAllLists: () => void;
  /** False until the initial async load has completed (Phase 6f). See the hook body. */
  hydrated: boolean;
}

// ─── Helper ──────────────────────────────────────────────────

/**
 * Merge saved lists with defaults.
 * Restored (Phase 7B) to match the ORIGINAL app's exact logic verbatim:
 *
 *   merged[k] = (saved && saved[k]) || DEFAULT_LISTS[k]
 *
 * In JavaScript, an empty array `[]` is truthy. This means if a saved
 * key's value is `[]` (e.g. the user deleted every item from a list
 * and saved), the ORIGINAL app keeps that list empty — it does NOT
 * fall back to defaults. This exact truthy-OR semantics is restored
 * here, replacing the Phase 2A implementation which incorrectly used
 * `.length > 0` and silently reset emptied lists back to defaults
 * (a divergence caught and documented in Phase 7 Validation).
 */
const mergeLists = (saved: Partial<ListsState> | null): ListsState => {
  const merged: ListsState = {};
  Object.keys(DEFAULT_LISTS).forEach((k) => {
    const key = k as keyof typeof DEFAULT_LISTS;
    merged[k] = (saved && saved[k]) || DEFAULT_LISTS[key];
  });
  return merged;
};

// ─── Hook ────────────────────────────────────────────────────

/**
 * useLists
 *
 * Provides dropdown list management with LocalStorage persistence.
 *
 * Usage:
 *   const { lists, updateList, resetList } = useLists();
 *   updateList('Session', [...lists.Session, 'Tokyo']);
 */
export function useLists(): UseListsReturn {
  const { database } = useUserStorage();
  // PHASE 6f — ASYNC HYDRATION. See useSettings.ts for the full
  // rationale; the pattern is identical. Initial state is the
  // "nothing saved yet" branch of the old synchronous initializer;
  // the hydration effect replaces it if storage held a record.
  const [record, setRecord] = useState<SingletonRecord<ListsState>>(
    () => ({ ...createSyncMetadata(), data: mergeLists(null) }),
  );
  const [hydrated, setHydrated] = useState(false);
  /** Audit Issue #1 — see useSettings.ts for the full rationale. */
  const [loadFailed, setLoadFailed] = useState(false);

  // Cancellation only, no "already started" ref guard — see useSettings.ts
  // for why a ref guard would deadlock hydration under <React.StrictMode>.
  // Read-failure handling (audit Issue #1) also mirrors useSettings.ts.
  useEffect(() => {
    let cancelled = false;
    database.loadLists()
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          setRecord({ ...(saved as SingletonRecord<ListsState>), data: mergeLists(saved.data as Partial<ListsState>) });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadFailed(true);
        reportLocalPersistenceFailure('lists', err);
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => { cancelled = true; };
  }, [database]);

  // Persist whenever the record changes — never before hydration, and
  // never after a failed read (which would replace the user's real
  // lists with defaults — see useSettings.ts). Matches original:
  // useEffect(() => LS.set('fxj_v4_lists', customLists), [customLists])
  useEffect(() => {
    if (!hydrated || loadFailed) return;
    // Phase 6g-1 (BD-1): see useTrades.ts for the full rationale.
    database.saveLists(record).catch((err) => reportLocalPersistenceFailure('lists', err));
  }, [database, record, hydrated, loadFailed]);

  const lists = record.data;

  /**
   * Replace items for one list key.
   * Matches original updateList(key, items) in App.
   * §5.1/§6.1/§9.1: an ordinary edit -> `dirty` — never a tombstone;
   * Lists is a singleton, never deleted (record.ts's refreshForLocalWrite
   * only ever targets `pending_delete` when `deletedAt` is already set,
   * which never happens for a singleton — see useSettings.ts for the
   * identical reasoning).
   */
  const updateList = useCallback((key: string, items: string[]) => {
    setRecord((r) => {
      const withData = { ...r, data: { ...r.data, [key]: items } };
      return { ...withData, ...refreshForLocalWrite(withData) };
    });
    notifyLocalMutation('lists');
  }, []);

  /**
   * Reset one list to its default value.
   * Matches original resetList(key) in App. An ordinary edit, same as
   * updateList — resetting is not deleting (§9.1).
   */
  const resetList = useCallback((key: string) => {
    setRecord((r) => {
      const withData = {
        ...r,
        data: { ...r.data, [key]: DEFAULT_LISTS[key as keyof typeof DEFAULT_LISTS] ?? [] },
      };
      return { ...withData, ...refreshForLocalWrite(withData) };
    });
    notifyLocalMutation('lists');
  }, []);

  /**
   * Reset all lists to defaults. An ordinary edit, same as updateList.
   */
  const resetAllLists = useCallback(() => {
    setRecord((r) => {
      const withData = { ...r, data: mergeLists(null) };
      return { ...withData, ...refreshForLocalWrite(withData) };
    });
    notifyLocalMutation('lists');
  }, []);

  return { lists, updateList, resetList, resetAllLists, hydrated };
}
