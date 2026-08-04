/**
 * services/indexedDbStores.ts
 *
 * Phase 6c — SYNC_ARCHITECTURE_SPEC.md §1, §13 Step 6.
 *
 * IndexedDB-backed equivalents of services/storage.js's per-table
 * load/save/remove functions and services/syncStores.ts's cursor-access
 * object, built on services/indexedDb.ts (Phase 6a). Sits at the same
 * layer storage.js does — this file does NOT call
 * src/sync/localStores.ts's `createCollectionStores`/`createSingletonStores`
 * factories itself (that composition is a later phase's job); it only
 * provides the primitives those factories take as `load`/`save`
 * parameters, which are `MaybePromise`-typed since Phase 6b specifically
 * so a genuinely async implementation like this one can be dropped in
 * later without touching localStores.ts again.
 *
 * SCOPE — 6c only, per explicit approval:
 *   - Concrete load/save/remove/cursor primitives for trades, accounts,
 *     lists, settings, sync_cursors.
 *   - NOT wired into the app: this file is not imported by anything
 *     else. `services/syncStores.ts` is untouched and remains the
 *     live, LocalStorage-backed source of truth.
 *
 * PHASE 6d ADDITION: `migration_state`'s record shape and its
 * read/write functions (declared-only in 6c) are now defined at the
 * bottom of this file, alongside the two whole-database helpers §13
 * Step 6 needs — `clearBusinessDataIndexedDb` (sub-step 5's discard)
 * and `countBusinessRecordsIndexedDb` (sub-step 3's verification).
 * The cutover ORCHESTRATION that calls them lives in
 * services/storageCutover.ts; this file still only provides
 * primitives. Still not wired into the app.
 *
 * PHASE 6e ADDITION (G-1): §3.4's connection-lifecycle notifications —
 * `onIndexedDbVersionChangeForcedClose` and `onIndexedDbBlocked` — are
 * now passed through to `openIndexedDb` and exposed as subscriptions.
 * See the "Connection lifecycle notifications" section below. Still not
 * wired into the app; services/localDatabase.ts (the permanent access
 * layer built this phase) is likewise inert.
 *   - No namespacing (§3.5 / AN-015 item 2 stays exactly as deferred as
 *     it already was), no caching of read results, no batching beyond
 *     what a single save() call already needs, no repository
 *     abstraction, no indexes beyond each store's own primary key.
 *
 * "KEEP BEHAVIOR IDENTICAL, DO NOT REDESIGN THE CONTRACT" — applied
 * function-by-function: every export here mirrors one storage.js
 * function's exact signature (same nullability, same "array vs null"
 * convention) or syncStores.ts's `CursorRowAccess` shape, so that
 * swapping which one gets injected into localStores.ts's factories
 * (a later, separately-approved phase) is a pure substitution.
 *
 * WHY save(items[]) STAYS A FULL-STORE REWRITE, NOT A PER-RECORD DIFF:
 * localStores.ts's factories call `load()` once, mutate zero or more
 * elements in memory, then call `save()` with the WHOLE resulting
 * array/record — exactly mirroring today's `saveTrades(trades)`
 * full-blob-rewrite behavior. Staying faithful to that contract (per
 * explicit instruction not to redesign it) means every `save`/`remove`
 * below is `clear the store, then write the given data` — not a
 * per-record IndexedDB update. Singletons need the same `clear` step,
 * not just an overwriting `put`: a singleton's `syncId` CAN legitimately
 * change across its lifetime (pullStore.upsertRecord adopts the cloud's
 * `id` on first sync per record.ts's own documented rule), and `put`
 * only overwrites a record sharing the same key — without clearing
 * first, an old-syncId row would linger alongside the new one, silently
 * producing two rows in a store §3.1 requires to hold at most one.
 *
 * DISCLOSED, KNOWN GAP — NOT SILENTLY GLOSSED OVER: `clear()` then
 * `putAll()`/`put()` are two separate IndexedDB transactions (Phase 6a's
 * `IndexedDbHandle` exposes no combined-transaction primitive, and
 * extending it is outside this phase's scope, which is limited to
 * creating this one new file). A crash between the two leaves a store
 * empty rather than at its old or new value — narrower than
 * LocalStorage's single-`setItem` write, and narrower than true
 * atomicity. Zero live consequence today (nothing calls this file yet);
 * flagged here for whichever future phase actually wires this in.
 *
 * ERROR HANDLING — ONE DELIBERATE DEVIATION FROM storage.js: storage.js
 * silently swallows every read/write failure ("Matches original app
 * behavior" — a LocalStorage-era fidelity decision, not a general
 * principle). This file instead throws on failure. Reason: §3.4
 * requires a quota-exhaustion (or other local persistence) failure to
 * eventually be surfaced to the user as "a distinct, blocking notice —
 * never folded into the ordinary 'sync pending' indicator" — silently
 * swallowing it here would make that impossible for a later phase to
 * implement without rewriting this file. Deciding how/where to catch
 * and present these thrown errors is that later phase's job, not
 * decided here.
 *
 * KEYING:
 *   - trades / accounts / lists / settings: `keyPath: 'syncId'`
 *     (SyncMetadata.syncId, record.ts) — the same identity
 *     src/sync/localStores.ts already uses to address every record.
 *   - sync_cursors: `keyPath: 'tableName'` — one row per table, per
 *     §3.3's own description ("holding one row per synced table").
 *     `TableCursorRow` (localStores.ts) carries no `tableName` field
 *     itself — this file adds it only to the on-disk shape, at this
 *     module's boundary; `CursorRowAccess` callers still only ever see
 *     a plain `TableCursorRow`.
 *   - migration_state: `keyPath: 'id'` — one row under the fixed key
 *     `MIGRATION_STATE_ID`; shape defined by `MigrationStateRecord`
 *     (Phase 6d, bottom of this file).
 *
 * SINGLETON LOOKUP: a singleton store never has a caller-known key in
 * advance — `syncId` is generated when the record is first created, not
 * a fixed constant. `load` therefore reads the whole store (`getAll`)
 * and takes its one element (or `null`, matching `loadLists`/
 * `loadSettings`'s existing "nothing saved yet" contract exactly).
 */

