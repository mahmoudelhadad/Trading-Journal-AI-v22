// Local store factories — SYNC_ARCHITECTURE_SPEC.md §13 Step 5 / §3.3,
// real implementations of the PushRecordStore / PullRecordStore /
// ReconciliationStore / Tier2AdmissionStore interfaces that
// pushManager.ts (Phase 4c) / pullManager.ts (Phase 4d) / scheduler.ts
// (Phase 4f) defined but deliberately never implemented ("a real
// implementation of each interface is built in a later phase" —
// pushManager.ts's own header).
//
// PURITY BOUNDARY, PRESERVED: this file takes its local read/write
// functions as INJECTED PARAMETERS (`load`/`save`, and the
// `CursorRowAccess` pair below) — it never imports services/storage.js,
// services/indexedDb.ts, or any other concrete persistence module
// itself. This keeps src/sync/ exactly as pure as it was at the end of
// Phase 4 ("this file is deliberately the only place that isn't [free
// of real-module imports]" — syncEngine.ts's header, referring to
// browser globals specifically). The concrete wiring — actually calling
// loadTrades/saveTrades/etc. — lives in services/syncStores.ts, one
// layer out, exactly where every other piece of "real" I/O in this app
// already lives (storage.js, supabaseClient.ts, indexedDb.ts).
//
// PHASE 6b — ASYNC-CAPABLE `load`/`save` (SYNC_ARCHITECTURE_SPEC.md
// §3.4): "IndexedDB is asynchronous. Every place in the codebase that
// currently assumes a synchronous local read must change." Every
// `load`/`save`/`remove` parameter below (and `CursorRowAccess.get`/
// `.set`, since `sync_cursors` is itself one of the stores §13 Step 6
// migrates) is now typed `MaybePromise<T>` rather than a bare `T`, and
// every call site `await`s it. `await` on an already-resolved,
// non-Promise value settles on the same microtask turn, so this is a
// strictly backward-compatible widening: services/syncStores.ts's
// current LocalStorage-backed callers (still plain, synchronous
// functions) continue to work completely unchanged — this phase does
// NOT wire IndexedDB into the app, per its approved scope. When a later
// phase injects genuinely async, IndexedDB-backed `load`/`save`
// functions instead, every method here already awaits correctly with
// zero further changes to this file. No new locking/mutex was added
// alongside this — that is not part of this phase's approved scope, and
// the spec's own concurrency model (single leader tab, IndexedDB's
// native per-transaction atomicity once actually adopted, Web Locks for
// leadership) does not call for one at this layer.
//
// TWO SHAPES, PER §3.1: a Collection (trades, accounts) stores each
// record as its own array element with metadata flattened onto it
// (`Stamped<T>`, record.ts). A Singleton (lists, settings) stores
// exactly one `SingletonRecord<T>`, content under `.data`. Each gets
// its own factory below; both produce the same four-store bundle.
//
// CONTENT IS OPAQUE, EVERYWHERE: exactly like PushableRecord.content /
// PulledRow.content in the modules this file implements interfaces
// for, this file never interprets business content — for singletons
// it is typed `Record<string, unknown>` rather than importing
// `ListsState`/`AppSettings` from hooks/, which would reintroduce the
// hook-importing-into-business-logic dependency direction the Phase 20
// H-2 fix eliminated for RawTrade/Account (see types/trade.ts,
// types/account.ts). src/sync/ has no reason to know either shape.

import type { SyncMetadata, SingletonRecord } from '@sync/record.js';
import { refreshForLocalWrite } from '@sync/record.js';
import type { PushRecordStore, PushableRecord, PushMetadataPatch } from '@sync/pushManager.js';
import type { PullRecordStore, PullCursor, MatchedLocalRecord } from '@sync/pullManager.js';
import type { SyncMetadataPatch } from '@sync/conflictDetector.js';
import type {
  ReconciliationStore,
  ReconciliationRecord,
  Tier2AdmissionStore,
  SyncTableName,
} from '@sync/scheduler.js';

