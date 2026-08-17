import type { UserStorageScope } from './storageNamespace.js';
import {
  appendBacktestAction, canonicalActionEqual, projectBacktestSession, validateBacktestAction, validateBacktestSession,
} from '@calculations/backtestSession.js';
import type { BacktestAction, BacktestSession, SessionProgress } from '@apptypes/backtestSession.js';

export const BACKTEST_SESSIONS_STORAGE_KEY = 'fxj_v4_backtest_sessions' as const;
export const BACKTEST_SESSIONS_LOCK_NAME = 'trading-journal-ai-backtest-sessions:mutation:v1';

interface BacktestSessionsEnvelope {
  schemaVersion: 1;
  ownerUserId: string;
  sessions: Record<string, BacktestSession>;
}

export type BacktestRepositoryFailureCode =
  | 'not_found' | 'already_exists' | 'invalid_session' | 'invalid_action' | 'id_collision'
  | 'lock_unavailable' | 'corrupt' | 'unsupported_schema' | 'owner_mismatch'
  | 'stale_revision' | 'quota_exceeded' | 'read_failed' | 'write_failed'
  | 'verification_failed' | 'outcome_unknown';

export type BacktestRepositoryResult<T> = { ok: true; value: T; idempotent?: boolean }
  | { ok: false; code: BacktestRepositoryFailureCode; message: string };

export interface BacktestSessionRepository {
  listSessions(): Promise<BacktestRepositoryResult<BacktestSession[]>>;
  createSession(session: BacktestSession): Promise<BacktestRepositoryResult<BacktestSession>>;
  saveProgress(sessionId: string, expectedRevision: number, progress: SessionProgress, updatedAt: string): Promise<BacktestRepositoryResult<BacktestSession>>;
  appendAction(sessionId: string, expectedRevision: number, action: BacktestAction, progress: SessionProgress, updatedAt: string): Promise<BacktestRepositoryResult<BacktestSession>>;
  completeSession(sessionId: string, expectedRevision: number, progress: SessionProgress, updatedAt: string): Promise<BacktestRepositoryResult<BacktestSession>>;
}

export interface BacktestRepositoryDependencies {
  runExclusive?: <T>(name: string, task: () => Promise<T>) => Promise<T>;
}

function fail<T>(code: BacktestRepositoryFailureCode, message: string = code): BacktestRepositoryResult<T> {
  return { ok: false, code, message };
}

function classifyWrite(error: unknown): BacktestRepositoryFailureCode {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22)
    ? 'quota_exceeded' : 'write_failed';
}

function parseEnvelope(raw: string, ownerUserId: string): BacktestRepositoryResult<BacktestSessionsEnvelope> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('corrupt', 'Stored Replay sessions are malformed.'); }
  if (!value || typeof value !== 'object') return fail('corrupt', 'Stored Replay sessions are malformed.');
  const envelope = value as BacktestSessionsEnvelope;
  const envelopeKeys = Object.keys(envelope);
  if (envelopeKeys.length !== 3 || !envelopeKeys.every((key) => ['schemaVersion', 'ownerUserId', 'sessions'].includes(key))) return fail('corrupt');
  if (envelope.schemaVersion !== 1) return fail('unsupported_schema', 'Stored Replay sessions use an unsupported schema.');
  if (envelope.ownerUserId !== ownerUserId) return fail('owner_mismatch', 'Stored Replay sessions belong to another owner.');
  if (!envelope.sessions || typeof envelope.sessions !== 'object' || Array.isArray(envelope.sessions)) return fail('corrupt');
  for (const [id, session] of Object.entries(envelope.sessions)) {
    if (id !== session.sessionId || !validateBacktestSession(session)) return fail('corrupt', 'Stored Replay sessions failed validation.');
  }
  return { ok: true, value: envelope };
}

function cloneSession(session: BacktestSession): BacktestSession {
  return structuredClone(session);
}

