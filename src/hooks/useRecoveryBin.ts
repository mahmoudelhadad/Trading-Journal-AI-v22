/**
 * hooks/useRecoveryBin.ts
 *
 * Phase 18 — Recovery Bin hook.
 *
 * NEW hook — manages soft-deleted items (any type, generic). Follows
 * the exact same pattern established in Phase 2A/2B/14/15 (lazy-init
 * from storage, persist via useEffect, expose typed CRUD functions).
 *
 * SCOPE NOTE: NOT consumed by useTrades.ts's deleteTrade/deleteAllTrades
 * in this phase — see calculations/recoveryBin.ts's file header for the
 * full rationale. This hook is generic (works for any item type via
 * the `<T>` parameter), so it is not trade-specific — a future wiring
 * phase could use it for trades, or any other soft-deletable entity.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import {
  buildRecoveryBinEntries, purgeExpiredEntries, isExpired,
  type RecoveryBinCapture,
  type RecoveryBinEntry,
} from '@calculations/recoveryBin.js';
import { nextId } from '@calculations/idGenerator.js';

// ─── Hook ────────────────────────────────────────────────────

export interface UseRecoveryBinReturn<T> {
  /** Non-expired entries, most-recently-deleted first */
  entries:        RecoveryBinEntry<T>[];
  /** Move an item into the bin (the "soft delete" action) */
  softDelete:     (item: T, label: string) => void;
  /** Move a batch into the bin through one functional state update */
  softDeleteMany: (captures: readonly RecoveryBinCapture<T>[]) => void;
  /** Move an entry back out of the bin, returning the original item */
  restore:        (id: string) => T | null;
  /**
   * Move EVERY current entry back out of the bin in one operation,
   * returning all their original items (in the same order as
   * `entries`). Clears the bin in a single state update — does not
   * call restore() in a loop. Added to support a "Restore All" UI
   * action without duplicating the filtering/sorting logic already in
   * `entries` above.
   */
  restoreAll:     () => T[];
  /** Remove an entry from the bin permanently, without restoring it */
  permanentlyDelete: (id: string) => void;
  /** Empty the entire bin permanently */
  emptyBin:       () => void;
}

export function useRecoveryBin<T>(): UseRecoveryBinReturn<T> {
  const { storage } = useUserStorage();
  const [rawEntries, setRawEntries] = useState<RecoveryBinEntry<T>[]>(
    () => storage.loadRecoveryBin() as RecoveryBinEntry<T>[],
  );

  useEffect(() => {
    storage.saveRecoveryBin(rawEntries);
  }, [storage, rawEntries]);

  // Purge expired entries lazily on read, matching the pattern
  // documented in calculations/recoveryBin.ts (isExpired/purgeExpiredEntries)
  const entries = useMemo(() => {
    const now = Date.now();
    const active = rawEntries.filter((e) => !isExpired(e, now));
    // Most-recently-deleted first — serves "Undo Delete" without a
    // separate mechanism (see file header).
    return [...active].sort((a, b) => b.deletedAt - a.deletedAt);
  }, [rawEntries]);

  // If any entries expired since last load, persist the pruned list
  // (keeps LocalStorage from accumulating expired entries indefinitely)
  useEffect(() => {
    const pruned = purgeExpiredEntries(rawEntries);
    if (pruned.length !== rawEntries.length) {
      setRawEntries(pruned);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount only — subsequent expiry is handled naturally on next mount

  const softDeleteMany = useCallback((captures: readonly RecoveryBinCapture<T>[]) => {
    if (captures.length === 0) return;

    const deletedAt = Date.now();
    const newEntries = buildRecoveryBinEntries(
      captures,
      deletedAt,
      () => nextId('recovery'),
    );
    setRawEntries((prev) => [...prev, ...newEntries]);
  }, []);

  const softDelete = useCallback((item: T, label: string) => {
    softDeleteMany([{ item, label }]);
  }, [softDeleteMany]);

  const restore = useCallback((id: string): T | null => {
    const entry = rawEntries.find((e) => e.id === id);
    if (!entry) return null;
    setRawEntries((prev) => prev.filter((e) => e.id !== id));
    return entry.item;
  }, [rawEntries]);

  // Reuses the already-computed, non-expired, sorted `entries` list
  // above (no duplicate filtering) and clears the bin with the same
  // single setRawEntries([]) pattern emptyBin() already uses below —
  // one state update, not restore() called once per entry.
  const restoreAll = useCallback((): T[] => {
    const items = entries.map((e) => e.item);
    setRawEntries([]);
    return items;
  }, [entries]);

  const permanentlyDelete = useCallback((id: string) => {
    setRawEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const emptyBin = useCallback(() => {
    setRawEntries([]);
  }, []);

  return { entries, softDelete, softDeleteMany, restore, restoreAll, permanentlyDelete, emptyBin };
}
