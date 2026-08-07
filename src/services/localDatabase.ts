/**
 * services/localDatabase.ts
 *
 * Phase 6e — SYNC_ARCHITECTURE_SPEC.md §13 Step 6 sub-step 5, §5.3.
 *
 * THE STORAGE RESOLVER: the application's permanent local-data access
 * layer. Every consumer of trades/accounts/lists/settings/sync_cursors
 * is intended to read and write through this module and nothing else,
 * so that exactly one place in the codebase decides *which* local
 * backend is authoritative right now.
 *
 * ─── The rule this module implements (sub-step 5, verbatim) ───────────
 *
 *   "on every app load, before trusting IndexedDB for any business-data
 *    read or write, check for the completion marker.
 *      - Marker present: IndexedDB is authoritative. Proceed normally.
 *      - Marker absent: [...] restart the entire copy phase from
 *        LocalStorage, which remains untouched and correct throughout."
 *
 * So: marker present -> IndexedDB. Marker absent -> LocalStorage.
 *
 * ─── The LocalStorage branch is FINAL architecture, not a bridge ──────
 *
 * It is required by two independent, permanent clauses:
 *   - §5.3: "Followers wait on the completion marker (§13 Step 6)
 *     before reading business data from IndexedDB, and CONTINUE READING
 *     LOCALSTORAGE until it appears." A follower tab that opens while
 *     the leader's cutover is still running must serve real data from
 *     LocalStorage — not block, and not read a half-copied IndexedDB.
 *   - §13 Step 6 sub-step 6: "LocalStorage data is *not* cleared
 *     immediately — retained for a window as a rollback safety net."
 *     A rollback that had no reader would be no rollback at all.
 * It is also the correct destination for a browser where IndexedDB is
 * unavailable outright (some private-browsing modes), since
 * `isCutoverComplete()` fails safe to `false` there (storageCutover.ts).
 *
 * ─── BACKEND RESOLUTION: A MONOTONIC ONE-WAY LATCH ────────────────────
 *
 * The completion marker is *monotonic*: it transitions absent ->
 * present exactly once and never returns. sub-step 4 sanctions exactly
 * one writer and one direction ("write a single completion flag into
 * `migration_state`. This is the last write of the entire cutover"),
 * and sub-step 5's discard path deliberately excludes `migration_state`
 * from what it clears (see `clearBusinessDataIndexedDb`).
 *
 * That single property determines this module's entire design, because
 * the two possible answers are NOT symmetric:
 *
 *   - `indexeddb` is TERMINAL. Once observed, it can never become
 *     wrong. It is latched and the marker is never consulted again for
 *     the remainder of the session.
 *   - `localstorage` is PROVISIONAL. It means only "the marker had not
 *     appeared yet, as of the last time we looked." It is therefore
 *     never cached: every resolution attempt while unlatched re-reads
 *     the marker from IndexedDB, which is shared storage visible to
 *     every tab of this origin.
 *
 * WHY THIS IS WHAT §5.3 ACTUALLY REQUIRES, AND WHY THERE IS NO
 * CROSS-TAB SIGNALLING HERE: §5.3 says followers "continue reading
 * LocalStorage UNTIL IT APPEARS" — each tab is required to *observe*
 * the marker appearing. Module state (`let`) is per-tab, so a design
 * that cached the provisional answer would leave a follower reading
 * LocalStorage forever after the leader's cutover completed in another
 * tab — writing to a backend that is no longer authoritative, and
 * losing that data on the next load. Re-reading while unlatched closes
 * that hole at its source: every tab asks the shared source of truth
 * directly, so no tab can miss the transition.
 *
 * Deliberately NOT used, and why: BroadcastChannel, `storage` events,
 * an IndexedDB version bump, and polling were all evaluated and
 * rejected. Correctness here must not depend on a message being
 * delivered — a tab that is mid-load, or frozen in the bfcache, or
 * discarded and restored on mobile, can miss a broadcast and would then
 * stay stale permanently, which is the exact failure being eliminated.
 * A `storage`-event signal would additionally create a second copy of
 * the completion flag in LocalStorage, contradicting sub-step 4's
 * "a SINGLE completion flag into `migration_state`". Polling only
 * bounds the staleness window rather than removing it. Asking the
 * shared marker directly has none of these failure modes and needs no
 * coordination between tabs at all.
 *
 * Cost profile, stated plainly: the extra marker read is paid only
 * while unlatched — that is, only before the cutover has completed on
 * this device, which is a transient state. Once latched, resolution is
 * a boolean check with no I/O, so the app's permanent steady state is
 * free. (A browser where IndexedDB is unavailable outright never
 * latches, and so keeps paying a failed-open per resolution. That is a
 * performance characteristic, not a correctness one, and is left
 * unoptimized deliberately: caching "unavailable" would wrongly
 * persist a condition that can change within a session.)
 *
 * On sub-step 5's "on every app load" wording: checking more often than
 * that while unlatched is not a deviation — it fails safe toward more
 * scrutiny, exactly as §8.2's retention-window check does ("This fails
 * safe toward *more* scrutiny, never less"). After latching, the marker
 * is consulted less often than "every app load", which is equally safe
 * because the answer is by then permanent.
 *
 * ─── SCOPE — 6e only, per explicit approval ───────────────────────────
 *
 * This module is COMPLETELY INERT: nothing imports it. No reader has
 * been switched, no cutover is wired, no startup integration, no
 * feature flag, no namespacing. `useTrades`/`useAccounts`/`useLists`/
 * `useSettings`/`syncStores.ts`/`backupService.ts`/`AuthContext.tsx`/
 * `syncEngine.ts`/`App.jsx`/`main.jsx` are all untouched this phase and
 * still talk to LocalStorage directly, exactly as before.
 *
 * ─── Why every function here is async, including the LocalStorage path ─
 *
 * §3.4: "IndexedDB is asynchronous. Every place in the codebase that
 * currently assumes a synchronous local read must change." A resolver
 * whose return type changed depending on which backend answered would
 * push that difference onto every caller — so the async signature is
 * uniform, and the LocalStorage branch simply resolves immediately.
 * This is the same widening `MaybePromise` already applied to
 * src/sync/localStores.ts's injected primitives in Phase 6b, and it is
 * why those factories can consume this module unchanged later.
 *
 * ─── Disclosed residual limits (not solvable at this layer) ───────────
 *
 *   - A microscopic check-then-act window remains between reading the
 *     marker and performing the write. Eliminating it would require an
 *     atomic transaction spanning LocalStorage and IndexedDB, which
 *     does not exist. Re-reading per resolution narrows it to a single
 *     JS turn, the minimum any design can achieve.
 *   - A follower's write to LocalStorage landing after the cutover's
 *     source snapshot but before the marker is written is not copied —
 *     the cutover reads the source once and never re-runs. That is a
 *     property of §13 Step 6's own design, not of this module, and no
 *     resolver behavior can compensate for it.
 */