export function createBacktestSessionRepository(
  scope: UserStorageScope,
  dependencies: BacktestRepositoryDependencies = {},
): BacktestSessionRepository {
  const runExclusive = dependencies.runExclusive ?? (async <T>(_name: string, task: () => Promise<T>): Promise<T> => {
    if (!navigator.locks?.request) throw new Error('lock_unavailable');
    return navigator.locks.request(BACKTEST_SESSIONS_LOCK_NAME, { mode: 'exclusive' }, task);
  });

  function readExisting(): BacktestRepositoryResult<BacktestSessionsEnvelope | null> {
    let raw: string | null;
    try { raw = scope.getRaw(BACKTEST_SESSIONS_STORAGE_KEY); }
    catch { return fail('read_failed', 'Replay sessions could not be read.'); }
    return raw === null ? { ok: true, value: null } : parseEnvelope(raw, scope.userId);
  }

  async function locked<T>(task: () => Promise<BacktestRepositoryResult<T>>): Promise<BacktestRepositoryResult<T>> {
    try { return await runExclusive(BACKTEST_SESSIONS_LOCK_NAME, task); }
    catch (error) {
      return fail(error instanceof Error && error.message === 'lock_unavailable' ? 'lock_unavailable' : 'lock_unavailable',
        'Exclusive Replay-session storage is unavailable.');
    }
  }

  function verifiedWrite(envelope: BacktestSessionsEnvelope): BacktestRepositoryResult<BacktestSessionsEnvelope> {
    const serialized = JSON.stringify(envelope);
    try { scope.setRaw(BACKTEST_SESSIONS_STORAGE_KEY, serialized); }
    catch (error) { return fail(classifyWrite(error), 'Replay sessions could not be written.'); }
    let observed: string | null;
    try { observed = scope.getRaw(BACKTEST_SESSIONS_STORAGE_KEY); }
    catch { return fail('outcome_unknown', 'The write may have succeeded but could not be verified.'); }
    if (observed !== serialized) return fail('verification_failed', 'The Replay-session write did not verify.');
    const parsed = parseEnvelope(observed, scope.userId);
    return parsed.ok ? parsed : fail('verification_failed', 'The verified bytes failed validation.');
  }

  function updateSession(
    sessionId: string,
    expectedRevision: number,
    transform: (session: BacktestSession) => BacktestRepositoryResult<BacktestSession>,
  ): Promise<BacktestRepositoryResult<BacktestSession>> {
    return locked(async () => {
      const read = readExisting();
      if (!read.ok) return read;
      const envelope = read.value;
      if (envelope === null || envelope.sessions[sessionId] === undefined) return fail('not_found');
      const persisted = envelope.sessions[sessionId];
      if (persisted.revision !== expectedRevision) return fail('stale_revision');
      const transformed = transform(persisted);
      if (!transformed.ok) return transformed;
      const nextEnvelope = { ...envelope, sessions: { ...envelope.sessions, [sessionId]: transformed.value } };
      const write = verifiedWrite(nextEnvelope);
      return write.ok ? { ok: true, value: cloneSession(write.value.sessions[sessionId]) } : write;
    });
  }

  const repository: BacktestSessionRepository = {
    async listSessions(): Promise<BacktestRepositoryResult<BacktestSession[]>> {
      const read = readExisting();
      if (!read.ok) return read;
      const sessions = read.value === null ? [] : Object.values(read.value.sessions).map(cloneSession);
      return { ok: true, value: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
    },

    createSession(session: BacktestSession): Promise<BacktestRepositoryResult<BacktestSession>> {
      return locked(async () => {
        if (!validateBacktestSession(session) || session.revision !== 1 || session.actions.length !== 0 || session.status !== 'active') return fail('invalid_session');
        const read = readExisting();
        if (!read.ok) return read;
        const envelope: BacktestSessionsEnvelope = read.value ?? { schemaVersion: 1, ownerUserId: scope.userId, sessions: {} };
        if (envelope.sessions[session.sessionId] !== undefined) return fail('already_exists');
        const next = { ...envelope, sessions: { ...envelope.sessions, [session.sessionId]: cloneSession(session) } };
        const write = verifiedWrite(next);
        return write.ok ? { ok: true, value: cloneSession(write.value.sessions[session.sessionId]) } : write;
      });
    },

    saveProgress(sessionId: string, expectedRevision: number, progress: SessionProgress, updatedAt: string): Promise<BacktestRepositoryResult<BacktestSession>> {
      return updateSession(sessionId, expectedRevision, (session) => {
        if (session.status === 'completed') return fail('invalid_session', 'Completed sessions are immutable.');
        const next = { ...session, ...progress, updatedAt, revision: session.revision + 1 };
        return validateBacktestSession(next) ? { ok: true, value: next } : fail('invalid_session');
      });
    },

    appendAction(sessionId: string, expectedRevision: number, action: BacktestAction, progress: SessionProgress, updatedAt: string): Promise<BacktestRepositoryResult<BacktestSession>> {
      return locked(async () => {
        const read = readExisting();
        if (!read.ok) return read;
        const envelope = read.value;
        if (envelope === null || envelope.sessions[sessionId] === undefined) return fail('not_found');
        const persisted = envelope.sessions[sessionId];
        if (!validateBacktestAction(action, persisted.series.root) || action.sessionId !== sessionId) return fail('invalid_action');
        const duplicate = persisted.actions.find((candidate) => candidate.actionId === action.actionId);
        if (duplicate !== undefined) {
          if (!canonicalActionEqual(duplicate, action)) return fail('id_collision');
          return { ok: true, value: cloneSession(persisted), idempotent: true };
        }
        if (persisted.revision !== expectedRevision) return fail('stale_revision');
        let next: BacktestSession;
        try { next = appendBacktestAction(persisted, action, progress, updatedAt); }
        catch { return fail('invalid_action'); }
        const nextEnvelope = { ...envelope, sessions: { ...envelope.sessions, [sessionId]: next } };
        const write = verifiedWrite(nextEnvelope);
        return write.ok ? { ok: true, value: cloneSession(write.value.sessions[sessionId]) } : write;
      });
    },

    completeSession(sessionId: string, expectedRevision: number, progress: SessionProgress, updatedAt: string): Promise<BacktestRepositoryResult<BacktestSession>> {
      return updateSession(sessionId, expectedRevision, (session) => {
        const projection = projectBacktestSession(session, Number.MAX_SAFE_INTEGER);
        if (session.status !== 'active' || projection.openAggregate !== null
          || (projection.highWaterMarkUtcMs !== null && progress.cursorUtcMs < projection.highWaterMarkUtcMs)) return fail('invalid_session');
        const next: BacktestSession = { ...session, ...progress, status: 'completed', updatedAt, revision: session.revision + 1 };
        return validateBacktestSession(next) ? { ok: true, value: next } : fail('invalid_session');
      });
    },
  };
  return Object.freeze(repository);
}
