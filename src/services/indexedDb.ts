/**
 * services/indexedDb.ts
 *
 * Phase 6a — SYNC_ARCHITECTURE_SPEC.md §3.4, §13 Step 6.
 *
 * A standalone, generic IndexedDB primitive: open a database with a
 * fixed set of named object stores, and do get/getAll/put/putAll/
 * delete/clear/count against any one of them. Zero knowledge of
 * trades/accounts/lists/settings/sync_cursors/migration_state — those
 * are business/table-specific concepts that a later phase (6c/6d)
 * layers on top, exactly the way `services/storage.js`'s typed
 * `loadTrades`/`saveTrades`/etc. accessors sit on top of its own
 * generic `storageGet`/`storageSet` primitives (this file's LocalStorage
 * equivalent).
 *
 * SCOPE — 6a only: this file is self-contained and is not imported by
 * anything else yet. No wiring into `src/sync/localStores.ts`, no
 * business store definitions, no cutover/copy logic (§13 Step 6's
 * `migration_state` record and copy/verify/completion-marker sequence
 * — that's a later, separately-approved phase). Nothing here executes
 * until a future phase calls `openIndexedDb()`.
 *
 * RESULT TYPE, NOT EXCEPTIONS: mirrors the `{kind: 'success'|'failure'}`
 * convention already used throughout src/sync/ and services/syncTransport.ts
 * (`PushTransportResult`, `PullTransportResult`, etc.) — every method
 * here returns an `IndexedDbResult<T>` rather than throwing, including
 * for a synchronous exception thrown by the underlying IndexedDB call
 * itself (caught and reclassified, never left to escape uncaught).
 *
 * §3.4's MANDATORY VERSION-UPGRADE PROTOCOL: "every open connection, in
 * every tab, must register a handler for the 'another connection is
 * requesting a version upgrade' event, and respond by closing its own
 * connection... Without this, a future schema upgrade in one tab can
 * hang indefinitely if any other tab holds a stale connection open to
 * the old version." `openIndexedDb()` registers this handler itself —
 * every connection this module hands out already closes itself on a
 * version-change event; a caller cannot forget to wire this up. Deciding
 * what "prompting that tab to reload" means (a banner, an auto-reload,
 * etc.) is a UI decision, deliberately left to whoever consumes
 * `onVersionChangeForcedClose` — this module makes no UI choice.
 * `onblocked` (another connection preventing a version bump from
 * proceeding at all) is likewise surfaced as an informational callback,
 * not a terminal failure — the underlying open request can still
 * succeed once the blocking connection closes, so failing the whole
 * `openIndexedDb()` call immediately would both misreport a transient
 * condition and leak the eventual successful connection.
 *
 * §3.4's QUOTA-EXHAUSTION REQUIREMENT: "if a local write fails due to
 * quota exhaustion... it is surfaced to the user as a distinct, blocking
 * notice — never folded into the ordinary 'sync pending' indicator."
 * This module's job is only to make that distinction *detectable* —
 * `IndexedDbErrorKind`'s `quota_exceeded` case is classified separately
 * from every other failure kind. Actually presenting that notice to the
 * user is a later phase's concern.
 */

// ─── Types ─────────────────────────────────────────────────────────────

export interface IndexedDbStoreSpec {
  /** Object store name. */
  name: string;
  /** Primary key field on every record written to this store. */
  keyPath: string;
}

export interface OpenIndexedDbOptions {
  name: string;
  version: number;
  stores: readonly IndexedDbStoreSpec[];
  /**
   * Fired once this connection has been forced closed because another
   * connection (this tab or another) is opening a higher version — see
   * this file's header. The connection is already closed by the time
   * this fires.
   */
  onVersionChangeForcedClose?: () => void;
  /**
   * Fired if another open connection is preventing this open request
   * from proceeding. Informational only — the request keeps waiting;
   * it does not fail `openIndexedDb()`'s returned promise by itself.
   */
  onBlocked?: () => void;
}

export type IndexedDbErrorKind = 'quota_exceeded' | 'blocked' | 'unavailable' | 'unknown';

export interface IndexedDbFailure {
  kind: IndexedDbErrorKind;
  message: string;
}

export type IndexedDbResult<T> =
  | { kind: 'success'; value: T }
  | { kind: 'failure'; error: IndexedDbFailure };

export interface IndexedDbHandle {
  /** Fetch one record by key, or `null` if no record has that key. */
  get<T>(storeName: string, key: IDBValidKey): Promise<IndexedDbResult<T | null>>;
  /** Fetch every record currently in a store. */
  getAll<T>(storeName: string): Promise<IndexedDbResult<T[]>>;
  /** Insert or overwrite one record, keyed by the store's `keyPath`. */
  put<T>(storeName: string, record: T): Promise<IndexedDbResult<void>>;
  /** Insert or overwrite many records in a single transaction. */
  putAll<T>(storeName: string, records: readonly T[]): Promise<IndexedDbResult<void>>;
  /** Remove one record by key. A missing key is not an error — a no-op success. */
  delete(storeName: string, key: IDBValidKey): Promise<IndexedDbResult<void>>;
  /** Remove every record in a store. */
  clear(storeName: string): Promise<IndexedDbResult<void>>;
  /** Number of records currently in a store. */
  count(storeName: string): Promise<IndexedDbResult<number>>;
  /** Closes this connection. Safe to call more than once. */
  close(): void;
}

