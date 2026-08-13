/**
 * services/marketDataStore.test.ts
 *
 * B1 — characterization tests for the persistence shell: commit
 * ordering, atomic-visibility discipline, the deletion tombstone, the
 * fail-safe clear order, and Journal isolation.
 *
 * The real IndexedDB and the real Web Lock are HOST behaviour that a
 * Node-only harness structurally cannot reach (Playbook §24). They are
 * proven at Runtime Acceptance. What IS proven here is the decision and
 * ordering logic, exercised against a recording fake handle and an
 * injected exclusive runner — the same "inject the primitive, test the
 * logic" pattern services/storage.test.ts already uses.
 *
 * SYNTHETIC DATA ONLY.
 */

import { describe, expect, it } from 'vitest';
import {
  commitImport,
  deleteSeries,
  clearHistoricalCache,
  createIndexedDbChunkSource,
  type CommitImportInput,
  type ExclusiveRunner,
} from './marketDataStore.js';
import {
  MARKET_DATA_DB_NAME,
  MARKET_DATA_DB_VERSION,
  MARKET_DATA_STORE_NAMES,
  MARKET_DATA_STORES,
  MARKET_DATA_MUTATION_LOCK,
  CLEAR_STORE_ORDER,
} from './marketDataDb.js';
import {
  seriesIdOf,
  chunkIdOf,
  type HistoricalBar,
  type HistoricalSeriesIdentity,
  type HistoricalSeriesRecord,
} from '@apptypes/marketData.js';
import type { IndexedDbHandle, IndexedDbResult } from './indexedDb.js';

const MAR01_0500 = 1_456_808_400_000;
const MINUTE = 60_000;

const NQ_SERIES: HistoricalSeriesIdentity = {
  root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m',
};
const NQ_ID = seriesIdOf(NQ_SERIES);

function bar(t: number, close = 4197): HistoricalBar {
  return { t, o: close, h: close, l: close, c: close, v: 1 };
}

function importInput(bars: HistoricalBar[]): CommitImportInput {
  return {
    series:                    NQ_SERIES,
    bars,
    sourceRowCount:            bars.length,
    warnings:                  { offTick: 0, outOfOrder: 0, inFileDuplicates: 0 },
    source:                    'ninjatrader',
    dataType:                  'Last',
    sourceTimeZone:            'UTC',
    sourceTimestampConvention: 'end-of-bar',
    sourceChecksumSha256:      'b'.repeat(64),
    importedAt:                1_700_000_000_000,
  };
}

// ─── Recording fake handle ────────────────────────────────────

type Op = { kind: string; store: string; key?: string };

interface FakeHandle extends IndexedDbHandle {
  ops: Op[];
  records: Map<string, Map<string, unknown>>;
  failOn: (kind: string, store: string) => void;
}

function ok<T>(value: T): IndexedDbResult<T> {
  return { kind: 'success', value };
}

function createFakeHandle(seed: Record<string, Record<string, unknown>> = {}): FakeHandle {
  const ops: Op[] = [];
  const records = new Map<string, Map<string, unknown>>();
  for (const store of MARKET_DATA_STORES) {
    records.set(store.name, new Map(Object.entries(seed[store.name] ?? {})));
  }
  let failKind: string | null = null;
  let failStore: string | null = null;

  const failure = (): IndexedDbResult<never> => ({
    kind: 'failure', error: { kind: 'unknown', message: 'injected failure' },
  });
  const shouldFail = (kind: string, store: string) => failKind === kind && failStore === store;

  const handle: FakeHandle = {
    ops,
    records,
    failOn: (kind, store) => { failKind = kind; failStore = store; },

    async get<T>(store: string, key: IDBValidKey) {
      ops.push({ kind: 'get', store, key: String(key) });
      if (shouldFail('get', store)) return failure();
      return ok((records.get(store)?.get(String(key)) as T | undefined) ?? null);
    },
    async getAll<T>(store: string) {
      ops.push({ kind: 'getAll', store });
      if (shouldFail('getAll', store)) return failure();
      return ok([...(records.get(store)?.values() ?? [])] as T[]);
    },
    async put<T>(store: string, record: T) {
      const keyPath = MARKET_DATA_STORES.find((s) => s.name === store)?.keyPath ?? 'id';
      const key = String((record as Record<string, unknown>)[keyPath]);
      ops.push({ kind: 'put', store, key });
      if (shouldFail('put', store)) return failure();
      records.get(store)?.set(key, record);
      return ok(undefined);
    },
    async putAll<T>(store: string, list: readonly T[]) {
      ops.push({ kind: 'putAll', store });
      if (shouldFail('putAll', store)) return failure();
      for (const record of list) await handle.put(store, record);
      return ok(undefined);
    },
    async delete(store: string, key: IDBValidKey) {
      ops.push({ kind: 'delete', store, key: String(key) });
      if (shouldFail('delete', store)) return failure();
      records.get(store)?.delete(String(key));
      return ok(undefined);
    },
    async clear(store: string) {
      ops.push({ kind: 'clear', store });
      if (shouldFail('clear', store)) return failure();
      records.get(store)?.clear();
      return ok(undefined);
    },
    async count(store: string) {
      ops.push({ kind: 'count', store });
      return ok(records.get(store)?.size ?? 0);
    },
    close() { /* no-op in the fake */ },
  };
  return handle;
}

