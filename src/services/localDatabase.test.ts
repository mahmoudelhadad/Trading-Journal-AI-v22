import { describe, expect, it, vi } from 'vitest';
import { createUserStorageScope, type RawStorage } from './storageNamespace.js';
import { createStorageService } from './storage.js';
import { createScopedLocalDatabase, preflightGlobalIndexedDb } from './localDatabase.js';

const USER = 'a1234567-89ab-4cde-8fab-0123456789ab';

class MemoryStorage implements RawStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('Phase 32B scoped resolver', () => {
  it('is permanently LocalStorage-only for its captured scope', async () => {
    const raw = new MemoryStorage();
    const scope = createUserStorageScope(USER, raw);
    const database = createScopedLocalDatabase(createStorageService(scope));
    expect(database.backend).toBe('localstorage');
    await database.saveTrades([{ _tid: 1 }] as never);
    expect(await database.loadTrades()).toEqual([{ _tid: 1 }]);
    expect(raw.getItem(scope.physicalKey('fxj_v4_trades'))).toBe('[{"_tid":1}]');
  });

  it('does not poll or latch to a marker after creation', async () => {
    const raw = new MemoryStorage();
    const database = createScopedLocalDatabase(createStorageService(createUserStorageScope(USER, raw)));
    const markerReader = vi.fn(async () => ({ cutoverCompletedAt: 'later' }));
    await database.loadTrades();
    await database.saveTrades([]);
    await database.loadAccounts();
    expect(markerReader).not.toHaveBeenCalled();
    expect(database.backend).toBe('localstorage');
  });

  it('blocks preflight when the global marker exists', async () => {
    expect(await preflightGlobalIndexedDb(async () => ({ cutoverCompletedAt: '2026-08-06T12:00:00.000Z' })))
      .toEqual({ kind: 'blocked', reason: 'marker_present' });
  });

  it('blocks preflight when marker reading fails', async () => {
    expect(await preflightGlobalIndexedDb(async () => { throw new Error('read failed'); }))
      .toEqual({ kind: 'blocked', reason: 'marker_read_failed' });
  });

  it('permits preflight only when the marker is read as absent', async () => {
    expect(await preflightGlobalIndexedDb(async () => null)).toEqual({ kind: 'clear' });
    expect(await preflightGlobalIndexedDb(async () => ({ cutoverCompletedAt: null }))).toEqual({ kind: 'clear' });
  });
});
