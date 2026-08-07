import { describe, expect, it } from 'vitest';
import type { LockProvider } from '@sync/crossTabCoordinator.js';
import { createUserStorageScope, type RawStorage } from './storageNamespace.js';
import {
  LEGACY_OWNERSHIP_LOCK_NAME,
  LEGACY_OWNERSHIP_REGISTRY_KEY,
  claimLegacyOwnership,
  declineLegacyOwnership,
  digestLegacySnapshot,
  inspectLegacyOwnership,
  readLegacySnapshot,
} from './legacyOwnership.js';

const A = 'a1234567-89ab-4cde-8fab-0123456789ab';
const B = 'b1234567-89ab-4cde-8fab-0123456789ab';

class MemoryStorage implements RawStorage {
  values = new Map<string, string>();
  failPhysicalWriteOnce = false;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failPhysicalWriteOnce && key.startsWith('fxj:user:')) {
      this.failPhysicalWriteOnce = false;
      throw new Error('injected write failure');
    }
    this.values.set(key, value);
  }
  removeItem(key: string) { this.values.delete(key); }
}

class ImmediateLock implements LockProvider {
  requests: string[] = [];
  async request(name: string, hold: () => Promise<void>) {
    this.requests.push(name);
    await hold();
  }
}

const setup = () => {
  const storage = new MemoryStorage();
  const lockProvider = new ImmediateLock();
  const scopeA = createUserStorageScope(A, storage);
  const scopeB = createUserStorageScope(B, storage);
  const deps = {
    storage,
    lockProvider,
    now: () => '2026-08-06T12:00:00.000Z',
    attemptId: () => 'attempt-1',
  };
  return { storage, lockProvider, scopeA, scopeB, deps };
};

describe('legacy detection and canonical digest', () => {
  it('allows a clean scope when no recognized legacy key exists', async () => {
    const { scopeA, deps } = setup();
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'ready', reason: 'legacy_absent' });
  });

  it.each(['[]', '{}', 'null'])('treats physically present %s as a claim candidate', async (raw) => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', raw);
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'claim_required' });
  });

  it('does not suppress a default-equivalent present value', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_prop_rules', JSON.stringify({ rules: [] }));
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'claim_required' });
  });

  it('quarantines malformed JSON without changing it', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '{broken');
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'quarantined', reason: 'malformed_legacy', canContinue: true });
    expect(storage.getItem('fxj_v4_trades')).toBe('{broken');
  });

  it('uses frozen tuple framing and includes cursor changes in SHA-256', async () => {
    const { storage } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    const first = readLegacySnapshot(storage);
    expect(first.tuples).toHaveLength(14);
    expect(first.tuples[0]).toEqual(['fxj_v4_trades', true, '[1]']);
    const digestA = await digestLegacySnapshot(first);
    expect(digestA).toMatch(/^[0-9a-f]{64}$/);
    storage.setItem('fxj_v4_sync_cursors', '{"trades":{"cursorId":"remote"}}');
    expect(await digestLegacySnapshot(readLegacySnapshot(storage))).not.toBe(digestA);
  });

  it('makes a crypto failure leave claim unavailable', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[]');
    await inspectLegacyOwnership(A, scopeA, deps);
    expect(await claimLegacyOwnership(A, scopeA, { ...deps, digest: async () => { throw new Error('crypto'); } }))
      .toEqual({ kind: 'failed' });
  });
});