/** Passthrough exclusive runner — isolates ordering logic from the lock. */
const runNow: ExclusiveRunner = async (fn) => ({ acquired: true, value: await fn() });

/** Models a host with no origin-wide lock primitive. */
const noLock: ExclusiveRunner = async () => ({ acquired: false });

const SERIES_STORE = MARKET_DATA_STORE_NAMES.SERIES;
const CHUNK_STORE = MARKET_DATA_STORE_NAMES.BAR_CHUNKS;

function activeRecord(activeChunks: Record<string, number>, barCount: number): HistoricalSeriesRecord {
  return {
    seriesId: NQ_ID,
    series:   NQ_SERIES,
    state:    'active',
    committed: {
      activeChunks,
      observedFirstUtcMs: MAR01_0500,
      observedLastUtcMs:  MAR01_0500 + MINUTE,
      barCount,
    },
    provenance: { imports: [] },
  };
}

// ─── Database identity / Journal isolation ────────────────────

describe('market-data database identity', () => {
  it('is a separate database from the Journal database', () => {
    expect(MARKET_DATA_DB_NAME).toBe('trading-journal-ai-marketdata');
    expect(MARKET_DATA_DB_NAME).not.toBe('trading-journal-ai');
    expect(MARKET_DATA_DB_VERSION).toBe(1);
  });

  it('declares exactly two stores and no Journal store name', () => {
    const journalStores = ['trades', 'accounts', 'lists', 'settings', 'sync_cursors', 'migration_state'];
    const names = MARKET_DATA_STORES.map((s) => s.name);
    expect(names).toEqual(['series', 'bar_chunks']);
    for (const name of names) expect(journalStores).not.toContain(name);
  });

  it('names the origin-wide mutation lock', () => {
    expect(MARKET_DATA_MUTATION_LOCK).toBe('trading-journal-ai-marketdata:mutation');
  });
});

// ─── Commit ordering and atomic visibility ────────────────────