// ─── Async-capable injection (Phase 6b) ───────────────────────────────
//
// A value, or a Promise of that value — see the file header. Every
// injected read/write function in this file is typed with this instead
// of a bare type, and every call site `await`s it.

export type MaybePromise<T> = T | Promise<T>;

// ─── Cursor row access (§3.3) ───────────────────────────────────────
//
// `sync_cursors` holds one row per table, matching §3.3's row shape
// exactly: `cursorUpdatedAt`, `cursorId`, `lastServerObservedAt`,
// `lastAttemptAt`, `consecutiveFailures`. Only the first three are
// actually read/written by any Phase 4 interface — `PullRecordStore`
// exposes no accessor for table-level pull backoff, so
// `lastAttemptAt`/`consecutiveFailures` have no consumer yet. They are
// still modeled in the stored shape (present in `TableCursorRow`,
// defaulted below) so the local schema matches the specification
// exactly rather than silently narrowing it to only what's wired up
// today — a future phase adding table-level pull backoff would extend
// `PullRecordStore`'s interface (Phase 4d, would need its own
// approval) and find the storage already shaped correctly, with
// nothing to migrate.

export interface TableCursorRow {
  cursorUpdatedAt: string | null;
  cursorId: string | null;
  lastServerObservedAt: string | null;
  /** Table-level pull backoff (§3.3). No PullRecordStore accessor consumes this yet — see comment above. */
  lastAttemptAt: string | null;
  /** Table-level pull backoff (§3.3). No PullRecordStore accessor consumes this yet — see comment above. */
  consecutiveFailures: number;
}

export interface CursorRowAccess {
  get(table: SyncTableName): MaybePromise<TableCursorRow>;
  set(table: SyncTableName, patch: Partial<TableCursorRow>): MaybePromise<void>;
}

export const DEFAULT_CURSOR_ROW: TableCursorRow = {
  cursorUpdatedAt: null,
  cursorId: null,
  lastServerObservedAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
};

function buildCursorMethods(table: SyncTableName, cursors: CursorRowAccess) {
  return {
    async getCursor(): Promise<PullCursor> {
      const row = await cursors.get(table);
      return { updatedAt: row.cursorUpdatedAt, id: row.cursorId };
    },
    async advanceCursor(cursor: PullCursor): Promise<void> {
      await cursors.set(table, { cursorUpdatedAt: cursor.updatedAt, cursorId: cursor.id });
    },
    async getLastServerObservedAt(): Promise<string | null> {
      const row = await cursors.get(table);
      return row.lastServerObservedAt;
    },
    async setLastServerObservedAt(timestamp: string): Promise<void> {
      await cursors.set(table, { lastServerObservedAt: timestamp });
    },
  };
}

// ─── Shared bundle type ──────────────────────────────────────────────

export interface LocalStoreBundle {
  pushStore: PushRecordStore;
  pullStore: PullRecordStore;
  reconciliationStore: ReconciliationStore;
  tier2AdmissionStore: Tier2AdmissionStore;
}

// ─── Collections (trades, accounts) ──────────────────────────────────

const METADATA_KEYS = [
  'syncId', 'syncStatus', 'localUpdatedAt', 'baseUpdatedAt', 'deletedAt',
  'consecutiveFailures', 'nextEligibleAttemptAt', 'lastError', 'conflictResolutionLog',
] as const satisfies readonly (keyof SyncMetadata)[];

/** Splits a stamped collection element into its metadata and opaque business content. */
function splitMetadata<T extends SyncMetadata>(record: T): { metadata: SyncMetadata; content: Record<string, unknown> } {
  const metadata = {} as SyncMetadata;
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if ((METADATA_KEYS as readonly string[]).includes(key)) {
      (metadata as unknown as Record<string, unknown>)[key] = value;
    } else {
      content[key] = value;
    }
  }
  return { metadata, content };
}