import {
  openIndexedDb,
  type IndexedDbHandle,
  type IndexedDbStoreSpec,
  type IndexedDbErrorKind,
  type IndexedDbFailure,
} from './indexedDb.js';
import { DEFAULT_CURSOR_ROW, type CursorRowAccess, type TableCursorRow } from '@sync/localStores.js';
import type { SingletonRecord } from '@sync/record.js';
import type { SyncTableName } from '@sync/scheduler.js';
import type { RawTrade } from '@apptypes/trade.js';
import type { Account } from '@apptypes/account.js';

// ─── Error propagation (Phase 6g-1) ─────────────────────────────────────
//
// Smallest possible change to carry `IndexedDbFailure.kind` (indexedDb.js,
// Phase 6a) out to this file's callers, per explicit instruction: no new
// exception class, no change to any function's public signature or
// calling convention — every function still just `throw`s a plain
// `Error`. The only addition is one extra property on that same Error,
// via one small shared helper instead of the previous 17 separate
// `throw new Error(...)` call sites (each of which is replaced with a
// call to it, message text unchanged). This is what lets the Phase 6g-1
// local-persistence notification layer distinguish a quota-exhaustion
// failure (§3.4: "surfaced to the user as a distinct, blocking notice")
// from any other failure kind, without any other caller's existing
// `catch (err) { err.message }` code needing to change at all.

/** A plain `Error` — never a new exception class — with the originating `IndexedDbFailure.kind` attached. */
export interface IndexedDbCallError extends Error {
  kind: IndexedDbErrorKind;
}

function throwIndexedDbFailure(prefix: string, failure: IndexedDbFailure): never {
  const error = new Error(`${prefix}: ${failure.message}`) as IndexedDbCallError;
  error.kind = failure.kind;
  throw error;
}

// ─── Database schema ───────────────────────────────────────────────────

