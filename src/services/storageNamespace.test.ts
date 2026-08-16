import { describe, expect, it } from 'vitest';
import {
  USER_STORAGE_LOGICAL_KEYS,
  createUserStorageScope,
  scopedPhysicalKey,
  validateUserStorageId,
  type RawStorage,
} from './storageNamespace.js';

const A = 'A1234567-89AB-4CDE-8FAB-0123456789AB';
const B = 'b1234567-89ab-4cde-8fab-0123456789ab';

class MemoryStorage implements RawStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe('authenticated user storage namespace', () => {
  it('freezes exactly the fifteen recognized logical keys', () => {
    expect(USER_STORAGE_LOGICAL_KEYS).toHaveLength(15);
    expect(new Set(USER_STORAGE_LOGICAL_KEYS).size).toBe(15);
    expect(USER_STORAGE_LOGICAL_KEYS).toContain('fxj_v4_backtest_sessions');
  });

  it('maps all fifteen keys deterministically', () => {
    for (const key of USER_STORAGE_LOGICAL_KEYS) {
      expect(scopedPhysicalKey(A, key)).toBe(`fxj:user:v1:${encodeURIComponent(A)}:${key}`);
      expect(scopedPhysicalKey(A, key)).toBe(scopedPhysicalKey(A, key));
    }
  });

  it('preserves the validated identity byte-for-byte', () => {
    expect(validateUserStorageId(A)).toBe(A);
    expect(scopedPhysicalKey(A, USER_STORAGE_LOGICAL_KEYS[0])).toContain(A);
  });

  it('separates users even when their UUID text differs only in case', () => {
    expect(scopedPhysicalKey(A, USER_STORAGE_LOGICAL_KEYS[0]))
      .not.toBe(scopedPhysicalKey(A.toLowerCase(), USER_STORAGE_LOGICAL_KEYS[0]));
    expect(scopedPhysicalKey(A, USER_STORAGE_LOGICAL_KEYS[0]))
      .not.toBe(scopedPhysicalKey(B, USER_STORAGE_LOGICAL_KEYS[0]));
  });

  it('rejects invalid or transformed identity input', () => {
    for (const invalid of ['', ` ${A}`, `${A} `, 'not-a-uuid', '12345678-1234-1234-1234-123456789012']) {
      expect(() => validateUserStorageId(invalid)).toThrow();
    }
  });

  it('keeps delimiters in logical keys outside the encoded identity component', () => {
    const storage = new MemoryStorage();
    const scope = createUserStorageScope(A, storage);
    scope.setRaw('fxj_prop_rules', '{}');
    expect(storage.values.get(`fxj:user:v1:${encodeURIComponent(A)}:fxj_prop_rules`)).toBe('{}');
    expect(scope.physicalKey('fxj_prop_rules').split(':').slice(-1)[0]).toBe('fxj_prop_rules');
  });
});