import {
  loadTrades as loadTradesLocalStorage,
  saveTrades as saveTradesLocalStorage,
  loadAccounts as loadAccountsLocalStorage,
  saveAccounts as saveAccountsLocalStorage,
  loadLists as loadListsLocalStorage,
  saveLists as saveListsLocalStorage,
  loadSettings as loadSettingsLocalStorage,
  saveSettings as saveSettingsLocalStorage,
  loadSyncCursors,
  saveSyncCursors,
  storageRemove,
  STORAGE_KEYS,
} from '@services/storage.js';
import {
  loadTradesIndexedDb,
  saveTradesIndexedDb,
  loadAccountsIndexedDb,
  saveAccountsIndexedDb,
  loadListsIndexedDb,
  saveListsIndexedDb,
  removeListsIndexedDb,
  loadSettingsIndexedDb,
  saveSettingsIndexedDb,
  removeSettingsIndexedDb,
  indexedDbCursors,
  loadMigrationStateIndexedDb,
} from '@services/indexedDbStores.js';
import { isCutoverComplete } from '@services/storageCutover.js';
import { DEFAULT_CURSOR_ROW, type CursorRowAccess, type TableCursorRow } from '@sync/localStores.js';
import type { SyncTableName } from '@sync/scheduler.js';
import type { SingletonRecord } from '@sync/record.js';
import type { RawTrade } from '@apptypes/trade.js';
import type { Account } from '@apptypes/account.js';
import type { createStorageService } from '@services/storage.js';

type SingletonPayload = SingletonRecord<Record<string, unknown>>;

// ─── Backend resolution (see the header's latch section) ───────────────

export type LocalDatabaseBackend = 'indexeddb' | 'localstorage';

/**
 * The terminal half of the latch. Set exactly once, when the marker is
 * first observed present, and never cleared. Guarded by the fact that
 * the marker itself can never revert (sub-step 4).
 */
let latchedToIndexedDb = false;

/**
 * Single-flight guard for an in-progress marker read. Concurrent
 * callers arriving while a read is already outstanding share that one
 * read instead of issuing duplicates. Sharing is safe precisely because
 * the marker is monotonic: the worst a shared answer can be is the
 * value from a few microseconds earlier, which is indistinguishable
 * from having been called a few microseconds sooner.
 *
 * Cleared as soon as the read settles, so that a `false` result is
 * never retained — an unlatched resolver must re-read the marker on the
 * next resolution attempt, which is what lets a follower tab observe a
 * cutover completed by the leader in another tab (§5.3).
 */
