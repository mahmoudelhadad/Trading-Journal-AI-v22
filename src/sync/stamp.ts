// One-time (per record) sync-metadata stamping pass —
// SYNC_ARCHITECTURE_SPEC.md §13 Step 3.
//
// Adds the full §3.2 metadata field set to every existing local
// record. Resumable in place and idempotent at record granularity: a
// record that already carries `syncStatus` is skipped, a record that
// does not is stamped (§13 Step 3's "Restart safety" paragraph) — so
// this is safe to invoke on every app load, not just once ever. That
// matters beyond the initial rollout: any record created before the
// hooks are made sync-aware (Phase 5) also lacks metadata and is
// picked up the next time this pass runs.
//
// Writes only additive fields and never alters existing business
// content — collections (trades, accounts) are stamped by adding the
// metadata fields directly onto each array element; singletons
// (lists, settings) are stamped by wrapping the existing stored value
// as a SingletonRecord's `data`. Only pre-existing, non-empty stored
// values are wrapped — a key that has never been saved at all is left
// untouched; the owning hook's own initializer creates a fresh record
// the first time that happens (§6.1: "User creates a record" -> `dirty`).

import { STORAGE_KEYS, type createStorageService } from '@services/storage.js';
import { createSyncMetadata, isStamped } from '@sync/record.js';

type ScopedStorageService = ReturnType<typeof createStorageService>;

function stampCollection(storage: ScopedStorageService, key: string): void {
  const raw = storage.storageGet(key);
  if (!Array.isArray(raw) || raw.length === 0) return;

  let changed = false;
  const stamped = raw.map((item) => {
    if (isStamped(item)) return item;
    changed = true;
    return { ...createSyncMetadata(), ...item };
  });

  if (changed) storage.storageSet(key, stamped);
}

function stampSingleton(storage: ScopedStorageService, key: string): void {
  const raw = storage.storageGet(key);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return; // nothing existing to wrap
  if (isStamped(raw)) return; // already stamped

  storage.storageSet(key, { ...createSyncMetadata(), data: raw });
}

export function runSyncMetadataStampingPass(storage?: ScopedStorageService): void {
  if (!storage) throw new Error('Authenticated scoped storage is required for metadata stamping.');
  stampCollection(storage, STORAGE_KEYS.TRADES);
  stampCollection(storage, STORAGE_KEYS.ACCOUNTS);
  stampSingleton(storage, STORAGE_KEYS.LISTS);
  stampSingleton(storage, STORAGE_KEYS.SETTINGS);
}
