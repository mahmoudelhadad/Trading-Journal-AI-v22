import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  saves: [] as string[],
  droppedKey: null as string | null,
  thrownSaveKey: null as string | null,
  thrownLoadKey: null as string | null,
}));

vi.mock('./storage.js', () => {
  const access = (key: string) => ({
    load: () => {
      if (harness.thrownLoadKey === key) throw new Error('load failed');
      return harness.values[key];
    },
    save: (value: unknown) => {
      harness.saves.push(key);
      if (harness.thrownSaveKey === key) throw new Error('save failed');
      if (harness.droppedKey !== key) harness.values[key] = value;
    },
  });
  const propRules = access('propRules');
  const savedFilters = access('savedFilters');
  const checklistTemplates = access('checklistTemplates');
  const checklistCompletions = access('checklistCompletions');
  const customFieldDefs = access('customFieldDefs');
  const customFieldValues = access('customFieldValues');
  const recoveryBin = access('recoveryBin');
  const backtestResults = access('backtestResults');
  const restorePoints = access('restorePoints');
  return {
    loadPropRules: propRules.load, savePropRules: propRules.save,
    loadSavedFilters: savedFilters.load, saveSavedFilters: savedFilters.save,
    loadChecklistTemplates: checklistTemplates.load, saveChecklistTemplates: checklistTemplates.save,
    loadChecklistCompletions: checklistCompletions.load, saveChecklistCompletions: checklistCompletions.save,
    loadCustomFieldDefs: customFieldDefs.load, saveCustomFieldDefs: customFieldDefs.save,
    loadCustomFieldValues: customFieldValues.load, saveCustomFieldValues: customFieldValues.save,
    loadRecoveryBin: recoveryBin.load, saveRecoveryBin: recoveryBin.save,
    loadBacktestResults: backtestResults.load, saveBacktestResults: backtestResults.save,
    loadRestorePoints: restorePoints.load, saveRestorePoints: restorePoints.save,
  };
});

vi.mock('./localDatabase.js', () => {
  const access = (key: string) => ({
    load: () => {
      if (harness.thrownLoadKey === key) throw new Error('load failed');
      return harness.values[key];
    },
    save: (value: unknown) => {
      harness.saves.push(key);
      if (harness.thrownSaveKey === key) throw new Error('save failed');
      if (harness.droppedKey !== key) harness.values[key] = value;
    },
  });
  const trades = access('trades');
  const accounts = access('accounts');
  const lists = access('lists');
  const settings = access('settings');
  return {
    loadTrades: trades.load, saveTrades: trades.save,
    loadAccounts: accounts.load, saveAccounts: accounts.save,
    loadLists: lists.load, saveLists: lists.save,
    loadSettings: settings.load, saveSettings: settings.save,
  };
});

import { buildBackup, createBackupService, createRestorePoint, restoreBackup } from './backupService.js';

const validBacktest = (id = 'bt-1') => ({
  id,
  name: 'Snapshot',
  createdAt: 1,
  filterGroup: { operator: 'AND', conditions: [] },
  startingCapital: 10000,
  matchedTradeIds: [1],
  tradeCount: 1,
  equityPath: [10100],
  summary: {},
  drawdown: {},
  streaks: {},
  averageStreaks: {},
  longestStreaks: {},
  core: { avgRisk: null },
  additive: { preserved: true },
});

const validTrade = (overrides: Record<string, unknown> = {}) => ({
  _tid: 1,
  accountId: 'a',
  date: '2026-08-07',
  symbol: 'ES',
  direction: 'Long',
  entryPrice: '100',
  stopLoss: '90',
  target: '120',
  exitPrice: '110',
  positionSize: '1',
  commission: '0',
  entryTime: '09:30',
  exitTime: '10:00',
  ...overrides,
});

const validData = (): Record<string, unknown> => ({
  trades: [validTrade()],
  accounts: [{ id: 'a', name: 'Main', capital: 10000, color: '#fff' }],
  lists: { data: { symbols: ['ES'] } },
  propRules: { rules: [{ id: 'r' }] },
  settings: { data: { currency: 'USD' } },
  savedFilters: [{ id: 'f', name: 'Filter', group: {}, isFavorite: false, createdAt: 1 }],
  checklistTemplates: [{ id: 'c', name: 'List', items: [{ id: 'i', text: 'Check' }] }],
  checklistCompletions: { 1: { i: true } },
  customFieldDefs: [{ id: 'd', name: 'Note', type: 'text' }],
  customFieldValues: { 1: { d: 'value' } },
  recoveryBin: [{ id: 'rb', deletedAt: 1, label: 'ES', item: { _tid: 2 }, extra: true }],
  backtestResults: [validBacktest()],
});