const DATABASE_NAME = 'trading-journal-ai';
const DATABASE_VERSION = 1;

const STORE_NAMES = {
  TRADES: 'trades',
  ACCOUNTS: 'accounts',
  LISTS: 'lists',
  SETTINGS: 'settings',
  SYNC_CURSORS: 'sync_cursors',
  MIGRATION_STATE: 'migration_state',
} as const;

const STORES: readonly IndexedDbStoreSpec[] = [
  { name: STORE_NAMES.TRADES, keyPath: 'syncId' },
  { name: STORE_NAMES.ACCOUNTS, keyPath: 'syncId' },
  { name: STORE_NAMES.LISTS, keyPath: 'syncId' },
  { name: STORE_NAMES.SETTINGS, keyPath: 'syncId' },
  { name: STORE_NAMES.SYNC_CURSORS, keyPath: 'tableName' },
  { name: STORE_NAMES.MIGRATION_STATE, keyPath: 'id' },
];

/**
 * The five stores §13 Step 6 sub-step 2 enumerates as the cutover's
 * copy set. `migration_state` is deliberately NOT among them — it is
 * the cutover's own bookkeeping, not business data, and sub-step 5
 * scopes its discard to "whatever partial IndexedDB *business data*
 * exists."
 */
export const BUSINESS_STORE_NAMES = [
  STORE_NAMES.TRADES,
  STORE_NAMES.ACCOUNTS,
  STORE_NAMES.LISTS,
  STORE_NAMES.SETTINGS,
  STORE_NAMES.SYNC_CURSORS,
] as const;

export type BusinessStoreName = (typeof BUSINESS_STORE_NAMES)[number];

// ─── Shared connection ─────────────────────────────────────────────────
//
// Opened lazily, once, and reused — mirrors how a single Supabase client
// instance (services/supabaseClient.ts) is shared rather than
// reconnected per call. Not exported: nothing outside this file needs a
// raw `IndexedDbHandle`, only the typed functions below.

let handlePromise: Promise<IndexedDbHandle> | null = null;

// ─── Connection lifecycle notifications (§3.4) — Phase 6e (G-1) ────────
//
// §3.4 makes version-upgrade handling mandatory in EVERY tab: "every
// open connection, in every tab, must register a handler for the
// 'another connection is requesting a version upgrade' event, and
// respond by closing its own connection (prompting that tab to reload
// before continuing to use the database)."
//
// Phase 6a's `openIndexedDb` already performs the CLOSING half
// unconditionally (`db.onversionchange = () => { db.close(); ... }`) —
// it cannot be forgotten. What was missing until now is the
// NOTIFICATION half: this module never passed the callbacks through, so
// a forced close was invisible and every later operation simply failed
// with an opaque "connection is closed" error. These two subscriptions
// close that gap. Set-based add/return-unsubscribe, matching the
// existing `onDirtyPing`/`onTier2StateChange`/`onSyncStatusChange`
// pattern in src/sync/crossTabCoordinator.ts rather than inventing a
// second convention.
//
// DELIBERATELY NOT AUTO-REOPENED: `handlePromise` is left pointing at
// the now-closed handle, so every subsequent operation keeps failing
// loudly instead of silently succeeding against a stale connection.
// Transparently reopening would re-acquire the OLD version and block
// the upgrading tab all over again — precisely the deadlock §3.4 exists
// to prevent. The specified response is for the tab to RELOAD, which is
// a UI decision owned by whoever subscribes, not something this module
// may take on the user's behalf.

const versionChangeHandlers = new Set<() => void>();
const blockedHandlers = new Set<() => void>();

/**
 * Fires when this tab's connection has been force-closed because
 * another connection is opening a higher database version (§3.4). The
 * connection is already closed when this fires; the subscriber is
 * expected to prompt the user to reload. Returns an unsubscribe fn.
 */
export function onIndexedDbVersionChangeForcedClose(handler: () => void): () => void {
  versionChangeHandlers.add(handler);
  return () => versionChangeHandlers.delete(handler);
}