let inFlightMarkerCheck: Promise<boolean> | null = null;

async function usingIndexedDb(): Promise<boolean> {
  // Terminal state — the marker is never consulted again this session.
  if (latchedToIndexedDb) return true;

  if (!inFlightMarkerCheck) {
    inFlightMarkerCheck = isCutoverComplete()
      .then((complete) => {
        if (complete) latchedToIndexedDb = true;
        return complete;
      })
      .finally(() => {
        // Always released, including on an unexpected rejection, so a
        // single failed read can never wedge the resolver permanently.
        inFlightMarkerCheck = null;
      });
  }

  return inFlightMarkerCheck;
}

/** The backend currently in effect. Exposed for diagnostics and for tests; carries no side effect beyond the latch described above. */
export async function getBackend(): Promise<LocalDatabaseBackend> {
  return (await usingIndexedDb()) ? 'indexeddb' : 'localstorage';
}

// ─── Trades ────────────────────────────────────────────────────────────

export async function loadTrades(): Promise<RawTrade[]> {
  return (await usingIndexedDb()) ? loadTradesIndexedDb() : (loadTradesLocalStorage() as RawTrade[]);
}

export async function saveTrades(trades: RawTrade[]): Promise<void> {
  if (await usingIndexedDb()) await saveTradesIndexedDb(trades);
  else saveTradesLocalStorage(trades);
}

// ─── Accounts ──────────────────────────────────────────────────────────
// `null` for "nothing saved yet" is preserved on both branches — it is
// the existing contract `useAccounts` depends on to fall back to
// DEFAULT_ACCOUNTS, and this module must not quietly normalize it away.

export async function loadAccounts(): Promise<Account[] | null> {
  return (await usingIndexedDb()) ? loadAccountsIndexedDb() : (loadAccountsLocalStorage() as Account[] | null);
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  if (await usingIndexedDb()) await saveAccountsIndexedDb(accounts);
  else saveAccountsLocalStorage(accounts);
}

// ─── Lists (singleton) ─────────────────────────────────────────────────

export async function loadLists(): Promise<SingletonPayload | null> {
  return (await usingIndexedDb()) ? loadListsIndexedDb() : (loadListsLocalStorage() as SingletonPayload | null);
}

export async function saveLists(record: SingletonPayload): Promise<void> {
  if (await usingIndexedDb()) await saveListsIndexedDb(record);
  else saveListsLocalStorage(record);
}

export async function removeLists(): Promise<void> {
  if (await usingIndexedDb()) await removeListsIndexedDb();
  else storageRemove(STORAGE_KEYS.LISTS);
}

// ─── Settings (singleton) ──────────────────────────────────────────────

export async function loadSettings(): Promise<SingletonPayload | null> {
  return (await usingIndexedDb()) ? loadSettingsIndexedDb() : (loadSettingsLocalStorage() as SingletonPayload | null);
}

export async function saveSettings(record: SingletonPayload): Promise<void> {
  if (await usingIndexedDb()) await saveSettingsIndexedDb(record);
  else saveSettingsLocalStorage(record);
}

export async function removeSettings(): Promise<void> {
  if (await usingIndexedDb()) await removeSettingsIndexedDb();
  else storageRemove(STORAGE_KEYS.SETTINGS);
}

// ─── sync_cursors ──────────────────────────────────────────────────────

/**
 * The one LocalStorage `CursorRowAccess` implementation, shared across
 * all four tables — each call is scoped by its own `table` argument.
 *
 * RELOCATED HERE IN PHASE 6f, VERBATIM, FOR ONE REASON ONLY: to break a
 * structural import cycle. It previously lived in services/syncStores.ts,
 * which this module imported it from. Phase 6f points `syncStores.ts` at
 * this module for all of its local reads and writes, which would have
 * made the two modules mutually importing — the codebase's first real
 * circular dependency, against the "zero real circular dependencies"
 * result the Phase 20 dependency audit established (MIGRATION_NOTES.md
 * AN-013). After 6f this module is its only consumer, so this is now
 * also its natural home rather than merely a convenient one.
 *
 * The implementation below is byte-for-byte identical to the original;
 * only the imports it closes over moved with it. No behavior changed.
 */