const CLOSED_ERROR: IndexedDbFailure = {
  kind: 'unknown',
  message: 'This IndexedDB connection is closed.',
};

// ─── Availability ────────────────────────────────────────────────────

/**
 * True if this browsing context exposes a usable `indexedDB` global.
 * False in some private-browsing modes and non-browser contexts —
 * checked defensively before ever calling `indexedDB.open()`, matching
 * `services/storage.js`'s own try/catch defensiveness around
 * `localStorage`.
 */
export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

// ─── Error classification ──────────────────────────────────────────────

function classifyError(err: unknown): IndexedDbFailure {
  if (err instanceof DOMException) {
    if (err.name === 'QuotaExceededError') {
      return { kind: 'quota_exceeded', message: err.message || 'Storage quota exceeded.' };
    }
    return { kind: 'unknown', message: err.message || err.name };
  }
  if (err instanceof Error) {
    return { kind: 'unknown', message: err.message };
  }
  return { kind: 'unknown', message: 'Unknown IndexedDB error.' };
}

// ─── Open ──────────────────────────────────────────────────────────────

/**
 * Opens (creating/upgrading if necessary) a database with exactly the
 * object stores listed in `options.stores`. Idempotent to call again
 * with the same `name`/`version`/`stores` — `onupgradeneeded` only
 * creates a store if it doesn't already exist, so a repeat open against
 * an already-current schema is a plain open, not a re-migration.
 */
export async function openIndexedDb(options: OpenIndexedDbOptions): Promise<IndexedDbResult<IndexedDbHandle>> {
  if (!isIndexedDbAvailable()) {
    return { kind: 'failure', error: { kind: 'unavailable', message: 'IndexedDB is not available in this browsing context.' } };
  }

  return new Promise((resolve) => {
    let settled = false;
    let request: IDBOpenDBRequest;

    try {
      request = indexedDB.open(options.name, options.version);
    } catch (err) {
      resolve({ kind: 'failure', error: classifyError(err) });
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of options.stores) {
        if (!db.objectStoreNames.contains(store.name)) {
          db.createObjectStore(store.name, { keyPath: store.keyPath });
        }
      }
    };

    request.onblocked = () => {
      options.onBlocked?.();
    };

    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        options.onVersionChangeForcedClose?.();
      };
      resolve({ kind: 'success', value: createHandle(db) });
    };

    request.onerror = () => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'failure', error: classifyError(request.error) });
    };
  });
}

// ─── Handle ────────────────────────────────────────────────────────────

function requestToResult<T>(request: IDBRequest<T>): Promise<IndexedDbResult<T>> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve({ kind: 'success', value: request.result });
    request.onerror = () => resolve({ kind: 'failure', error: classifyError(request.error) });
  });
}

function runWriteTransaction(
  db: IDBDatabase,
  storeName: string,
  action: (store: IDBObjectStore) => void,
): Promise<IndexedDbResult<void>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      action(tx.objectStore(storeName));
      tx.oncomplete = () => resolve({ kind: 'success', value: undefined });
      tx.onerror = () => resolve({ kind: 'failure', error: classifyError(tx.error) });
      tx.onabort = () => resolve({ kind: 'failure', error: classifyError(tx.error) });
    } catch (err) {
      resolve({ kind: 'failure', error: classifyError(err) });
    }
  });
}

function createHandle(db: IDBDatabase): IndexedDbHandle {
  let closed = false;

  return {
    async get<T>(storeName: string, key: IDBValidKey): Promise<IndexedDbResult<T | null>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeName, 'readonly');
      } catch (err) {
        return { kind: 'failure', error: classifyError(err) };
      }
      const result = await requestToResult<T | undefined>(tx.objectStore(storeName).get(key));
      if (result.kind === 'failure') return result;
      return { kind: 'success', value: result.value ?? null };
    },

    async getAll<T>(storeName: string): Promise<IndexedDbResult<T[]>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeName, 'readonly');
      } catch (err) {
        return { kind: 'failure', error: classifyError(err) };
      }
      return requestToResult<T[]>(tx.objectStore(storeName).getAll());
    },

    async put<T>(storeName: string, record: T): Promise<IndexedDbResult<void>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      return runWriteTransaction(db, storeName, (store) => {
        store.put(record);
      });
    },

    async putAll<T>(storeName: string, records: readonly T[]): Promise<IndexedDbResult<void>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      return runWriteTransaction(db, storeName, (store) => {
        for (const record of records) store.put(record);
      });
    },

    async delete(storeName: string, key: IDBValidKey): Promise<IndexedDbResult<void>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      return runWriteTransaction(db, storeName, (store) => {
        store.delete(key);
      });
    },

    async clear(storeName: string): Promise<IndexedDbResult<void>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      return runWriteTransaction(db, storeName, (store) => {
        store.clear();
      });
    },

    async count(storeName: string): Promise<IndexedDbResult<number>> {
      if (closed) return { kind: 'failure', error: CLOSED_ERROR };
      let tx: IDBTransaction;
      try {
        tx = db.transaction(storeName, 'readonly');
      } catch (err) {
        return { kind: 'failure', error: classifyError(err) };
      }
      return requestToResult<number>(tx.objectStore(storeName).count());
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