describe('locked claim state machine', () => {
  it('runs detection, decline, and claim transitions under the dedicated lock', async () => {
    const { storage, lockProvider, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[]');
    await inspectLegacyOwnership(A, scopeA, deps);
    await declineLegacyOwnership(A, deps);
    expect(lockProvider.requests).toEqual([LEGACY_OWNERSHIP_LOCK_NAME, LEGACY_OWNERSHIP_LOCK_NAME]);
  });

  it('requires explicit claim before reservation and preserves source', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[{"_tid":1}]');
    await inspectLegacyOwnership(A, scopeA, deps);
    expect(JSON.parse(storage.getItem(LEGACY_OWNERSHIP_REGISTRY_KEY)!).state).toBe('legacy_detected_unclaimed');
    expect(storage.getItem(scopeA.physicalKey('fxj_v4_trades'))).toBeNull();
    expect(await claimLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'verified' });
    expect(storage.getItem('fxj_v4_trades')).toBe('[{"_tid":1}]');
  });

  it('copies thirteen datasets exactly, resets cursor, and verifies registry last', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[]');
    storage.setItem('fxj_v4_accounts', 'null');
    storage.setItem('fxj_v4_sync_cursors', '{"trades":{"cursorId":"old"}}');
    await inspectLegacyOwnership(A, scopeA, deps);
    expect(await claimLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'verified' });
    expect(scopeA.getRaw('fxj_v4_trades')).toBe('[]');
    expect(scopeA.getRaw('fxj_v4_accounts')).toBe('null');
    expect(scopeA.getRaw('fxj_v4_sync_cursors')).toBeNull();
    expect(storage.getItem('fxj_v4_sync_cursors')).toContain('old');
    expect(JSON.parse(storage.getItem(LEGACY_OWNERSHIP_REGISTRY_KEY)!).state).toBe('claim_verified');
  });

  it('keeps verified authority when preserved legacy source later becomes malformed', async () => {
    const { storage, scopeA, scopeB, deps } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    await inspectLegacyOwnership(A, scopeA, deps);
    expect(await claimLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'verified' });
    storage.setItem('fxj_v4_trades', '{bad');
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'ready', reason: 'verified_owner' });
    expect(await inspectLegacyOwnership(B, scopeB, deps)).toEqual({ kind: 'ready', reason: 'independent' });
  });

  it('keeps partial writes as same-owner retryable residue', async () => {
    const { storage, scopeA, scopeB, deps } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    await inspectLegacyOwnership(A, scopeA, deps);
    storage.failPhysicalWriteOnce = true;
    expect(await claimLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'failed' });
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'retry_required' });
    expect(await inspectLegacyOwnership(B, scopeB, deps)).toEqual({ kind: 'ready', reason: 'reserved_other' });
    expect(await claimLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'verified' });
  });

  it('rejects another owner while a claim is reserved', async () => {
    const { storage, scopeA, scopeB, deps } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    await inspectLegacyOwnership(A, scopeA, deps);
    storage.failPhysicalWriteOnce = true;
    await claimLegacyOwnership(A, scopeA, deps);
    expect(await claimLegacyOwnership(B, scopeB, deps)).toEqual({ kind: 'reserved_other' });
  });

  it('blocks independent destination replacement and ambiguous missing-registry residue', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    scopeA.setRaw('fxj_v4_accounts', '[{"id":"new"}]');
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'quarantined', reason: 'ambiguous_destination', canContinue: false });
    storage.setItem(LEGACY_OWNERSHIP_REGISTRY_KEY, JSON.stringify({
      version: 1, state: 'legacy_detected_unclaimed', ownerUserId: null, attemptId: null,
      sourceDigest: null, declinedBy: [], updatedAt: 'now', verifiedAt: null, failureCode: null,
    }));
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'destination_conflict' });
  });

  it('records decline, permits independent use, and lets another user explicitly claim', async () => {
    const { storage, scopeA, scopeB, deps } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    await inspectLegacyOwnership(A, scopeA, deps);
    expect(await declineLegacyOwnership(A, deps)).toBe(true);
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'ready', reason: 'independent' });
    expect(await inspectLegacyOwnership(B, scopeB, deps)).toEqual({ kind: 'claim_required' });
    expect(await claimLegacyOwnership(B, scopeB, deps)).toEqual({ kind: 'verified' });
  });

  it('detects source mutation before authority switch', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[1]');
    await inspectLegacyOwnership(A, scopeA, deps);
    let calls = 0;
    const result = await claimLegacyOwnership(A, scopeA, {
      ...deps,
      digest: async (snapshot) => {
        calls += 1;
        if (calls === 2) return 'changed';
        return digestLegacySnapshot(snapshot);
      },
    });
    expect(result).toEqual({ kind: 'source_changed' });
    expect(JSON.parse(storage.getItem(LEGACY_OWNERSHIP_REGISTRY_KEY)!).state).toBe('claim_failed_retryable');
  });

  it('fails closed for corrupt registry state', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[]');
    storage.setItem(LEGACY_OWNERSHIP_REGISTRY_KEY, '{bad');
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'quarantined', reason: 'corrupt_registry', canContinue: false });
  });

  it('fails closed for a structurally valid but state-inconsistent registry', async () => {
    const { storage, scopeA, deps } = setup();
    storage.setItem('fxj_v4_trades', '[]');
    storage.setItem(LEGACY_OWNERSHIP_REGISTRY_KEY, JSON.stringify({
      version: 1, state: 'legacy_detected_unclaimed', ownerUserId: null, attemptId: null,
      sourceDigest: 'unexpected', declinedBy: [], updatedAt: 'now', verifiedAt: null, failureCode: null,
    }));
    expect(await inspectLegacyOwnership(A, scopeA, deps)).toEqual({ kind: 'quarantined', reason: 'corrupt_registry', canContinue: false });
  });

  it('blocks transitions when the Web Lock is unavailable but permits truly empty scoped use', async () => {
    const unavailable: LockProvider = { request: async () => { throw new Error('unavailable'); } };
    const { storage, scopeA, deps } = setup();
    expect(await inspectLegacyOwnership(A, scopeA, { ...deps, lockProvider: unavailable }))
      .toEqual({ kind: 'ready', reason: 'legacy_absent' });
    storage.setItem('fxj_v4_trades', '[]');
    expect(await inspectLegacyOwnership(A, scopeA, { ...deps, lockProvider: unavailable }))
      .toEqual({ kind: 'lock_unavailable' });
  });
});