const backup = (data: Record<string, unknown> = validData(), version = 2) => ({
  version,
  exportedAt: '2026-08-06T00:00:00.000Z',
  data,
});

const createScopedBackupHarness = (initial: Record<string, unknown>) => {
  const values: Record<string, unknown> = { ...initial, restorePoints: initial.restorePoints ?? [] };
  const access = (key: string) => ({
    load: () => values[key],
    save: (value: unknown) => { values[key] = value; },
  });
  const trades = access('trades');
  const accounts = access('accounts');
  const lists = access('lists');
  const settings = access('settings');
  const propRules = access('propRules');
  const savedFilters = access('savedFilters');
  const checklistTemplates = access('checklistTemplates');
  const checklistCompletions = access('checklistCompletions');
  const customFieldDefs = access('customFieldDefs');
  const customFieldValues = access('customFieldValues');
  const recoveryBin = access('recoveryBin');
  const backtestResults = access('backtestResults');
  const restorePoints = access('restorePoints');
  const storage = {
    loadPropRules: propRules.load, savePropRules: propRules.save,
    loadSavedFilters: savedFilters.load, saveSavedFilters: savedFilters.save,
    loadChecklistTemplates: checklistTemplates.load, saveChecklistTemplates: checklistTemplates.save,
    loadChecklistCompletions: checklistCompletions.load, saveChecklistCompletions: checklistCompletions.save,
    loadCustomFieldDefs: customFieldDefs.load, saveCustomFieldDefs: customFieldDefs.save,
    loadCustomFieldValues: customFieldValues.load, saveCustomFieldValues: customFieldValues.save,
    loadRecoveryBin: recoveryBin.load, saveRecoveryBin: recoveryBin.save,
    loadBacktestResults: backtestResults.load, saveBacktestResults: backtestResults.save,
    loadRestorePoints: restorePoints.load, saveRestorePoints: restorePoints.save,
  };
  const database = {
    loadTrades: trades.load, saveTrades: trades.save,
    loadAccounts: accounts.load, saveAccounts: accounts.save,
    loadLists: lists.load, saveLists: lists.save,
    loadSettings: settings.load, saveSettings: settings.save,
  };
  const service = createBackupService(
    storage as Parameters<typeof createBackupService>[0],
    database as Parameters<typeof createBackupService>[1],
  );
  return { values, service };
};

beforeEach(() => {
  harness.values = { ...validData(), restorePoints: [] };
  harness.saves = [];
  harness.droppedKey = null;
  harness.thrownSaveKey = null;
  harness.thrownLoadKey = null;
});

describe('backup v2 coverage', () => {
  it('emits all 12 user-data sections at version 2', async () => {
    const result = await buildBackup();
    expect(result.version).toBe(2);
    expect(Object.keys(result.data)).toEqual([
      'trades', 'accounts', 'lists', 'propRules', 'settings', 'savedFilters',
      'checklistTemplates', 'checklistCompletions', 'customFieldDefs',
      'customFieldValues', 'recoveryBin', 'backtestResults',
    ]);
    expect(result.data).not.toHaveProperty('restorePoints');
    expect(result.data).not.toHaveProperty('syncCursors');
  });

  it('makes Restore Points inherit both new sections without recursion', async () => {
    const point = await createRestorePoint('P27');
    const data = (point.backup as { data: Record<string, unknown> }).data;
    expect(data).toHaveProperty('recoveryBin');
    expect(data).toHaveProperty('backtestResults');
    expect(data).not.toHaveProperty('restorePoints');
  });
});