/**
 * Real store bundle for a Collection table (§3.1) — trades, accounts.
 * `load`/`save` are the table's read/write pair, injected by the caller
 * (services/syncStores.ts) so this factory itself never imports
 * concrete storage code (see file header). May be synchronous
 * (today's LocalStorage-backed callers) or asynchronous (a future
 * IndexedDB-backed caller) — see the Phase 6b header note.
 */
export function createCollectionStores<T extends SyncMetadata>(
  table: SyncTableName,
  load: () => MaybePromise<T[]>,
  save: (items: T[]) => MaybePromise<void>,
  cursors: CursorRowAccess,
): LocalStoreBundle {
  const pushStore: PushRecordStore = {
    async getPendingRecords(): Promise<PushableRecord[]> {
      const items = await load();
      return items
        .filter((r) => r.syncStatus === 'dirty' || r.syncStatus === 'pending_delete')
        .map((r) => {
          const { metadata, content } = splitMetadata(r);
          return {
            syncId: metadata.syncId,
            syncStatus: metadata.syncStatus,
            baseUpdatedAt: metadata.baseUpdatedAt,
            deletedAt: metadata.deletedAt,
            consecutiveFailures: metadata.consecutiveFailures,
            nextEligibleAttemptAt: metadata.nextEligibleAttemptAt,
            lastError: metadata.lastError,
            content,
          };
        });
    },
    async applyPatch(syncId: string, patch: PushMetadataPatch): Promise<void> {
      const items = await load();
      const idx = items.findIndex((r) => r.syncId === syncId);
      if (idx === -1) return; // record no longer exists locally — nothing to patch
      items[idx] = { ...items[idx], ...patch };
      await save(items);
    },
    async purge(syncId: string): Promise<void> {
      const items = await load();
      await save(items.filter((r) => r.syncId !== syncId));
    },
  };

  const pullStore: PullRecordStore = {
    ...buildCursorMethods(table, cursors),
    async findLocalRecordBySyncId(syncId: string): Promise<MatchedLocalRecord | null> {
      const items = await load();
      const found = items.find((r) => r.syncId === syncId);
      if (!found) return null;
      return {
        syncId: found.syncId,
        syncStatus: found.syncStatus,
        baseUpdatedAt: found.baseUpdatedAt,
        localUpdatedAt: found.localUpdatedAt,
        deletedAt: found.deletedAt,
        conflictResolutionLog: found.conflictResolutionLog,
      };
    },
    async upsertRecord(syncId: string, content: Record<string, unknown>, metadataPatch: SyncMetadataPatch): Promise<void> {
      const items = await load();
      const idx = items.findIndex((r) => r.syncId === syncId);
      // `baseUpdatedAt` in an apply_incoming patch is always the
      // incoming row's server `updated_at` (§6.1's two apply_incoming
      // rows both set it that way) — used here as `localUpdatedAt` too,
      // since this content did not originate from a local edit; using
      // the server-derived value keeps this INV-4-clean rather than
      // reaching for the device clock.
      const serverTimestamp = metadataPatch.baseUpdatedAt ?? new Date().toISOString();
      if (idx === -1) {
        const fresh = {
          ...(content as object),
          syncId,
          syncStatus: metadataPatch.syncStatus ?? 'synced',
          localUpdatedAt: serverTimestamp,
          baseUpdatedAt: metadataPatch.baseUpdatedAt ?? serverTimestamp,
          deletedAt: metadataPatch.deletedAt ?? null,
          consecutiveFailures: 0,
          nextEligibleAttemptAt: null,
          lastError: null,
          conflictResolutionLog: metadataPatch.conflictResolutionLog ?? [],
        } as unknown as T;
        items.push(fresh);
      } else {
        items[idx] = {
          ...items[idx],
          ...(content as object),
          ...metadataPatch,
          localUpdatedAt: serverTimestamp,
          // A pull-driven content overwrite discards whatever local
          // edit this device had queued; any push backoff state tied
          // to that discarded edit is now moot.
          consecutiveFailures: 0,
          nextEligibleAttemptAt: null,
          lastError: null,
        };
      }
      await save(items);
    },
    async applyMetadataPatch(syncId: string, patch: SyncMetadataPatch): Promise<void> {
      const items = await load();
      const idx = items.findIndex((r) => r.syncId === syncId);
      if (idx === -1) return;
      items[idx] = { ...items[idx], ...patch };
      await save(items);
    },
    async purge(syncId: string): Promise<void> {
      const items = await load();
      await save(items.filter((r) => r.syncId !== syncId));
    },
  };

  const reconciliationStore: ReconciliationStore = {
    async findSyncingRecords(): Promise<ReconciliationRecord[]> {
      const items = await load();
      return items
        .filter((r) => r.syncStatus === 'syncing')
        .map((r) => ({ syncId: r.syncId, deletedAt: r.deletedAt }));
    },
    async revertSyncingRecord(syncId: string, syncStatus: 'dirty' | 'pending_delete'): Promise<void> {
      const items = await load();
      const idx = items.findIndex((r) => r.syncId === syncId);
      if (idx === -1) return;
      items[idx] = { ...items[idx], syncStatus };
      await save(items);
    },
  };

  const tier2AdmissionStore: Tier2AdmissionStore = {
    async hasRecordsWithNullBaseUpdatedAt(): Promise<boolean> {
      const items = await load();
      return items.some((r) => r.baseUpdatedAt === null);
    },
  };

  return { pushStore, pullStore, reconciliationStore, tier2AdmissionStore };
}

