import { webLocksProvider, type LockProvider } from '@sync/crossTabCoordinator.js';
import {
  USER_STORAGE_LOGICAL_KEYS,
  type RawStorage,
  type UserStorageLogicalKey,
  type UserStorageScope,
  validateUserStorageId,
} from './storageNamespace.js';

export const LEGACY_OWNERSHIP_REGISTRY_KEY = 'fxj:device:v1:legacy-ownership';
export const LEGACY_OWNERSHIP_LOCK_NAME = 'trading-journal-ai:legacy-claim:v1';
export const SYNC_CURSOR_LOGICAL_KEY: UserStorageLogicalKey = 'fxj_v4_sync_cursors';

export type LegacyAuthorityState =
  | 'legacy_absent'
  | 'legacy_detected_unclaimed'
  | 'claim_in_progress'
  | 'claim_failed_retryable'
  | 'claim_verified';

export interface LegacyOwnershipRegistry {
  version: 1;
  state: LegacyAuthorityState;
  ownerUserId: string | null;
  attemptId: string | null;
  sourceDigest: string | null;
  declinedBy: string[];
  updatedAt: string;
  verifiedAt: string | null;
  failureCode: string | null;
}

export type SnapshotTuple = readonly [UserStorageLogicalKey, boolean, string | null];

export interface LegacySnapshot {
  tuples: readonly SnapshotTuple[];
  malformedKeys: readonly UserStorageLogicalKey[];
  hasPhysicalData: boolean;
}

export type OwnershipInspection =
  | { kind: 'ready'; reason: 'legacy_absent' | 'verified_owner' | 'independent' | 'reserved_other' }
  | { kind: 'claim_required' }
  | { kind: 'retry_required' }
  | { kind: 'quarantined'; reason: 'malformed_legacy' | 'corrupt_registry' | 'ambiguous_destination' | 'missing_source'; canContinue: boolean }
  | { kind: 'destination_conflict' }
  | { kind: 'lock_unavailable' };

export interface OwnershipDependencies {
  storage?: RawStorage;
  lockProvider?: LockProvider;
  digest?: (snapshot: LegacySnapshot) => Promise<string>;
  now?: () => string;
  attemptId?: () => string;
}

const defaultStorage = (): RawStorage => localStorage;
const defaultNow = () => new Date().toISOString();
const defaultAttemptId = () => crypto.randomUUID();

function dependencies(input: OwnershipDependencies) {
  return {
    storage: input.storage ?? defaultStorage(),
    lockProvider: input.lockProvider ?? webLocksProvider,
    digest: input.digest ?? digestLegacySnapshot,
    now: input.now ?? defaultNow,
    attemptId: input.attemptId ?? defaultAttemptId,
  };
}

export function readLegacySnapshot(storage: RawStorage): LegacySnapshot {
  const malformedKeys: UserStorageLogicalKey[] = [];
  const tuples = USER_STORAGE_LOGICAL_KEYS.map((logicalKey): SnapshotTuple => {
    const raw = storage.getItem(logicalKey);
    if (raw === null) return [logicalKey, false, null];
    try {
      JSON.parse(raw);
    } catch {
      malformedKeys.push(logicalKey);
    }
    return [logicalKey, true, raw];
  });
  return {
    tuples,
    malformedKeys,
    hasPhysicalData: tuples.some(([, present]) => present),
  };
}