describe('authenticated scoped backup routing', () => {
  it('backs up only the captured current scope without serializing namespace metadata', async () => {
    const ownerA = '12345678-1234-4123-8123-1234567890ab';
    const ownerB = '87654321-4321-4321-8321-ba0987654321';
    const a = createScopedBackupHarness({ ...validData(), trades: [validTrade({ _tid: 1 })] });
    const b = createScopedBackupHarness({ ...validData(), trades: [validTrade({ _tid: 2 })] });

    const aBackup = await a.service.buildBackup();
    const bBackup = await b.service.buildBackup();
    expect(aBackup.data.trades).toEqual([validTrade({ _tid: 1 })]);
    expect(bBackup.data.trades).toEqual([validTrade({ _tid: 2 })]);
    const serialized = JSON.stringify(aBackup);
    expect(serialized).not.toContain('fxj:user:v1:');
    expect(serialized).not.toContain(ownerA);
    expect(serialized).not.toContain(ownerB);
  });

  it('allows a portable backup from A to restore explicitly into B only', async () => {
    const a = createScopedBackupHarness({ ...validData(), trades: [validTrade({ _tid: 11 })] });
    const b = createScopedBackupHarness({ ...validData(), trades: [validTrade({ _tid: 22 })] });
    const portable = await a.service.buildBackup();

    expect((await b.service.restoreBackup(portable)).success).toBe(true);
    expect(b.values.trades).toMatchObject([{ _tid: 11, symbol: 'ES', syncStatus: 'dirty' }]);
    expect(a.values.trades).toEqual([validTrade({ _tid: 11 })]);
  });

  it('keeps Restore Points inside the captured user scope', async () => {
    const a = createScopedBackupHarness({ ...validData() });
    const b = createScopedBackupHarness({ ...validData() });

    const point = await a.service.createRestorePoint('A only');
    expect(a.service.listRestorePoints()).toContainEqual(point);
    expect(b.service.listRestorePoints()).toEqual([]);
  });
});

describe('restore validation and compatibility', () => {
  it.each([1, 2])('accepts supported version %s', async (version) => {
    expect((await restoreBackup(backup({}, version))).success).toBe(true);
  });

  it.each([0, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2'])('rejects invalid version %s before writes', async (version) => {
    const result = await restoreBackup({ ...backup(), version });
    expect(result.success).toBe(false);
    expect(harness.saves).toEqual([]);
  });

  it('rejects an array-valued data envelope before writes', async () => {
    expect((await restoreBackup({ ...backup(), data: [] })).success).toBe(false);
    expect(harness.saves).toEqual([]);
  });

  it('leaves missing optional sections untouched and ignores unknown sections', async () => {
    const original = harness.values.recoveryBin;
    const result = await restoreBackup(backup({ futureSection: { value: true } }, 1));
    expect(result).toEqual({ success: true, restoredKeys: [] });
    expect(harness.values.recoveryBin).toBe(original);
  });

  it('treats historical nullable resolver sentinels as validated no-ops', async () => {
    const result = await restoreBackup(backup({ accounts: null, lists: null, settings: null }, 1));
    expect(result).toEqual({ success: true, restoredKeys: [] });
    expect(harness.saves).toEqual([]);
  });

  it.each([
    ['trades', {}], ['accounts', {}], ['lists', []], ['propRules', { rules: {} }],
    ['settings', []], ['savedFilters', {}], ['checklistTemplates', {}],
    ['checklistCompletions', []], ['customFieldDefs', {}], ['customFieldValues', []],
    ['recoveryBin', {}], ['backtestResults', {}],
  ])('rejects wrong top-level shape for %s', async (key, value) => {
    const result = await restoreBackup(backup({ [key]: value }));
    expect(result.success).toBe(false);
    expect(result.error).toContain(`'${key}'`);
    expect(harness.saves).toEqual([]);
  });

  it('rejects an unsafe Backtest record but preserves additive fields on valid records', async () => {
    expect((await restoreBackup(backup({ backtestResults: [{ id: 'bad' }] }))).success).toBe(false);
    const result = await restoreBackup(backup({ backtestResults: [validBacktest()] }));
    expect(result.success).toBe(true);
    expect((harness.values.backtestResults as ReturnType<typeof validBacktest>[])[0].additive).toEqual({ preserved: true });
  });

  it('validates every present section before performing an earlier write', async () => {
    const result = await restoreBackup(backup({
      propRules: { rules: [{ id: 'valid' }] },
      backtestResults: [{ id: 'invalid-late-section' }],
    }));
    expect(result.success).toBe(false);
    expect(harness.saves).toEqual([]);
  });

  it.each([
    [validTrade({ _tid: 0 }), 'trade identity'],
    [validTrade({ entryPrice: 'NaN' }), 'finite number greater than zero'],
    [validTrade({ date: '02/03/2026' }), 'YYYY-MM-DD'],
    [validTrade({ date: '2026-02-30' }), 'YYYY-MM-DD'],
  ])('rejects malformed active trade domain before writes', async (trade, reason) => {
    const result = await restoreBackup(backup({ trades: [trade] }));
    expect(result.success).toBe(false);
    expect(result.error).toContain(reason);
    expect(harness.saves).toEqual([]);
  });

  it('rejects an active orphan against supplied accounts before writes', async () => {
    const result = await restoreBackup(backup({
      trades: [validTrade({ accountId: 'missing' })],
      accounts: validData().accounts,
    }));
    expect(result.error).toContain('account does not reference an active account');
    expect(harness.saves).toEqual([]);
  });

  it('uses current persisted accounts when the backup omits accounts', async () => {
    harness.values.accounts = [{ id: 'current', name: 'Current', capital: 5000, color: '#fff' }];
    const result = await restoreBackup(backup({ trades: [validTrade({ accountId: 'current' })] }));
    expect(result.success).toBe(true);
    expect(harness.saves).toEqual(['trades']);
  });

  it('preserves a tombstoned historical trade without requiring domain repair', async () => {
    const tombstone = { _tid: 4, accountId: 'missing', date: 'ambiguous', symbol: 'UNKNOWN', deletedAt: '2026-08-07T00:00:00Z' };
    const result = await restoreBackup(backup({ trades: [tombstone] }));
    expect(result.success).toBe(true);
    expect(harness.values.trades).toMatchObject([{ _tid: 4, accountId: 'missing', deletedAt: '2026-08-07T00:00:00Z' }]);
  });

  it('rejects malformed supplied accounts before any trade write', async () => {
    const result = await restoreBackup(backup({
      trades: [validTrade()],
      accounts: [{ id: 'a', name: 'Main', capital: Number.NaN, color: '#fff' }],
    }));
    expect(result.success).toBe(false);
    expect(harness.saves).toEqual([]);
  });
});

