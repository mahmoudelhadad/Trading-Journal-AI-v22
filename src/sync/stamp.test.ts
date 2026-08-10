import { describe, expect, it } from 'vitest';
import { createUserStorageScope, type RawStorage } from '@services/storageNamespace.js';
import { createStorageService } from '@services/storage.js';
import { refreshForLocalWrite } from './record.js';
import { runSyncMetadataStampingPass } from './stamp.js';

const USER = 'a1234567-89ab-4cde-8fab-0123456789ab';

class MemoryStorage implements RawStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('scoped metadata stamping', () => {
  it('stamps only captured scoped collections and singletons', () => {
    const raw = new MemoryStorage();
    const scope = createUserStorageScope(USER, raw);
    const storage = createStorageService(scope);
    scope.setRaw('fxj_v4_trades', '[{"_tid":1}]');
    scope.setRaw('fxj_v4_lists', '{"symbols":["ES"]}');
    runSyncMetadataStampingPass(storage);
    expect(JSON.parse(scope.getRaw('fxj_v4_trades')!)[0].syncStatus).toBe('dirty');
    expect(JSON.parse(scope.getRaw('fxj_v4_lists')!).data).toEqual({ symbols: ['ES'] });
  });

  it('does not mutate preserved legacy source', () => {
    const raw = new MemoryStorage();
    raw.setItem('fxj_v4_trades', '[{"_tid":1}]');
    const storage = createStorageService(createUserStorageScope(USER, raw));
    storage.saveTrades([{ _tid: 2 }]);
    runSyncMetadataStampingPass(storage);
    expect(raw.getItem('fxj_v4_trades')).toBe('[{"_tid":1}]');
  });

  it('has no global fallback', () => {
    expect(() => runSyncMetadataStampingPass()).toThrow('Authenticated scoped storage is required');
  });
});

describe('local-write metadata patch boundary', () => {
  it('returns only sync metadata keys and no trade content keys', () => {
    const refreshed = refreshForLocalWrite({
      syncId: 'sync-1',
      syncStatus: 'synced',
      localUpdatedAt: '2026-08-01T00:00:00.000Z',
      baseUpdatedAt: '2026-08-01T00:00:00.000Z',
      deletedAt: null,
      consecutiveFailures: 2,
      nextEligibleAttemptAt: '2026-08-02T00:00:00.000Z',
      lastError: 'retry',
      conflictResolutionLog: ['kept'],
    }, '2026-08-10T00:00:00.000Z');
    const keys = Object.keys(refreshed);
    expect(keys.sort()).toEqual([
      'baseUpdatedAt', 'conflictResolutionLog', 'consecutiveFailures', 'deletedAt', 'lastError',
      'localUpdatedAt', 'nextEligibleAttemptAt', 'syncId', 'syncStatus',
    ]);

    const businessFields = [
      '_tid', 'market', 'symbol', 'date', 'broker', 'account', 'accountId', 'dailySetup',
      'liquidity', 'entrySetup', 'intraDaySetup', 'intraDayTF', 'session', 'daySwing',
      'linkToChart', 'positionSize', 'direction', 'entryTime', 'exitTime', 'entryPrice',
      'stopLoss', 'target', 'exitPrice', 'commission', 'setupType', 'personalRating',
      'planFollowed', 'emotions', 'beSL', 'afSL', 'sl1', 'sl2', 'sl3', 'tm1', 'tm2',
      'tm3', 'tm4', 'tm5', 'tm6', 'error', 'notes',
      'legs', 'sourceInstrument', 'sourcePlatform', 'sourceAccountId',
    ];
    for (const field of businessFields) expect(keys).not.toContain(field);
  });
});