/**
 * Fires when this tab's open request is being held up by another
 * connection still holding an older version open. Informational — the
 * request keeps waiting and may still succeed (see indexedDb.ts).
 * Returns an unsubscribe fn.
 */
export function onIndexedDbBlocked(handler: () => void): () => void {
  blockedHandlers.add(handler);
  return () => blockedHandlers.delete(handler);
}

function getHandle(): Promise<IndexedDbHandle> {
  if (!handlePromise) {
    handlePromise = openIndexedDb({
      name: DATABASE_NAME,
      version: DATABASE_VERSION,
      stores: STORES,
      onVersionChangeForcedClose: () => {
        versionChangeHandlers.forEach((handler) => handler());
      },
      onBlocked: () => {
        blockedHandlers.forEach((handler) => handler());
      },
    }).then((result) => {
      if (result.kind === 'failure') {
        handlePromise = null; // don't permanently cache a failed open — a later call may retry
        throwIndexedDbFailure(`Failed to open IndexedDB database "${DATABASE_NAME}"`, result.error);
      }
      return result.value;
    });
  }
  return handlePromise;
}

// ─── Trades (collection) ────────────────────────────────────────────────

export async function loadTradesIndexedDb(): Promise<RawTrade[]> {
  const handle = await getHandle();
  const result = await handle.getAll<RawTrade>(STORE_NAMES.TRADES);
  if (result.kind === 'failure') throwIndexedDbFailure('Failed to load trades from IndexedDB', result.error);
  return result.value;
}

export async function saveTradesIndexedDb(trades: RawTrade[]): Promise<void> {
  const handle = await getHandle();
  const clearResult = await handle.clear(STORE_NAMES.TRADES);
  if (clearResult.kind === 'failure') throwIndexedDbFailure('Failed to save trades to IndexedDB', clearResult.error);
  const putResult = await handle.putAll(STORE_NAMES.TRADES, trades);
  if (putResult.kind === 'failure') throwIndexedDbFailure('Failed to save trades to IndexedDB', putResult.error);
}

// ─── Accounts (collection) ──────────────────────────────────────────────

/** Mirrors `loadAccounts()` (storage.js): `null` if nothing saved yet — caller should use DEFAULT_ACCOUNTS. */
export async function loadAccountsIndexedDb(): Promise<Account[] | null> {
  const handle = await getHandle();
  const result = await handle.getAll<Account>(STORE_NAMES.ACCOUNTS);
  if (result.kind === 'failure') throwIndexedDbFailure('Failed to load accounts from IndexedDB', result.error);
  return result.value.length > 0 ? result.value : null;
}

export async function saveAccountsIndexedDb(accounts: Account[]): Promise<void> {
  const handle = await getHandle();
  const clearResult = await handle.clear(STORE_NAMES.ACCOUNTS);
  if (clearResult.kind === 'failure') throwIndexedDbFailure('Failed to save accounts to IndexedDB', clearResult.error);
  const putResult = await handle.putAll(STORE_NAMES.ACCOUNTS, accounts);
  if (putResult.kind === 'failure') throwIndexedDbFailure('Failed to save accounts to IndexedDB', putResult.error);
}

// ─── Lists / Settings (singletons) ──────────────────────────────────────

async function loadSingleton(storeName: string): Promise<SingletonRecord<Record<string, unknown>> | null> {
  const handle = await getHandle();
  const result = await handle.getAll<SingletonRecord<Record<string, unknown>>>(storeName);
  if (result.kind === 'failure') throwIndexedDbFailure(`Failed to load "${storeName}" from IndexedDB`, result.error);
  return result.value[0] ?? null;
}

async function saveSingleton(storeName: string, record: SingletonRecord<Record<string, unknown>>): Promise<void> {
  const handle = await getHandle();
  // Clear first — see file header ("WHY save(items[]) STAYS A
  // FULL-STORE REWRITE") for why an overwriting `put` alone is not
  // sufficient here.
  const clearResult = await handle.clear(storeName);
  if (clearResult.kind === 'failure') throwIndexedDbFailure(`Failed to save "${storeName}" to IndexedDB`, clearResult.error);
  const putResult = await handle.put(storeName, record);
  if (putResult.kind === 'failure') throwIndexedDbFailure(`Failed to save "${storeName}" to IndexedDB`, putResult.error);
}