describe('commitImport', () => {
  it('writes every chunk BEFORE the manifest that references it', async () => {
    const handle = createFakeHandle();
    const result = await commitImport(handle, importInput([bar(MAR01_0500)]), { runExclusive: runNow });
    expect(result.ok).toBe(true);

    const writes = handle.ops.filter((op) => op.kind === 'put');
    expect(writes.map((op) => op.store)).toEqual([CHUNK_STORE, SERIES_STORE]);

    const manifest = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord;
    for (const [day, revision] of Object.entries(manifest.committed.activeChunks)) {
      expect(handle.records.get(CHUNK_STORE)?.has(chunkIdOf(NQ_ID, day, revision))).toBe(true);
    }
  });

  it('reads committed state only AFTER the exclusive runner has been entered', async () => {
    const handle = createFakeHandle();
    let inside = false;
    const readsBeforeLock: Op[] = [];
    const watched = new Proxy(handle, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function' && (prop === 'get' || prop === 'getAll')) {
          return (...args: unknown[]) => {
            if (!inside) readsBeforeLock.push({ kind: String(prop), store: String(args[0]) });
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return value;
      },
    }) as FakeHandle;

    const gated: ExclusiveRunner = async (fn) => {
      inside = true;
      const value = await fn();
      inside = false;
      return { acquired: true, value };
    };

    await commitImport(watched, importInput([bar(MAR01_0500)]), { runExclusive: gated });
    expect(readsBeforeLock).toEqual([]);
  });

  it('writes nothing at all when a chunk write fails', async () => {
    const handle = createFakeHandle();
    handle.failOn('put', CHUNK_STORE);
    const result = await commitImport(handle, importInput([bar(MAR01_0500)]), { runExclusive: runNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('write_failed');
    expect(handle.records.get(SERIES_STORE)?.size).toBe(0);
    expect(handle.ops.some((op) => op.kind === 'put' && op.store === SERIES_STORE)).toBe(false);
  });

  it('leaves previously committed state untouched when a later day fails', async () => {
    const existing = activeRecord({ '2016-03-01': 1 }, 1);
    const handle = createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: existing },
      [CHUNK_STORE]: {
        [chunkIdOf(NQ_ID, '2016-03-01', 1)]: {
          chunkId: chunkIdOf(NQ_ID, '2016-03-01', 1), seriesId: NQ_ID, day: '2016-03-01', revision: 1,
          t: [MAR01_0500], o: [4197], h: [4197], l: [4197], c: [4197], v: [1],
        },
      },
    });
    handle.failOn('put', CHUNK_STORE);

    const result = await commitImport(
      handle, importInput([bar(MAR01_0500 + 86_400_000)]), { runExclusive: runNow },
    );
    expect(result.ok).toBe(false);
    const manifest = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord;
    expect(manifest.committed.activeChunks).toEqual({ '2016-03-01': 1 });
    expect(manifest.committed.barCount).toBe(1);
  });

  it('rejects a conflicting re-import with zero writes', async () => {
    const existing = activeRecord({ '2016-03-01': 1 }, 1);
    const handle = createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: existing },
      [CHUNK_STORE]: {
        [chunkIdOf(NQ_ID, '2016-03-01', 1)]: {
          chunkId: chunkIdOf(NQ_ID, '2016-03-01', 1), seriesId: NQ_ID, day: '2016-03-01', revision: 1,
          t: [MAR01_0500], o: [4197], h: [4197], l: [4197], c: [4197], v: [1],
        },
      },
    });
    const result = await commitImport(
      handle, importInput([bar(MAR01_0500, 9999)]), { runExclusive: runNow },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
    expect(handle.ops.some((op) => op.kind === 'put')).toBe(false);
  });

  it('refuses to import into a deleting series, with zero writes', async () => {
    const deleting: HistoricalSeriesRecord = { ...activeRecord({ '2016-03-01': 1 }, 1), state: 'deleting' };
    const handle = createFakeHandle({ [SERIES_STORE]: { [NQ_ID]: deleting } });
    const result = await commitImport(handle, importInput([bar(MAR01_0500)]), { runExclusive: runNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('series_deleting');
    expect(handle.ops.some((op) => op.kind === 'put')).toBe(false);
  });

  it('performs zero mutation when no origin-wide lock is available', async () => {
    const handle = createFakeHandle();
    const result = await commitImport(handle, importInput([bar(MAR01_0500)]), { runExclusive: noLock });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mutation_lock_unavailable');
    expect(handle.ops).toEqual([]);
  });

  it('rejects a zero-bar import outright, writing nothing, when no series exists', async () => {
    const handle = createFakeHandle();
    const result = await commitImport(handle, importInput([]), { runExclusive: runNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_import');
    expect(typeof result.message).toBe('string');
    expect(handle.ops.some((op) => op.kind === 'put' || op.kind === 'delete')).toBe(false);
    expect(handle.records.get(SERIES_STORE)?.size).toBe(0);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
  });

  it('rejects a zero-bar import against an EXISTING series, leaving the whole record value-identical', async () => {
    const existing = activeRecord({ '2016-03-01': 1 }, 1);
    const snapshot = structuredClone(existing);
    const handle = createFakeHandle({ [SERIES_STORE]: { [NQ_ID]: existing } });

    const result = await commitImport(handle, importInput([]), { runExclusive: runNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_import');

    // The COMPLETE stored record must be value-identical, field for field.
    const after = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord;
    expect(after).toEqual(snapshot);
    expect(after.state).toBe('active');
    expect(after.committed).toEqual(snapshot.committed);
    expect(after.provenance.imports).toHaveLength(0);
    expect(handle.ops.some((op) => op.kind === 'put' || op.kind === 'delete')).toBe(false);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
  });

  it('rejects a zero-bar import even for a series that is being deleted', async () => {
    const deleting: HistoricalSeriesRecord = { ...activeRecord({ '2016-03-01': 1 }, 1), state: 'deleting' };
    const handle = createFakeHandle({ [SERIES_STORE]: { [NQ_ID]: deleting } });
    const result = await commitImport(handle, importInput([]), { runExclusive: runNow });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('empty_import');
    expect(handle.ops.some((op) => op.kind === 'put' || op.kind === 'delete')).toBe(false);
  });

  it('FAILS CLOSED when the manifest references a chunk that is proven missing', async () => {
    // Manifest says 2016-03-01 is at r1, but that chunk record does not exist.
    const existing = activeRecord({ '2016-03-01': 1 }, 1);
    const snapshot = structuredClone(existing);
    const handle = createFakeHandle({ [SERIES_STORE]: { [NQ_ID]: existing } });

    const result = await commitImport(
      handle, importInput([bar(MAR01_0500 + 5 * MINUTE)]), { runExclusive: runNow },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('integrity_violation');
    // No silent repair: nothing written, nothing bumped, nothing recorded.
    expect(handle.ops.some((op) => op.kind === 'put' || op.kind === 'delete')).toBe(false);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
    const after = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord;
    expect(after).toEqual(snapshot);
    expect(after.committed.activeChunks).toEqual({ '2016-03-01': 1 });
    expect(after.committed.barCount).toBe(1);
    expect(after.provenance.imports).toHaveLength(0);
  });

  it('does not over-reject: a missing chunk on an UNAFFECTED day is not consulted', async () => {
    // 2016-03-01 is referenced but missing; the import only touches 2016-03-02.
    const existing = activeRecord({ '2016-03-01': 1 }, 1);
    const handle = createFakeHandle({ [SERIES_STORE]: { [NQ_ID]: existing } });
    const result = await commitImport(
      handle, importInput([bar(MAR01_0500 + 86_400_000)]), { runExclusive: runNow },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.chunksWritten).toBe(1);
  });

  it('commits a very large import without throwing', async () => {
    const handle = createFakeHandle();
    const bars = Array.from({ length: 150_000 }, (_, i) => bar(MAR01_0500 + i * MINUTE, 4000 + (i % 8) * 0.25));
    const result = await commitImport(handle, importInput(bars), { runExclusive: runNow });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.barCount).toBe(150_000);
    const rec = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord;
    expect(rec.committed.observedFirstUtcMs).toBe(MAR01_0500);
    expect(rec.committed.observedLastUtcMs).toBe(MAR01_0500 + 149_999 * MINUTE);
  });

  // This host (Node 24) implements the Web Locks API, so the DEFAULT
  // runner — the exact code path production uses — is exercised here
  // rather than only at Runtime Acceptance.
  it('commits through the real origin-wide lock when the host provides one', async () => {
    const handle = createFakeHandle();
    const result = await commitImport(handle, importInput([bar(MAR01_0500)]));
    expect(result.ok).toBe(true);
    expect(handle.records.get(SERIES_STORE)?.has(NQ_ID)).toBe(true);
  });

  it('serializes two concurrent imports instead of losing one update', async () => {
    const handle = createFakeHandle();
    const dayTwo = MAR01_0500 + 86_400_000;

    // Started together, awaited together — with no mutual exclusion both
    // would plan against the same empty manifest and the second commit
    // would erase the first day.
    const [first, second] = await Promise.all([
      commitImport(handle, importInput([bar(MAR01_0500)])),
      commitImport(handle, importInput([bar(dayTwo)])),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const manifest = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord;
    expect(Object.keys(manifest.committed.activeChunks).sort()).toEqual(['2016-03-01', '2016-03-02']);
    expect(manifest.committed.barCount).toBe(2);
    expect(manifest.provenance.imports).toHaveLength(2);
  });
});

// ─── Deletion ─────────────────────────────────────────────────

describe('deleteSeries', () => {
  const record = activeRecord({ '2016-03-01': 2, '2016-03-02': 1 }, 5);

  function seeded() {
    return createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: record },
      [CHUNK_STORE]: {
        [chunkIdOf(NQ_ID, '2016-03-01', 1)]: { chunkId: 'a' },
        [chunkIdOf(NQ_ID, '2016-03-01', 2)]: { chunkId: 'b' },
        [chunkIdOf(NQ_ID, '2016-03-02', 1)]: { chunkId: 'c' },
      },
    });
  }

  it('tombstones first, then removes payload, then removes the record', async () => {
    const handle = seeded();
    const result = await deleteSeries(handle, NQ_ID, { runExclusive: runNow });
    expect(result.ok).toBe(true);

    const kinds = handle.ops.filter((op) => op.kind !== 'get').map((op) => `${op.kind}:${op.store}`);
    expect(kinds[0]).toBe(`put:${SERIES_STORE}`);
    expect(kinds[kinds.length - 1]).toBe(`delete:${SERIES_STORE}`);
    expect(kinds.slice(1, -1).every((k) => k === `delete:${CHUNK_STORE}`)).toBe(true);

    expect(handle.records.get(SERIES_STORE)?.size).toBe(0);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
  });

  it('deletes r1 through r(active + 1) for every committed day', async () => {
    const handle = seeded();
    await deleteSeries(handle, NQ_ID, { runExclusive: runNow });
    const deleted = handle.ops.filter((op) => op.kind === 'delete' && op.store === CHUNK_STORE).map((op) => op.key);
    expect(deleted).toEqual([
      chunkIdOf(NQ_ID, '2016-03-01', 1),
      chunkIdOf(NQ_ID, '2016-03-01', 2),
      chunkIdOf(NQ_ID, '2016-03-01', 3),
      chunkIdOf(NQ_ID, '2016-03-02', 1),
      chunkIdOf(NQ_ID, '2016-03-02', 2),
    ]);
  });

  it('resumes from a persisted deleting record without re-tombstoning', async () => {
    const handle = createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: { ...record, state: 'deleting' } },
      [CHUNK_STORE]: { [chunkIdOf(NQ_ID, '2016-03-01', 1)]: { chunkId: 'a' } },
    });
    const result = await deleteSeries(handle, NQ_ID, { runExclusive: runNow });
    expect(result.ok).toBe(true);
    expect(handle.ops.some((op) => op.kind === 'put')).toBe(false);
    const deleted = handle.ops.filter((op) => op.kind === 'delete' && op.store === CHUNK_STORE).map((op) => op.key);
    expect(deleted).toEqual([
      chunkIdOf(NQ_ID, '2016-03-01', 1),
      chunkIdOf(NQ_ID, '2016-03-01', 2),
      chunkIdOf(NQ_ID, '2016-03-01', 3),
      chunkIdOf(NQ_ID, '2016-03-02', 1),
      chunkIdOf(NQ_ID, '2016-03-02', 2),
    ]);
    expect(handle.records.get(SERIES_STORE)?.size).toBe(0);
  });

  it('is an idempotent no-op for an absent series', async () => {
    const handle = createFakeHandle();
    const result = await deleteSeries(handle, NQ_ID, { runExclusive: runNow });
    expect(result.ok).toBe(true);
    expect(handle.ops.some((op) => op.kind === 'put' || op.kind === 'delete')).toBe(false);
  });

  it('performs zero mutation when no origin-wide lock is available', async () => {
    const handle = seeded();
    const result = await deleteSeries(handle, NQ_ID, { runExclusive: noLock });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mutation_lock_unavailable');
    expect(handle.ops).toEqual([]);
  });

  it('cannot interleave with a concurrent import of the same series', async () => {
    const handle = createFakeHandle();
    await commitImport(handle, importInput([bar(MAR01_0500)]));

    const [imported, deleted] = await Promise.all([
      commitImport(handle, importInput([bar(MAR01_0500 + 86_400_000)])),
      deleteSeries(handle, NQ_ID),
    ]);

    // Whichever order the lock granted, the outcome is coherent: never a
    // half-deleted series, and never a resurrected one.
    expect(deleted.ok).toBe(true);
    const manifest = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord | undefined;
    if (imported.ok) {
      // import ran first, delete removed everything it committed
      expect(manifest).toBeUndefined();
      expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
    } else {
      expect(imported.reason).toBe('series_deleting');
    }
  });
});