// ─── Singletons (lists, settings) ────────────────────────────────────

/**
 * Real store bundle for a Singleton table (§3.1) — lists, settings.
 * Content lives opaquely under `.data` (never interpreted here — see
 * file header). `load`/`save` are the table's read/write pair
 * (`loadLists`/`saveLists` etc.), injected. May be synchronous or
 * asynchronous — see the Phase 6b header note.
 */
export function createSingletonStores(
  table: SyncTableName,
  load: () => MaybePromise<SingletonRecord<Record<string, unknown>> | null>,
  save: (record: SingletonRecord<Record<string, unknown>>) => MaybePromise<void>,
  cursors: CursorRowAccess,
): LocalStoreBundle {
  const pushStore: PushRecordStore = {
    async getPendingRecords(): Promise<PushableRecord[]> {
      const rec = await load();
      if (!rec || (rec.syncStatus !== 'dirty' && rec.syncStatus !== 'pending_delete')) return [];
      return [{
        syncId: rec.syncId,
        syncStatus: rec.syncStatus,
        baseUpdatedAt: rec.baseUpdatedAt,
        deletedAt: rec.deletedAt,
        consecutiveFailures: rec.consecutiveFailures,
        nextEligibleAttemptAt: rec.nextEligibleAttemptAt,
        lastError: rec.lastError,
        content: rec.data,
      }];
    },
    async applyPatch(syncId: string, patch: PushMetadataPatch): Promise<void> {
      const rec = await load();
      if (!rec || rec.syncId !== syncId) return;
      await save({ ...rec, ...patch });
    },
    async purge(): Promise<void> {
      // §9.1: Lists/Settings are singleton-per-user rows, never
      // deleted — only updated or reset. No hook ever sets
      // `pending_delete` on one, so a tombstone push success (the only
      // caller of `purge`) is structurally unreachable for this table.
      // A defensive no-op is safer than throwing if that invariant is
      // ever violated by a future bug.
    },
  };

  const pullStore: PullRecordStore = {
    ...buildCursorMethods(table, cursors),
    async findLocalRecordBySyncId(syncId: string): Promise<MatchedLocalRecord | null> {
      const rec = await load();
      if (!rec || rec.syncId !== syncId) return null;
      return {
        syncId: rec.syncId,
        syncStatus: rec.syncStatus,
        baseUpdatedAt: rec.baseUpdatedAt,
        localUpdatedAt: rec.localUpdatedAt,
        deletedAt: rec.deletedAt,
        conflictResolutionLog: rec.conflictResolutionLog,
      };
    },
    async upsertRecord(syncId: string, content: Record<string, unknown>, metadataPatch: SyncMetadataPatch): Promise<void> {
      const rec = await load();
      const serverTimestamp = metadataPatch.baseUpdatedAt ?? new Date().toISOString();
      if (!rec || rec.syncId !== syncId) {
        // A singleton "arriving new" locally is only reachable via
        // Tier 2 rule 1's first-sync path (pullManager.ts's documented
        // precondition — an ordinary incremental pull never reaches
        // this module for a table still awaiting first-sync review).
        await save({
          syncId,
          syncStatus: metadataPatch.syncStatus ?? 'synced',
          localUpdatedAt: serverTimestamp,
          baseUpdatedAt: metadataPatch.baseUpdatedAt ?? serverTimestamp,
          deletedAt: metadataPatch.deletedAt ?? null,
          consecutiveFailures: 0,
          nextEligibleAttemptAt: null,
          lastError: null,
          conflictResolutionLog: metadataPatch.conflictResolutionLog ?? [],
          data: content,
        });
        return;
      }
      await save({
        ...rec,
        ...metadataPatch,
        localUpdatedAt: serverTimestamp,
        consecutiveFailures: 0,
        nextEligibleAttemptAt: null,
        lastError: null,
        data: content,
      });
    },
    async applyMetadataPatch(syncId: string, patch: SyncMetadataPatch): Promise<void> {
      const rec = await load();
      if (!rec || rec.syncId !== syncId) return;
      await save({ ...rec, ...patch });
    },
    async purge(): Promise<void> {
      // See pushStore.purge above — structurally unreachable per §9.1.
    },
  };

  const reconciliationStore: ReconciliationStore = {
    async findSyncingRecords(): Promise<ReconciliationRecord[]> {
      const rec = await load();
      if (!rec || rec.syncStatus !== 'syncing') return [];
      return [{ syncId: rec.syncId, deletedAt: rec.deletedAt }];
    },
    async revertSyncingRecord(syncId: string, syncStatus: 'dirty' | 'pending_delete'): Promise<void> {
      const rec = await load();
      if (!rec || rec.syncId !== syncId) return;
      await save({ ...rec, syncStatus });
    },
  };

  const tier2AdmissionStore: Tier2AdmissionStore = {
    async hasRecordsWithNullBaseUpdatedAt(): Promise<boolean> {
      const rec = await load();
      return !!rec && rec.baseUpdatedAt === null;
    },
  };

  return { pushStore, pullStore, reconciliationStore, tier2AdmissionStore };
}