async function removeSingleton(storeName: string): Promise<void> {
  const handle = await getHandle();
  const result = await handle.clear(storeName);
  if (result.kind === 'failure') throwIndexedDbFailure(`Failed to remove "${storeName}" from IndexedDB`, result.error);
}

/** Mirrors `loadLists()` (storage.js): `null` if nothing stamped yet — caller (useLists) creates a fresh record in that case. */
export function loadListsIndexedDb(): Promise<SingletonRecord<Record<string, unknown>> | null> {
  return loadSingleton(STORE_NAMES.LISTS);
}

export function saveListsIndexedDb(record: SingletonRecord<Record<string, unknown>>): Promise<void> {
  return saveSingleton(STORE_NAMES.LISTS, record);
}

/** Mirrors `storageRemove(STORAGE_KEYS.LISTS)` — used by Phase 5e's Tier2ResolutionStore `remove` callback. */
export function removeListsIndexedDb(): Promise<void> {
  return removeSingleton(STORE_NAMES.LISTS);
}

/** Mirrors `loadSettings()` (storage.js): `null` if nothing stamped yet — caller (useSettings) creates a fresh record in that case. */
export function loadSettingsIndexedDb(): Promise<SingletonRecord<Record<string, unknown>> | null> {
  return loadSingleton(STORE_NAMES.SETTINGS);
}

export function saveSettingsIndexedDb(record: SingletonRecord<Record<string, unknown>>): Promise<void> {
  return saveSingleton(STORE_NAMES.SETTINGS, record);
}

/** Mirrors `storageRemove(STORAGE_KEYS.SETTINGS)` — used by Phase 5e's Tier2ResolutionStore `remove` callback. */
export function removeSettingsIndexedDb(): Promise<void> {
  return removeSingleton(STORE_NAMES.SETTINGS);
}

// ─── sync_cursors ────────────────────────────────────────────────────────
//
// On-disk shape only, private to this file — see file header's KEYING
// note. `CursorRowAccess` callers never see the `tableName` field.
interface StoredCursorRow extends TableCursorRow {
  tableName: SyncTableName;
}

async function getCursorRow(table: SyncTableName): Promise<TableCursorRow> {
  const handle = await getHandle();
  const result = await handle.get<StoredCursorRow>(STORE_NAMES.SYNC_CURSORS, table);
  if (result.kind === 'failure') throwIndexedDbFailure(`Failed to read sync cursor for "${table}" from IndexedDB`, result.error);
  if (!result.value) return DEFAULT_CURSOR_ROW;
  const { tableName: _tableName, ...row } = result.value;
  return row;
}

async function setCursorRow(table: SyncTableName, patch: Partial<TableCursorRow>): Promise<void> {
  const handle = await getHandle();
  const current = await getCursorRow(table);
  const updated: StoredCursorRow = { ...current, ...patch, tableName: table };
  const result = await handle.put(STORE_NAMES.SYNC_CURSORS, updated);
  if (result.kind === 'failure') throwIndexedDbFailure(`Failed to write sync cursor for "${table}" to IndexedDB`, result.error);
}

/** IndexedDB-backed `CursorRowAccess` (src/sync/localStores.ts) — mirrors `localStorageCursors` (services/syncStores.ts). */
export const indexedDbCursors: CursorRowAccess = {
  get: getCursorRow,
  set: setCursorRow,
};