// ─── Clear ────────────────────────────────────────────────────

describe('clearHistoricalCache', () => {
  it('declares series before bar_chunks in the frozen clear order', () => {
    expect(CLEAR_STORE_ORDER).toEqual(['series', 'bar_chunks']);
    expect(CLEAR_STORE_ORDER[0]).toBe(SERIES_STORE);
  });

  it('makes manifests invisible BEFORE removing chunk payload', async () => {
    const handle = createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: activeRecord({ '2016-03-01': 1 }, 1) },
      [CHUNK_STORE]: { [chunkIdOf(NQ_ID, '2016-03-01', 1)]: { chunkId: 'a' } },
    });
    const result = await clearHistoricalCache(handle, { runExclusive: runNow });
    expect(result.ok).toBe(true);
    expect(handle.ops.filter((op) => op.kind === 'clear').map((op) => op.store))
      .toEqual([SERIES_STORE, CHUNK_STORE]);
    expect(handle.records.get(SERIES_STORE)?.size).toBe(0);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
  });

  it('leaves no visible series when chunk clearing fails, and is re-runnable', async () => {
    const handle = createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: activeRecord({ '2016-03-01': 1 }, 1) },
      [CHUNK_STORE]: { [chunkIdOf(NQ_ID, '2016-03-01', 1)]: { chunkId: 'a' } },
    });
    handle.failOn('clear', CHUNK_STORE);
    const first = await clearHistoricalCache(handle, { runExclusive: runNow });
    expect(first.ok).toBe(false);
    expect(handle.records.get(SERIES_STORE)?.size).toBe(0);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(1);

    handle.failOn('none', 'none');
    const second = await clearHistoricalCache(handle, { runExclusive: runNow });
    expect(second.ok).toBe(true);
    expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
  });

  it('performs zero mutation when no origin-wide lock is available', async () => {
    const handle = createFakeHandle();
    const result = await clearHistoricalCache(handle, { runExclusive: noLock });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('mutation_lock_unavailable');
    expect(handle.ops).toEqual([]);
  });

  it('cannot interleave with a concurrent import', async () => {
    const handle = createFakeHandle();
    const [, cleared] = await Promise.all([
      commitImport(handle, importInput([bar(MAR01_0500)])),
      clearHistoricalCache(handle),
    ]);
    expect(cleared.ok).toBe(true);

    // Either the import ran first and was then cleared, or it ran after
    // the clear and is fully present. Never a manifest without payload.
    const manifest = handle.records.get(SERIES_STORE)?.get(NQ_ID) as HistoricalSeriesRecord | undefined;
    if (manifest === undefined) {
      expect(handle.records.get(CHUNK_STORE)?.size).toBe(0);
    } else {
      for (const [day, revision] of Object.entries(manifest.committed.activeChunks)) {
        expect(handle.records.get(CHUNK_STORE)?.has(chunkIdOf(NQ_ID, day, revision))).toBe(true);
      }
    }
  });
});