export const localStorageCursors: CursorRowAccess = {
  get(table: SyncTableName): TableCursorRow {
    const all = loadSyncCursors();
    return all[table] ?? DEFAULT_CURSOR_ROW;
  },
  set(table: SyncTableName, patch: Partial<TableCursorRow>): void {
    const all = loadSyncCursors();
    const current = all[table] ?? DEFAULT_CURSOR_ROW;
    saveSyncCursors({ ...all, [table]: { ...current, ...patch } });
  },
};

/**
 * Resolver-backed `CursorRowAccess` (src/sync/localStores.ts). Satisfies
 * that interface's `MaybePromise` signatures (Phase 6b) with genuinely
 * async methods, so `createCollectionStores`/`createSingletonStores` can
 * consume this in place of `localStorageCursors` or `indexedDbCursors`
 * with no change to either factory.
 */
export const cursors: CursorRowAccess = {
  async get(table: SyncTableName): Promise<TableCursorRow> {
    return (await usingIndexedDb()) ? indexedDbCursors.get(table) : localStorageCursors.get(table);
  },
  async set(table: SyncTableName, patch: Partial<TableCursorRow>): Promise<void> {
    if (await usingIndexedDb()) await indexedDbCursors.set(table, patch);
    else localStorageCursors.set(table, patch);
  },
};

type ScopedStorageService = ReturnType<typeof createStorageService>;

export interface ScopedLocalDatabase {
  readonly backend: 'localstorage';
  loadTrades(): Promise<RawTrade[]>;
  saveTrades(trades: RawTrade[]): Promise<void>;
  loadAccounts(): Promise<Account[] | null>;
  saveAccounts(accounts: Account[]): Promise<void>;
  loadLists(): Promise<SingletonPayload | null>;
  saveLists(record: SingletonPayload): Promise<void>;
  removeLists(): Promise<void>;
  loadSettings(): Promise<SingletonPayload | null>;
  saveSettings(record: SingletonPayload): Promise<void>;
  removeSettings(): Promise<void>;
  cursors: CursorRowAccess;
}

/** Phase 32B resolver: permanently LocalStorage-only for one captured user scope. */
export function createScopedLocalDatabase(storage: ScopedStorageService): ScopedLocalDatabase {
  const scopedCursors: CursorRowAccess = {
    get(table: SyncTableName): TableCursorRow {
      const all = storage.loadSyncCursors() as Record<string, TableCursorRow>;
      return all[table] ?? DEFAULT_CURSOR_ROW;
    },
    set(table: SyncTableName, patch: Partial<TableCursorRow>): void {
      const all = storage.loadSyncCursors() as Record<string, TableCursorRow>;
      const current = all[table] ?? DEFAULT_CURSOR_ROW;
      storage.saveSyncCursors({ ...all, [table]: { ...current, ...patch } });
    },
  };
  return Object.freeze({
    backend: 'localstorage' as const,
    async loadTrades() { return storage.loadTrades() as RawTrade[]; },
    async saveTrades(value: RawTrade[]) { storage.saveTrades(value); },
    async loadAccounts() { return storage.loadAccounts() as Account[] | null; },
    async saveAccounts(value: Account[]) { storage.saveAccounts(value); },
    async loadLists() { return storage.loadLists() as SingletonPayload | null; },
    async saveLists(value: SingletonPayload) { storage.saveLists(value); },
    async removeLists() { storage.storageRemove(STORAGE_KEYS.LISTS); },
    async loadSettings() { return storage.loadSettings() as SingletonPayload | null; },
    async saveSettings(value: SingletonPayload) { storage.saveSettings(value); },
    async removeSettings() { storage.storageRemove(STORAGE_KEYS.SETTINGS); },
    cursors: scopedCursors,
  });
}

export type GlobalIndexedDbPreflight =
  | { kind: 'clear' }
  | { kind: 'blocked'; reason: 'marker_present' | 'marker_read_failed' };

async function readExistingGlobalMigrationState() {
  if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') {
    throw new Error('IndexedDB database enumeration is unavailable.');
  }
  const databases = await indexedDB.databases();
  if (!databases.some((database) => database.name === 'trading-journal-ai')) return null;
  return loadMigrationStateIndexedDb();
}

/** Read-only preflight. It never creates an absent global database. */
export async function preflightGlobalIndexedDb(
  readMarker: () => Promise<{ cutoverCompletedAt: string | null } | null> = readExistingGlobalMigrationState,
): Promise<GlobalIndexedDbPreflight> {
  try {
    const state = await readMarker();
    return state?.cutoverCompletedAt != null
      ? { kind: 'blocked', reason: 'marker_present' }
      : { kind: 'clear' };
  } catch {
    return { kind: 'blocked', reason: 'marker_read_failed' };
  }
}
