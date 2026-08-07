/**
 * hooks/useAdvancedFilters.ts
 *
 * Phase 14 — Advanced Filters hook.
 *
 * NEW hook — no original-app equivalent. Manages saved filter groups
 * (persisted to LocalStorage, key 'fxj_v4_saved_filters' — a new,
 * additive key, no existing data affected) and provides the apply/
 * favorite/delete operations for them.
 *
 * SCOPE NOTE: This hook is NOT consumed by any existing page in this
 * phase — see calculations/filterEngine.ts's file header for the full
 * rationale (mirrors the Phase 8 useAdvancedAnalytics precedent: build
 * and validate the capability first, wire it into a page's UI only
 * with separate, explicit approval in a future phase).
 *
 * Follows the exact same hook pattern established in Phase 2A/2B
 * (useSettings, useLists, useAccounts, useTrades): lazy-init from
 * storage, persist via useEffect on change, expose typed CRUD functions.
 */

import { useState, useEffect, useCallback } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import {
  createSavedFilter,
  type FilterGroup, type SavedFilter,
} from '@calculations/filterEngine.js';

// ─── Hook ────────────────────────────────────────────────────

export interface UseAdvancedFiltersReturn {
  /** All saved filters, most-recently-created first is NOT assumed — order is insertion order */
  savedFilters: SavedFilter[];
  /** Save a new named filter built from the given group */
  saveFilter: (name: string, group: FilterGroup) => void;
  /** Delete a saved filter by id */
  deleteFilter: (id: string) => void;
  /** Toggle a saved filter's favorite flag */
  toggleFavorite: (id: string) => void;
  /** Rename an existing saved filter */
  renameFilter: (id: string, newName: string) => void;
}

export function useAdvancedFilters(): UseAdvancedFiltersReturn {
  const { storage } = useUserStorage();
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(() => storage.loadSavedFilters() as SavedFilter[]);

  useEffect(() => {
    storage.saveSavedFilters(savedFilters);
  }, [storage, savedFilters]);

  const saveFilter = useCallback((name: string, group: FilterGroup) => {
    const newFilter = createSavedFilter(name || 'Untitled Filter', group);
    setSavedFilters((prev) => [...prev, newFilter]);
  }, []);

  const deleteFilter = useCallback((id: string) => {
    setSavedFilters((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const toggleFavorite = useCallback((id: string) => {
    setSavedFilters((prev) => prev.map((f) => (f.id === id ? { ...f, isFavorite: !f.isFavorite } : f)));
  }, []);

  const renameFilter = useCallback((id: string, newName: string) => {
    setSavedFilters((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName || f.name } : f)));
  }, []);

  return { savedFilters, saveFilter, deleteFilter, toggleFavorite, renameFilter };
}