// ─── Chunk source adapter ─────────────────────────────────────

describe('createIndexedDbChunkSource', () => {
  const chunkId = chunkIdOf(NQ_ID, '2016-03-01', 1);

  function seeded() {
    return createFakeHandle({
      [SERIES_STORE]: { [NQ_ID]: activeRecord({ '2016-03-01': 1 }, 1) },
      [CHUNK_STORE]: { [chunkId]: { chunkId, seriesId: NQ_ID, day: '2016-03-01', revision: 1, t: [], o: [], h: [], l: [], c: [], v: [] } },
    });
  }

  it('reports a successful read with its value', async () => {
    const source = createIndexedDbChunkSource(seeded());
    const series = await source.getSeries(NQ_ID);
    expect(series.ok).toBe(true);
    if (!series.ok) return;
    expect(series.value?.seriesId).toBe(NQ_ID);

    const got = await source.getChunk(chunkId);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.chunkId).toBe(chunkId);
  });

  it('reports PROVEN absence distinctly from failure', async () => {
    const source = createIndexedDbChunkSource(seeded());
    const missingSeries = await source.getSeries('ES|2016|03|1m');
    expect(missingSeries).toEqual({ ok: true, value: null });
    const missingChunk = await source.getChunk(chunkIdOf(NQ_ID, '2016-03-01', 9));
    expect(missingChunk).toEqual({ ok: true, value: null });
  });

  it('reports an operational read failure as a failure, NOT as absence', async () => {
    const handle = seeded();
    handle.failOn('get', SERIES_STORE);
    const source = createIndexedDbChunkSource(handle);
    expect(await source.getSeries(NQ_ID)).toEqual({ ok: false });

    const handle2 = seeded();
    handle2.failOn('get', CHUNK_STORE);
    expect(await createIndexedDbChunkSource(handle2).getChunk(chunkId)).toEqual({ ok: false });
  });
});