describe('semantic persistence verification', () => {
  it('verifies resolver revival once and persists its semantic state', async () => {
    const result = await restoreBackup(backup({ trades: [validTrade({ _tid: 7, additive: 'kept' })] }));
    expect(result).toEqual({ success: true, restoredKeys: ['trades'] });
    const saved = (harness.values.trades as Record<string, unknown>[])[0];
    expect(saved).toMatchObject({ _tid: 7, additive: 'kept', syncStatus: 'dirty' });
    expect(typeof saved.localUpdatedAt).toBe('string');
  });

  it('detects a silently dropped write and excludes its key', async () => {
    harness.droppedKey = 'recoveryBin';
    const result = await restoreBackup(backup({ recoveryBin: [{ id: 'new', deletedAt: 2, label: 'NQ', item: { _tid: 9 } }] }));
    expect(result).toEqual({
      success: false,
      error: "Failed to persist backup section 'recoveryBin'.",
      restoredKeys: [],
    });
  });

  it('surfaces thrown saves and aborts later sections', async () => {
    harness.thrownSaveKey = 'propRules';
    const result = await restoreBackup(backup({
      propRules: { rules: [{ id: 'new' }] },
      savedFilters: [{ id: 'f2', name: 'Later', group: {}, isFavorite: false, createdAt: 2 }],
    }));
    expect(result.success).toBe(false);
    expect(result.restoredKeys).toEqual([]);
    expect(harness.saves).toEqual(['propRules']);
  });

  it('reports earlier verified keys when a later reload fails', async () => {
    harness.thrownLoadKey = 'savedFilters';
    const result = await restoreBackup(backup({
      propRules: { rules: [{ id: 'first' }] },
      savedFilters: [{ id: 'second', name: 'Second', group: {}, isFavorite: false, createdAt: 2 }],
    }));
    expect(result.success).toBe(false);
    expect(result.restoredKeys).toEqual(['propRules']);
  });

  it('replaces Recovery Bin and preserves more than 50 Backtest Results', async () => {
    const recoveryBin = [{ id: 'only', deletedAt: 4, label: 'Only', item: { _tid: 4 } }];
    const results = Array.from({ length: 51 }, (_, index) => validBacktest(`bt-${index}`));
    const restored = await restoreBackup(backup({ recoveryBin, backtestResults: results }));
    expect(restored.success).toBe(true);
    expect(harness.values.recoveryBin).toEqual(recoveryBin);
    expect(harness.values.backtestResults).toHaveLength(51);
  });

  it('preserves legacy and new Backtest Results through a JSON round-trip', async () => {
    const legacy = validBacktest('legacy');
    delete (legacy as Partial<typeof legacy>).equityPath;
    const data = JSON.parse(JSON.stringify(backup({ backtestResults: [legacy, validBacktest('new')] })));
    expect((await restoreBackup(data)).success).toBe(true);
    expect(harness.values.backtestResults).toEqual([legacy, validBacktest('new')]);
  });
});