// ─── Tier 2 resolution (§8.2) — Phase 5e ──────────────────────────────
//
// A fifth, independent per-table storage interface — deliberately NOT
// folded into `LocalStoreBundle` (mirrors `CursorRowAccess`'s existing
// standalone-export precedent in services/syncStores.ts) — for the two
// bulk, whole-table metadata operations §8.2's resolving dialog actions
// need that none of the four existing interfaces expose:
//   - "Upload Local Data" marks EVERY local record dirty (§8.2's step-1
//     precedent for "Use Cloud Data" is whole-table, not scoped to just
//     the record(s) that triggered the escalation — see
//     src/sync/tier2Resolution.ts's header for the full reasoning).
//   - "Use Cloud Data" step 1 resets EVERY local record's sync metadata
//     to a pristine pre-first-sync shape, and step 4 purges whatever
//     the subsequent full pull didn't confirm the cloud still has.
// Cursor reset (step 2) and the pull itself (step 3) reuse existing,
// already-approved interfaces (`PullRecordStore.advanceCursor`,
// `runPullOperation`) directly — no new primitive needed for either.

export interface Tier2ResolutionStore {
  /** "Upload Local Data" (§8.2): every local record -> dirty (or pending_delete, if already tombstoned), via the same deletedAt-based branch record.ts's `refreshForLocalWrite` already uses for an ordinary local edit. Content untouched. */
  markAllDirtyForUpload(): Promise<void>;
  /** "Use Cloud Data" step 1 (§8.2): every local record -> synced, baseUpdatedAt/deletedAt null, failure/backoff cleared, conflictResolutionLog emptied. Content untouched. Field list is exactly §8.2's own enumeration — deliberately not touching `lastError`, which that list omits. */
  resetAllMetadataForCloudRefresh(): Promise<void>;
  /** "Use Cloud Data" step 4 (§8.2): purge whatever still holds `baseUpdatedAt === null && syncStatus === 'synced'` after a successful full pull — i.e. exists locally but not in the cloud. */
  purgeOrphanedSyncedRecords(): Promise<void>;
}