export async function digestLegacySnapshot(snapshot: LegacySnapshot): Promise<string> {
  if (typeof TextEncoder === 'undefined' || typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('SHA-256 is unavailable.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot.tuples));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseRegistry(raw: string | null): LegacyOwnershipRegistry | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('corrupt_registry');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('corrupt_registry');
  const record = value as Record<string, unknown>;
  const states: LegacyAuthorityState[] = [
    'legacy_absent', 'legacy_detected_unclaimed', 'claim_in_progress',
    'claim_failed_retryable', 'claim_verified',
  ];
  if (record.version !== 1 || !states.includes(record.state as LegacyAuthorityState)
    || !(record.ownerUserId === null || typeof record.ownerUserId === 'string')
    || !(record.attemptId === null || typeof record.attemptId === 'string')
    || !(record.sourceDigest === null || typeof record.sourceDigest === 'string')
    || !isStringArray(record.declinedBy)
    || typeof record.updatedAt !== 'string'
    || !(record.verifiedAt === null || typeof record.verifiedAt === 'string')
    || !(record.failureCode === null || typeof record.failureCode === 'string')) {
    throw new Error('corrupt_registry');
  }
  const parsed = record as unknown as LegacyOwnershipRegistry;
  const reserved = parsed.state === 'claim_in_progress'
    || parsed.state === 'claim_failed_retryable'
    || parsed.state === 'claim_verified';
  if (reserved && (!parsed.ownerUserId || !parsed.attemptId || !parsed.sourceDigest)) throw new Error('corrupt_registry');
  if (!reserved && (parsed.ownerUserId !== null || parsed.attemptId !== null || parsed.sourceDigest !== null
    || parsed.verifiedAt !== null || parsed.failureCode !== null)) throw new Error('corrupt_registry');
  if (parsed.state === 'claim_in_progress' && (parsed.verifiedAt !== null || parsed.failureCode !== null)) throw new Error('corrupt_registry');
  if (parsed.state === 'claim_failed_retryable' && (parsed.verifiedAt !== null || !parsed.failureCode)) throw new Error('corrupt_registry');
  if (parsed.state === 'claim_verified' && (parsed.verifiedAt === null || parsed.failureCode !== null)) throw new Error('corrupt_registry');
  try {
    if (parsed.ownerUserId) validateUserStorageId(parsed.ownerUserId);
    parsed.declinedBy.forEach(validateUserStorageId);
  } catch {
    throw new Error('corrupt_registry');
  }
  return parsed;
}

function readRegistry(storage: RawStorage): LegacyOwnershipRegistry | null {
  return parseRegistry(storage.getItem(LEGACY_OWNERSHIP_REGISTRY_KEY));
}

function writeRegistry(storage: RawStorage, registry: LegacyOwnershipRegistry): void {
  const raw = JSON.stringify(registry);
  storage.setItem(LEGACY_OWNERSHIP_REGISTRY_KEY, raw);
  const readBack = storage.getItem(LEGACY_OWNERSHIP_REGISTRY_KEY);
  if (readBack !== raw) throw new Error('registry_read_back_failed');
  parseRegistry(readBack);
}

async function withOwnershipLock<T>(lockProvider: LockProvider, action: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await lockProvider.request(LEGACY_OWNERSHIP_LOCK_NAME, async () => {
    result = await action();
  });
  if (result === undefined) throw new Error('ownership_lock_did_not_run');
  return result;
}

function hasScopedDestination(scope: UserStorageScope): boolean {
  return USER_STORAGE_LOGICAL_KEYS.some((key) => scope.getRaw(key) !== null);
}

function baseRegistry(state: LegacyAuthorityState, now: string): LegacyOwnershipRegistry {
  return {
    version: 1,
    state,
    ownerUserId: null,
    attemptId: null,
    sourceDigest: null,
    declinedBy: [],
    updatedAt: now,
    verifiedAt: null,
    failureCode: null,
  };
}

async function inspectLocked(
  userId: string,
  scope: UserStorageScope,
  deps: ReturnType<typeof dependencies>,
): Promise<OwnershipInspection> {
  let registry: LegacyOwnershipRegistry | null;
  try {
    registry = readRegistry(deps.storage);
  } catch {
    return { kind: 'quarantined', reason: 'corrupt_registry', canContinue: false };
  }
  const registryWasMissing = registry === null;
  const snapshot = readLegacySnapshot(deps.storage);

  if (!snapshot.hasPhysicalData) {
    if (registry?.state === 'claim_in_progress' || registry?.state === 'claim_failed_retryable') {
      return registry.ownerUserId === userId
        ? { kind: 'quarantined', reason: 'missing_source', canContinue: false }
        : { kind: 'ready', reason: 'reserved_other' };
    }
    if (registry?.state === 'claim_verified' && registry.ownerUserId === userId) {
      return { kind: 'ready', reason: 'verified_owner' };
    }
    if (registry?.state === 'claim_verified') return { kind: 'ready', reason: 'independent' };
    if (!registry || registry.state !== 'legacy_absent') {
      writeRegistry(deps.storage, baseRegistry('legacy_absent', deps.now()));
    }
    return { kind: 'ready', reason: 'legacy_absent' };
  }

  if (!registry || registry.state === 'legacy_absent') {
    registry = baseRegistry('legacy_detected_unclaimed', deps.now());
    writeRegistry(deps.storage, registry);
  }

  if (registry.state === 'claim_verified') {
    return registry.ownerUserId === userId
      ? { kind: 'ready', reason: 'verified_owner' }
      : { kind: 'ready', reason: 'independent' };
  }
  if (registry.state === 'claim_in_progress' || registry.state === 'claim_failed_retryable') {
    if (registry.ownerUserId !== userId) return { kind: 'ready', reason: 'reserved_other' };
    return snapshot.malformedKeys.length > 0
      ? { kind: 'quarantined', reason: 'malformed_legacy', canContinue: false }
      : { kind: 'retry_required' };
  }
  if (snapshot.malformedKeys.length > 0) {
    if (registry.declinedBy.includes(userId)) return { kind: 'ready', reason: 'independent' };
    return { kind: 'quarantined', reason: 'malformed_legacy', canContinue: true };
  }
  if (registry.declinedBy.includes(userId)) return { kind: 'ready', reason: 'independent' };
  if (hasScopedDestination(scope)) {
    return registryWasMissing
      ? { kind: 'quarantined', reason: 'ambiguous_destination', canContinue: false }
      : { kind: 'destination_conflict' };
  }
  return { kind: 'claim_required' };
}

export async function inspectLegacyOwnership(
  userId: string,
  scope: UserStorageScope,
  input: OwnershipDependencies = {},
): Promise<OwnershipInspection> {
  const deps = dependencies(input);
  const preliminary = readLegacySnapshot(deps.storage);
  if (!preliminary.hasPhysicalData && deps.storage.getItem(LEGACY_OWNERSHIP_REGISTRY_KEY) === null) {
    try {
      return await withOwnershipLock(deps.lockProvider, () => inspectLocked(userId, scope, deps));
    } catch {
      return { kind: 'ready', reason: 'legacy_absent' };
    }
  }
  try {
    return await withOwnershipLock(deps.lockProvider, () => inspectLocked(userId, scope, deps));
  } catch {
    return { kind: 'lock_unavailable' };
  }
}

export async function declineLegacyOwnership(
  userId: string,
  input: OwnershipDependencies = {},
): Promise<boolean> {
  const deps = dependencies(input);
  try {
    return await withOwnershipLock(deps.lockProvider, async () => {
      let registry = readRegistry(deps.storage);
      const snapshot = readLegacySnapshot(deps.storage);
      if (!snapshot.hasPhysicalData) return true;
      if (!registry || registry.state === 'legacy_absent') registry = baseRegistry('legacy_detected_unclaimed', deps.now());
      if (registry.state !== 'legacy_detected_unclaimed') return false;
      writeRegistry(deps.storage, {
        ...registry,
        declinedBy: [...new Set([...registry.declinedBy, userId])],
        updatedAt: deps.now(),
      });
      return true;
    });
  } catch {
    return false;
  }
}

export type ClaimResult =
  | { kind: 'verified' }
  | { kind: 'destination_conflict' | 'malformed_legacy' | 'reserved_other' | 'source_changed' | 'failed' | 'lock_unavailable' };

export async function claimLegacyOwnership(
  userId: string,
  scope: UserStorageScope,
  input: OwnershipDependencies = {},
): Promise<ClaimResult> {
  const deps = dependencies(input);
  try {
    return await withOwnershipLock(deps.lockProvider, async () => {
      const registry = readRegistry(deps.storage);
      const source = readLegacySnapshot(deps.storage);
      if (!source.hasPhysicalData || source.malformedKeys.length > 0) return { kind: 'malformed_legacy' };

      const retry = registry?.state === 'claim_in_progress' || registry?.state === 'claim_failed_retryable';
      if (retry && registry.ownerUserId !== userId) return { kind: 'reserved_other' };
      if (registry?.state === 'claim_verified') {
        return registry.ownerUserId === userId ? { kind: 'verified' } : { kind: 'reserved_other' };
      }
      if (registry && registry.state !== 'legacy_detected_unclaimed' && !retry) return { kind: 'failed' };
      if (!retry && hasScopedDestination(scope)) return { kind: 'destination_conflict' };

      let sourceDigest: string;
      try {
        sourceDigest = await deps.digest(source);
      } catch {
        return { kind: 'failed' };
      }
      const attemptId = retry ? registry.attemptId! : deps.attemptId();
      const inProgress: LegacyOwnershipRegistry = {
        version: 1,
        state: 'claim_in_progress',
        ownerUserId: userId,
        attemptId,
        sourceDigest,
        declinedBy: registry?.declinedBy ?? [],
        updatedAt: deps.now(),
        verifiedAt: null,
        failureCode: null,
      };
      writeRegistry(deps.storage, inProgress);

      try {
        for (const [logicalKey, present, raw] of source.tuples) {
          if (logicalKey === SYNC_CURSOR_LOGICAL_KEY || !present) scope.remove(logicalKey);
          else scope.setRaw(logicalKey, raw!);
        }
        for (const [logicalKey, present, raw] of source.tuples) {
          const destination = scope.getRaw(logicalKey);
          if (logicalKey === SYNC_CURSOR_LOGICAL_KEY) {
            if (destination !== null && destination !== '{}') throw new Error('cursor_not_reset');
          } else if (destination !== (present ? raw : null)) {
            throw new Error('destination_read_back_failed');
          }
        }
        const recheck = readLegacySnapshot(deps.storage);
        if (await deps.digest(recheck) !== sourceDigest) {
          writeRegistry(deps.storage, { ...inProgress, state: 'claim_failed_retryable', updatedAt: deps.now(), failureCode: 'source_changed' });
          return { kind: 'source_changed' };
        }
        const verified: LegacyOwnershipRegistry = {
          ...inProgress,
          state: 'claim_verified',
          updatedAt: deps.now(),
          verifiedAt: deps.now(),
        };
        writeRegistry(deps.storage, verified);
        const readBack = readRegistry(deps.storage);
        if (!readBack || readBack.state !== 'claim_verified' || readBack.ownerUserId !== userId
          || readBack.attemptId !== attemptId || readBack.sourceDigest !== sourceDigest) {
          throw new Error('verified_read_back_failed');
        }
        return { kind: 'verified' };
      } catch (error) {
        try {
          writeRegistry(deps.storage, {
            ...inProgress,
            state: 'claim_failed_retryable',
            updatedAt: deps.now(),
            failureCode: error instanceof Error ? error.message : 'claim_failed',
          });
        } catch {
          // An unreadable registry is fail-closed by the next inspection.
        }
        return { kind: 'failed' };
      }
    });
  } catch {
    return { kind: 'lock_unavailable' };
  }
}
