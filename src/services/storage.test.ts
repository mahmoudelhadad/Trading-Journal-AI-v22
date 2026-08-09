/**
 * services/storage.test.ts
 *
 * Release Hardening (H-1) — regression cover for silent persistence loss.
 *
 * Before this phase, createStorageService()'s write/remove paths caught and
 * discarded every failure. createScopedLocalDatabase wraps those calls in
 * `async` methods, so they always RESOLVED even when nothing was written —
 * which meant the hooks' `.catch(reportLocalPersistenceFailure)` could never
 * run and the §3.4 blocking notice was unreachable. A quota-exhausted write
 * therefore looked successful in the UI and vanished on the next reload.
 *
 * These tests pin the two properties that fix depends on: a failed scoped
 * write must REPORT, and it must still not THROW (every existing caller
 * contract depends on the facade being non-throwing).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createStorageService, STORAGE_KEYS } from './storage.js';
import {
  dismissLocalPersistenceNotice,
  getLocalPersistenceNotice,
  onLocalPersistenceNoticeChange,
  type LocalPersistenceNotice,
} from './localPersistenceEvents.js';
import type { UserStorageScope } from './storageNamespace.js';

/** Minimal in-memory scope; `failWith` makes writes/removes throw. */
function createScope(failWith?: Error) {
  const values = new Map<string, string>();
  const scope = {
    userId: '12345678-1234-4123-8123-1234567890ab',
    namespaceVersion: 'v1' as const,
    physicalKey: (key: string) => `fxj:user:v1:test:${key}`,
    getRaw: (key: string) => values.get(key) ?? null,
    setRaw: (key: string, value: string) => {
      if (failWith) throw failWith;
      values.set(key, value);
    },
    remove: (key: string) => {
      if (failWith) throw failWith;
      values.delete(key);
    },
  } as unknown as UserStorageScope;
  return { scope, values };
}

/** Collect every notice emitted while `run` executes. */
function recordNotices(run: () => void): (LocalPersistenceNotice | null)[] {
  const seen: (LocalPersistenceNotice | null)[] = [];
  const unsubscribe = onLocalPersistenceNoticeChange((notice) => seen.push(notice));
  try { run(); } finally { unsubscribe(); }
  return seen;
}

describe('scoped storage write-failure surfacing', () => {
  beforeEach(() => dismissLocalPersistenceNotice());
  afterEach(() => dismissLocalPersistenceNotice());

  it('writes the value and reports nothing when the write succeeds', () => {
    const { scope, values } = createScope();
    const storage = createStorageService(scope);

    const seen = recordNotices(() => storage.saveTrades([{ _tid: 1 }]));

    expect(values.get(STORAGE_KEYS.TRADES)).toBe(JSON.stringify([{ _tid: 1 }]));
    expect(seen).toEqual([]);
    expect(getLocalPersistenceNotice()).toBeNull();
  });

  it('does not throw and reports exactly once when the write fails', () => {
    const failure = new Error('QuotaExceededError: persistent storage is full');
    const { scope } = createScope(failure);
    const storage = createStorageService(scope);

    let seen: (LocalPersistenceNotice | null)[] = [];
    expect(() => { seen = recordNotices(() => storage.saveTrades([{ _tid: 1 }])); }).not.toThrow();

    expect(seen).toHaveLength(1);
    const notice = getLocalPersistenceNotice();
    expect(notice).toMatchObject({ kind: 'save_failed', source: `localstorage:${STORAGE_KEYS.TRADES}` });
    // The original failure must survive into the report, not be replaced.
    expect(notice && notice.kind === 'save_failed' ? notice.message : null).toBe(failure.message);
  });

  it('does not throw and reports when a remove fails', () => {
    const { scope } = createScope(new Error('remove blocked'));
    const storage = createStorageService(scope);

    let seen: (LocalPersistenceNotice | null)[] = [];
    expect(() => { seen = recordNotices(() => storage.storageRemove(STORAGE_KEYS.LISTS)); }).not.toThrow();

    expect(seen).toHaveLength(1);
    expect(getLocalPersistenceNotice()).toMatchObject({
      kind: 'save_failed',
      source: `localstorage:${STORAGE_KEYS.LISTS}`,
    });
  });

  /**
   * v1.1: a real browser quota failure is a DOMException carrying `.name`,
   * not the `.kind` the reporter classified on. It therefore landed in
   * 'unknown' and the §3.4 notice showed generic text instead of the
   * tailored storage-full wording it already implements for
   * `quota_exceeded`. These pin the new classification AND prove the
   * pre-existing ones are untouched.
   */
  it('classifies a DOMException-shaped quota failure as quota_exceeded', () => {
    const quota = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
    const { scope } = createScope(quota);
    createStorageService(scope).saveTrades([{ _tid: 1 }]);
    expect(getLocalPersistenceNotice()).toMatchObject({ kind: 'save_failed', errorKind: 'quota_exceeded' });
  });

  it('keeps an explicit .kind authoritative and leaves other errors unknown', () => {
    const tagged = Object.assign(new Error('blocked by another tab'), { kind: 'blocked', name: 'QuotaExceededError' });
    createStorageService(createScope(tagged).scope).saveTrades([{ _tid: 1 }]);
    // `.kind` wins even though `.name` would also match — IndexedDB
    // classification must not be reinterpreted by the new name check.
    expect(getLocalPersistenceNotice()).toMatchObject({ errorKind: 'blocked' });

    dismissLocalPersistenceNotice();
    createStorageService(createScope(new Error('something else')).scope).saveTrades([{ _tid: 1 }]);
    expect(getLocalPersistenceNotice()).toMatchObject({ errorKind: 'unknown' });
  });

  it('reports once per failed operation across the other scoped writers', () => {
    const { scope } = createScope(new Error('quota'));
    const storage = createStorageService(scope);

    // Recovery Bin, Backtests, and saved filters share this same facade and
    // had no failure channel of their own before H-1.
    const seen = recordNotices(() => {
      storage.saveRecoveryBin([]);
      storage.saveBacktestResults([]);
      storage.saveSavedFilters([]);
    });

    expect(seen).toHaveLength(3);
    expect(seen.every((n) => n !== null && n.kind === 'save_failed')).toBe(true);
  });
});