/**
 * Real store for a Collection table (§3.1) — trades, accounts. Same
 * `load`/`save` pair `createCollectionStores` above already takes
 * (sync- or async-capable — Phase 6b).
 */
export function createCollectionTier2ResolutionStore<T extends SyncMetadata>(
  load: () => MaybePromise<T[]>,
  save: (items: T[]) => MaybePromise<void>,
): Tier2ResolutionStore {
  return {
    async markAllDirtyForUpload(): Promise<void> {
      const items = await load();
      await save(items.map((r) => ({ ...r, ...refreshForLocalWrite(r) })));
    },
    async resetAllMetadataForCloudRefresh(): Promise<void> {
      const items = await load();
      await save(items.map((r) => ({
        ...r,
        syncStatus: 'synced' as const,
        baseUpdatedAt: null,
        deletedAt: null,
        consecutiveFailures: 0,
        nextEligibleAttemptAt: null,
        conflictResolutionLog: [] as string[],
      })));
    },
    async purgeOrphanedSyncedRecords(): Promise<void> {
      const items = await load();
      await save(items.filter((r) => !(r.baseUpdatedAt === null && r.syncStatus === 'synced')));
    },
  };
}

/**
 * Real store for a Singleton table (§3.1) — lists, settings. Takes an
 * additional `remove` callback beyond the `load`/`save` pair
 * `createSingletonStores` above uses (also sync- or async-capable —
 * Phase 6b): §9.1's "never deleted, only updated or reset" rules out
 * leaving a purged singleton in place as `synced`/`baseUpdatedAt: null`
 * forever — that combination would keep re-triggering Tier 2 rule 1's
 * admission check on every future cycle, since that check only looks at
 * `baseUpdatedAt`, not `syncStatus` (see tier2Resolution.ts's header for
 * the full trace). Removing the underlying key instead — via the
 * existing, previously-unused `storageRemove` (services/storage.js) —
 * lets `loadLists`/`loadSettings` fall back to `null`, which their own
 * callers (`useLists`/`useSettings`) already handle as "create fresh
 * defaults," exactly matching what "the cloud has nothing for this user
 * yet" actually means. This is not a *tombstone*-flavored delete (§9.1
 * is about that path specifically) — it resets the one-and-only local
 * row to its pre-existence state, symmetric with how a collection purge
 * removes rows the cloud doesn't have.
 */
export function createSingletonTier2ResolutionStore(
  load: () => MaybePromise<SingletonRecord<Record<string, unknown>> | null>,
  save: (record: SingletonRecord<Record<string, unknown>>) => MaybePromise<void>,
  remove: () => MaybePromise<void>,
): Tier2ResolutionStore {
  return {
    async markAllDirtyForUpload(): Promise<void> {
      const rec = await load();
      if (!rec) return;
      await save({ ...rec, ...refreshForLocalWrite(rec) });
    },
    async resetAllMetadataForCloudRefresh(): Promise<void> {
      const rec = await load();
      if (!rec) return;
      await save({
        ...rec,
        syncStatus: 'synced' as const,
        baseUpdatedAt: null,
        deletedAt: null,
        consecutiveFailures: 0,
        nextEligibleAttemptAt: null,
        conflictResolutionLog: [] as string[],
      });
    },
    async purgeOrphanedSyncedRecords(): Promise<void> {
      const rec = await load();
      if (rec && rec.baseUpdatedAt === null && rec.syncStatus === 'synced') {
        await remove();
      }
    },
  };
}