// ─── migration_state (§13 Step 6 sub-step 1) — Phase 6d ─────────────────
//
// The cutover's own progress record, deliberately separate from
// business data ("not to be confused with the Step 3 per-record `dirty`
// stamping, which is business-data state").
//
// WHY THIS RECORD CARRIES ONLY A COMPLETION MARKER, NOT GRANULAR
// PER-STORE PROGRESS: sub-step 1 describes it as tracking "the
// cutover's own progress", but sub-step 5 then removes every possible
// use for granular progress — "the previous cutover attempt (if any) is
// treated as incomplete, REGARDLESS OF HOW FAR IT GOT. Do not attempt
// to resume a partial copy." A per-store progress field would therefore
// be written but never read, and worse, would invite a future reader to
// implement exactly the incremental resume sub-step 5 forbids. The only
// state any decision in this design actually branches on is
// marker-present vs. marker-absent, so that is the only state stored.
//
// TIMESTAMP RATHER THAN BOOLEAN: same amount of code, strictly more
// information, and it is what sub-step 6's "retained for a window as a
// rollback safety net" would need to compute a window from without a
// later schema change. The window itself is NOT implemented here (this
// phase never clears LocalStorage at all — see storageCutover.ts).
// Written from the local clock, which is correct and INV-4-clean: this
// is local bookkeeping about a purely local operation, the same
// category as `lastAttemptAt`'s backoff timing, never a
// server-authoritative comparison.

/** This store holds exactly one row, under this fixed key. */
export const MIGRATION_STATE_ID = 'cutover';

export interface MigrationStateRecord {
  /** Fixed primary key (`keyPath: 'id'`) — always `MIGRATION_STATE_ID`. */
  id: string;
  /** §13 Step 6 sub-step 4's completion marker. `null` = cutover not complete. */
  cutoverCompletedAt: string | null;
}

export async function loadMigrationStateIndexedDb(): Promise<MigrationStateRecord | null> {
  const handle = await getHandle();
  const result = await handle.get<MigrationStateRecord>(STORE_NAMES.MIGRATION_STATE, MIGRATION_STATE_ID);
  if (result.kind === 'failure') throwIndexedDbFailure('Failed to read migration state from IndexedDB', result.error);
  return result.value;
}

export async function saveMigrationStateIndexedDb(record: MigrationStateRecord): Promise<void> {
  const handle = await getHandle();
  const result = await handle.put(STORE_NAMES.MIGRATION_STATE, record);
  if (result.kind === 'failure') throwIndexedDbFailure('Failed to write migration state to IndexedDB', result.error);
}

// ─── Whole-database helpers for the cutover (§13 Step 6) — Phase 6d ─────

/**
 * Sub-step 5's "discard whatever partial IndexedDB business data
 * exists". Clears exactly the five business stores; `migration_state`
 * is deliberately left alone (see `BUSINESS_STORE_NAMES`).
 */
export async function clearBusinessDataIndexedDb(): Promise<void> {
  const handle = await getHandle();
  for (const storeName of BUSINESS_STORE_NAMES) {
    const result = await handle.clear(storeName);
    if (result.kind === 'failure') {
      throwIndexedDbFailure(`Failed to clear "${storeName}" in IndexedDB`, result.error);
    }
  }
}

/**
 * Sub-step 3's verification read — per-store record counts, queried
 * from IndexedDB itself.
 *
 * DISCLOSED READING of "read the copied records back out of IndexedDB
 * and confirm the record count (per store) matches": this uses
 * IndexedDB's own `count()` rather than materializing every record via
 * `getAll()`. `count()` queries the same object stores and answers the
 * exact assertion the sentence makes (counts match, per store), without
 * deserializing a potentially large trades store purely to read
 * `.length`. Records are stored as structured clones, not JSON strings,
 * so a successful `putAll` cannot leave a row that exists-but-fails-to-
 * parse — the failure mode a full read-back would additionally catch
 * does not exist here.
 */
export async function countBusinessRecordsIndexedDb(): Promise<Record<BusinessStoreName, number>> {
  const handle = await getHandle();
  const counts = {} as Record<BusinessStoreName, number>;
  for (const storeName of BUSINESS_STORE_NAMES) {
    const result = await handle.count(storeName);
    if (result.kind === 'failure') {
      throwIndexedDbFailure(`Failed to count "${storeName}" in IndexedDB`, result.error);
    }
    counts[storeName] = result.value;
  }
  return counts;
}
