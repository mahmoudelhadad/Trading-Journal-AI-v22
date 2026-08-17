import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useUserStorage } from '@contexts/UserStorageContext.js';
import { canonicalActionEqual, createBacktestSession, projectBacktestSession, sameSessionSeries, validateInitialStop } from '@calculations/backtestSession.js';
import { createBacktestSessionRepository, type BacktestRepositoryFailureCode, type BacktestSessionRepository } from '@services/backtestSessionRepository.js';
import type { ReplayRuntime } from '@services/replayRuntime.js';
import type { ReplaySnapshot } from '@apptypes/replay.js';
import type {
  BacktestAction, BacktestSession, SessionProgress,
} from '@apptypes/backtestSession.js';
import type { ExecutionFill } from '@apptypes/backtestSession.js';

interface PendingRecovery {
  kind: 'action' | 'completion';
  action?: BacktestAction;
}

export interface ReplaySessionsState {
  sessions: BacktestSession[];
  activeSession: BacktestSession | null;
  projection: ReturnType<typeof projectBacktestSession> | null;
  hydrated: boolean;
  pending: boolean;
  safetyBlocked: boolean;
  error: string | null;
  createCurrentSession(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  leaveSession(): Promise<void>;
  /**
   * Flat: opens a new trade with a new tradeId and the supplied stop.
   * Open: same-side Scale In on the existing aggregate tradeId. The side must
   * match the open aggregate, and `initialStopPrice` is ignored because the
   * episode's stop contract is immutable and inherited from the first Entry.
   */
  enter(side: 'long' | 'short', quantity: number, initialStopPrice: number | null): Promise<void>;
  /**
   * Exits `quantity` contracts. Omitting it means "exit all": the remaining
   * quantity verified at intent-capture time is frozen into the candidate and
   * never recomputed afterwards.
   */
  exit(quantity?: number): Promise<void>;
  complete(): Promise<void>;
  recover(): Promise<void>;
}

const resultMessage = (code: BacktestRepositoryFailureCode) => ({
  stale_revision: 'This session changed in another tab. Reload the session before continuing.',
  outcome_unknown: 'The save outcome is unknown. Reload the session to resolve it safely.',
  id_collision: 'A saved action identity conflicts with this command. The session is safety-blocked.',
  corrupt: 'Stored Replay-session data is corrupt and was preserved unchanged.',
  unsupported_schema: 'Stored Replay-session data uses an unsupported schema.',
  owner_mismatch: 'Stored Replay-session ownership does not match the signed-in user.',
  lock_unavailable: 'Safe cross-tab storage locking is unavailable.',
  quota_exceeded: 'Local storage is full; the session was not confirmed saved.',
  read_failed: 'Replay sessions could not be read.',
  write_failed: 'Replay sessions could not be written.',
  verification_failed: 'The Replay-session save could not be verified.',
  not_found: 'The Replay session no longer exists.',
  already_exists: 'That Replay session already exists.',
  invalid_session: 'The Replay session is not valid for this command.',
  invalid_action: 'The simulated action is invalid.',
}[code] ?? code);

export const REPLAY_CHECKPOINT_INTERVAL_MS = 1000;

export function captureReplayProgress(snapshot: ReplaySnapshot): SessionProgress {
  return { cursorUtcMs: snapshot.nowUtcMs, displayTimeframe: snapshot.timeframe, speed: snapshot.speed };
}

export function coalesceReplayCheckpoint(_previous: SessionProgress | null, newest: SessionProgress): SessionProgress {
  return newest;
}

export function shouldPersistReplayCheckpoint(
  session: BacktestSession | null,
  snapshot: ReplaySnapshot,
  safetyBlocked: boolean,
): boolean {
  return !safetyBlocked && session !== null && session.status === 'active'
    && snapshot.canonicalBarrier === null && sameSessionSeries(session.series, snapshot.series)
    && (snapshot.nowUtcMs !== session.cursorUtcMs || snapshot.timeframe !== session.displayTimeframe || snapshot.speed !== session.speed);
}

export function resolvePendingActionRecovery(fresh: BacktestSession, pendingAction: BacktestAction): 'committed' | 'absent' | 'collision' {
  const found = fresh.actions.find((action) => action.actionId === pendingAction.actionId);
  if (found === undefined) return 'absent';
  return canonicalActionEqual(found, pendingAction) ? 'committed' : 'collision';
}

/** A fully resolved canonical intent. Every quantity here is already explicit. */
export type ReplayActionIntent =
  | { kind: 'entry'; side: 'long' | 'short'; quantity: number; initialStopPrice: number | null }
  | { kind: 'exit'; quantity: number };

export function buildCanonicalReplayAction(
  latest: BacktestSession,
  fill: ExecutionFill,
  identity: { actionId: string; tradeId: string; clientCreatedAt: string },
  intent: ReplayActionIntent,
): BacktestAction {
  const base = {
    actionVersion: 1 as const, ...identity, sessionId: latest.sessionId,
    sequence: latest.actions.length + 1,
    quantity: intent.quantity,
    fill,
  };
  return intent.kind === 'entry'
    ? { ...base, kind: 'entry', side: intent.side, initialStopPrice: intent.initialStopPrice }
    : { ...base, kind: 'exit' };
}

export interface ReplaySessionsDependencies {
  repository?: BacktestSessionRepository;
}

export function useReplaySessions(
  runtime: ReplayRuntime,
  snapshot: ReplaySnapshot,
  dependencies: ReplaySessionsDependencies = {},
): ReplaySessionsState {
  const { scope } = useUserStorage();
  const repository = useMemo(() => dependencies.repository ?? createBacktestSessionRepository(scope), [dependencies.repository, scope]);
  const ownerGeneration = useRef(0);
  const selectionAuthority = useRef(0);
  const [sessions, setSessions] = useState<BacktestSession[]>([]);
  const sessionsRef = useRef<BacktestSession[]>([]);
  const [activeSession, setActiveSession] = useState<BacktestSession | null>(null);
  const activeRef = useRef<BacktestSession | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [safetyBlocked, setSafetyBlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recovery = useRef<PendingRecovery | null>(null);
  const mutationTail = useRef<Promise<boolean>>(Promise.resolve(true));
  const checkpointTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCheckpoint = useRef<SessionProgress | null>(null);

  const mergeCanonicalSession = useCallback((session: BacktestSession) => {
    const next = [session, ...sessionsRef.current.filter((item) => item.sessionId !== session.sessionId)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  const adopt = useCallback((session: BacktestSession) => {
    mergeCanonicalSession(session);
    activeRef.current = session;
    setActiveSession(session);
  }, [mergeCanonicalSession]);

  const hardFail = useCallback((code: BacktestRepositoryFailureCode, pendingRecovery: PendingRecovery | null = null) => {
    runtime.pause();
    runtime.setSessionSafetyBlock(true);
    setSafetyBlocked(true);
    setError(resultMessage(code));
    recovery.current = pendingRecovery;
  }, [runtime]);

  const hydrate = useCallback(async () => {
    const generation = ownerGeneration.current;
    const result = await repository.listSessions();
    if (generation !== ownerGeneration.current) return;
    if (!result.ok) { hardFail(result.code); setHydrated(true); return; }
    sessionsRef.current = result.value; setSessions(result.value);
    setHydrated(true);
  }, [repository, hardFail]);

  useEffect(() => {
    ownerGeneration.current += 1;
    selectionAuthority.current += 1;
    activeRef.current = null;
    sessionsRef.current = []; setActiveSession(null); setSessions([]); setHydrated(false); setPending(false); setSafetyBlocked(false); setError(null);
    runtime.releaseCanonicalCommand(); runtime.setSessionSafetyBlock(false); runtime.setSessionMutationBlocked(false); runtime.setSessionSeriesLock(null);
    recovery.current = null; mutationTail.current = Promise.resolve(true);
    void hydrate();
    return () => { ownerGeneration.current += 1; if (checkpointTimer.current !== null) clearTimeout(checkpointTimer.current); };
  }, [scope, hydrate, runtime]);

  const projection = activeSession === null ? null : projectBacktestSession(activeSession, snapshot.nowUtcMs);
  useEffect(() => { runtime.setSessionMutationBlocked(projection?.rewound ?? false); }, [runtime, projection?.rewound]);

  const runCheckpoint = useCallback((captured: SessionProgress): Promise<boolean> => {
    const generation = ownerGeneration.current;
    const operation = mutationTail.current.then(async (priorOk) => {
      if (!priorOk) return false;
      const current = activeRef.current;
      if (current === null || current.status === 'completed' || runtime.getSnapshot().canonicalBarrier !== null) return true;
      const mutationSessionId = current.sessionId;
      const result = await repository.saveProgress(current.sessionId, current.revision, captured, new Date().toISOString());
      if (generation !== ownerGeneration.current) return false;
      if (!result.ok) { hardFail(result.code); return false; }
      mergeCanonicalSession(result.value);
      if (activeRef.current?.sessionId === mutationSessionId) {
        activeRef.current = result.value;
        setActiveSession(result.value);
      }
      return true;
    });
    mutationTail.current = operation;
    return operation;
  }, [hardFail, mergeCanonicalSession, repository, runtime]);

  useEffect(() => {
    if (!hydrated || !shouldPersistReplayCheckpoint(activeSession, snapshot, safetyBlocked)) return;
    pendingCheckpoint.current = coalesceReplayCheckpoint(pendingCheckpoint.current, captureReplayProgress(snapshot));
    if (checkpointTimer.current !== null) return;
    checkpointTimer.current = setTimeout(() => {
      checkpointTimer.current = null;
      const captured = pendingCheckpoint.current;
      pendingCheckpoint.current = null;
      if (captured !== null) void runCheckpoint(captured);
    }, REPLAY_CHECKPOINT_INTERVAL_MS);
  }, [activeSession, hydrated, runCheckpoint, safetyBlocked, snapshot]);

  const cancelPendingCheckpoint = () => {
    pendingCheckpoint.current = null;
    if (checkpointTimer.current !== null) { clearTimeout(checkpointTimer.current); checkpointTimer.current = null; }
  };

  const createCurrentSession = useCallback(async () => {
    if (pending || safetyBlocked) return;
    const now = new Date().toISOString();
    const session = createBacktestSession({
      sessionId: crypto.randomUUID(), series: { ...snapshot.series }, progress: captureReplayProgress(snapshot), createdAt: now,
    });
    const generation = ownerGeneration.current;
    setPending(true);
    const result = await repository.createSession(session);
    if (generation !== ownerGeneration.current) return;
    setPending(false);
    if (!result.ok) { hardFail(result.code); return; }
    adopt(result.value); runtime.setSessionSeriesLock(result.value.series); runtime.pause();
  }, [adopt, hardFail, pending, repository, runtime, safetyBlocked, snapshot]);

  const selectSession = useCallback(async (sessionId: string) => {
    if (pending || safetyBlocked || snapshot.canonicalBarrier !== null) return;
    const session = sessionsRef.current.find((item) => item.sessionId === sessionId);
    if (!session) return;
    const generation = ownerGeneration.current;
    const selectionToken = ++selectionAuthority.current;
    cancelPendingCheckpoint();
    const priorOk = await mutationTail.current;
    if (generation !== ownerGeneration.current || selectionToken !== selectionAuthority.current) return;
    if (!priorOk) { hardFail('write_failed'); return; }
    const latest = sessionsRef.current.find((item) => item.sessionId === sessionId) ?? session;
    runtime.setSessionSeriesLock(latest.series);
    runtime.pause();
    const committed = await runtime.resumeSession(latest.series, latest.cursorUtcMs);
    if (generation !== ownerGeneration.current || selectionToken !== selectionAuthority.current) return;
    if (!committed || !sameSessionSeries(runtime.getSnapshot().series, latest.series)) {
      runtime.setSessionSeriesLock(activeRef.current?.series ?? null);
      return;
    }
    runtime.setTimeframe(latest.displayTimeframe); runtime.setSpeed(latest.speed); runtime.pause();
    adopt(latest);
  }, [adopt, hardFail, pending, runtime, safetyBlocked, snapshot.canonicalBarrier]);

  const leaveSession = useCallback(async () => {
    if (pending || snapshot.canonicalBarrier !== null) return;
    const generation = ownerGeneration.current;
    const selectionToken = ++selectionAuthority.current;
    cancelPendingCheckpoint();
    const priorOk = await mutationTail.current;
    if (generation !== ownerGeneration.current || selectionToken !== selectionAuthority.current) return;
    if (!priorOk) { hardFail('write_failed'); return; }
    activeRef.current = null; setActiveSession(null);
    runtime.setSessionMutationBlocked(false); runtime.setSessionSafetyBlock(false); runtime.setSessionSeriesLock(null);
    setSafetyBlocked(false); setError(null); recovery.current = null;
  }, [hardFail, pending, runtime, snapshot.canonicalBarrier]);

  const execute = useCallback((request:
    | { kind: 'entry'; side: 'long' | 'short'; quantity: number; initialStopPrice: number | null }
    | { kind: 'exit'; quantity: number | undefined },
  ): Promise<void> => {
    const sessionAtClick = activeRef.current;
    if (sessionAtClick === null || sessionAtClick.status !== 'active' || pending || safetyBlocked) return Promise.resolve();
    const atClickProjection = projectBacktestSession(sessionAtClick, snapshot.nowUtcMs);
    if (atClickProjection.rewound) return Promise.resolve();
    // Canonical B2c open state. The legacy `openPosition` view is never
    // consulted for any command decision.
    const aggregate = atClickProjection.openAggregate;
    if (request.kind === 'entry') {
      // Open → Scale In must stay on the aggregate side. An opposite-side Entry
      // is rejected outright and never reinterpreted as a Close.
      if (aggregate !== null && request.side !== aggregate.side) return Promise.resolve();
    } else if (aggregate === null) return Promise.resolve();

    // The intent is resolved once, here, against the verified aggregate at
    // capture time; nothing below is recomputed from later state.
    let intent: ReplayActionIntent;
    if (request.kind === 'entry') {
      intent = {
        kind: 'entry', side: request.side, quantity: request.quantity,
        // A Scale In inherits the episode's immutable stop contract; the caller
        // cannot introduce, change, or remove it.
        initialStopPrice: aggregate === null ? request.initialStopPrice : aggregate.initialStopPrice,
      };
    } else {
      const remaining = aggregate === null ? 0 : aggregate.remainingQuantity;
      // Omitted quantity means "exit all" as verified right now. Over-Exit is
      // rejected outright and never clamped.
      const quantity = request.quantity ?? remaining;
      if (!(Number.isSafeInteger(quantity) && quantity > 0 && quantity <= remaining)) return Promise.resolve();
      intent = { kind: 'exit', quantity };
    }
    const capture = runtime.beginExecutionCommand(sessionAtClick.series);
    if (!capture.ok) { setError(`Execution unavailable: ${capture.reason}.`); return Promise.resolve(); }
    if (intent.kind === 'entry' && !validateInitialStop(
      sessionAtClick.series.root, intent.side, capture.fill.price, intent.initialStopPrice,
    )) {
      runtime.releaseCanonicalCommand(); runtime.pause();
      setError('Initial stop must be tick-aligned and on the risk side of the captured entry fill.');
      return Promise.resolve();
    }
    const capturedProgress = { ...capture.progress };
    const capturedFill = { ...capture.fill };
    cancelPendingCheckpoint(); setPending(true); setError(null);
    const commandGeneration = ownerGeneration.current;
    const identity = { actionId: crypto.randomUUID(), clientCreatedAt: new Date().toISOString() };
    // Flat Entry mints a tradeId; Scale In and Exit reuse the aggregate's.
    const tradeId = aggregate === null ? crypto.randomUUID() : aggregate.tradeId;
    return (async () => {
      const priorOk = await mutationTail.current;
      if (commandGeneration !== ownerGeneration.current) return;
      if (!priorOk) { setPending(false); hardFail('write_failed'); return; }
      const latest = activeRef.current;
      if (latest === null) { setPending(false); hardFail('not_found'); return; }
      const action = buildCanonicalReplayAction(latest, capturedFill,
        { ...identity, tradeId }, intent);
      const operation = repository.appendAction(latest.sessionId, latest.revision, action, capturedProgress, new Date().toISOString());
      mutationTail.current = operation.then((result) => result.ok, () => false);
      const result = await operation;
      if (commandGeneration !== ownerGeneration.current) return;
      setPending(false);
      if (!result.ok) { hardFail(result.code, { kind: 'action', action }); return; }
      adopt(result.value); runtime.releaseCanonicalCommand(); runtime.pause();
    })();
  }, [adopt, hardFail, pending, repository, runtime, safetyBlocked, snapshot.nowUtcMs]);

  const enter = useCallback((side: 'long' | 'short', quantity: number, initialStopPrice: number | null) => execute({ kind: 'entry', side, quantity, initialStopPrice }), [execute]);
  const exit = useCallback((quantity?: number) => execute({ kind: 'exit', quantity }), [execute]);

  const complete = useCallback(async () => {
    const sessionAtClick = activeRef.current;
    if (sessionAtClick === null || sessionAtClick.status !== 'active' || pending || safetyBlocked) return;
    const projected = projectBacktestSession(sessionAtClick, snapshot.nowUtcMs);
    // Flat is decided by the aggregate: a partial Exit still leaves it open.
    if (projected.rewound || projected.openAggregate !== null || !sameSessionSeries(sessionAtClick.series, snapshot.series)) return;
    const capture = runtime.beginCompletionCommand(sessionAtClick.series);
    if (!capture.ok) { setError(`Completion unavailable: ${capture.reason}.`); return; }
    cancelPendingCheckpoint(); setPending(true); setError(null);
    const commandGeneration = ownerGeneration.current;
    const priorOk = await mutationTail.current;
    if (commandGeneration !== ownerGeneration.current) return;
    if (!priorOk) { setPending(false); hardFail('write_failed'); return; }
    const latest = activeRef.current;
    if (latest === null || projectBacktestSession(latest, Number.MAX_SAFE_INTEGER).openAggregate !== null) {
      setPending(false); hardFail('invalid_session'); return;
    }
    const operation = repository.completeSession(latest.sessionId, latest.revision, capture.progress, new Date().toISOString());
    mutationTail.current = operation.then((result) => result.ok, () => false);
    const result = await operation;
    if (commandGeneration !== ownerGeneration.current) return;
    setPending(false);
    if (!result.ok) { hardFail(result.code, { kind: 'completion' }); return; }
    adopt(result.value); runtime.releaseCanonicalCommand(); runtime.pause();
  }, [adopt, hardFail, pending, repository, runtime, safetyBlocked, snapshot]);

  const recover = useCallback(async () => {
    const generation = ownerGeneration.current;
    const result = await repository.listSessions();
    if (generation !== ownerGeneration.current) return;
    if (!result.ok) { hardFail(result.code, recovery.current); return; }
    sessionsRef.current = result.value; setSessions(result.value);
    const previous = activeRef.current;
    const fresh = previous === null ? null : result.value.find((item) => item.sessionId === previous.sessionId) ?? null;
    const pendingRecovery = recovery.current;
    if (fresh !== null && pendingRecovery?.kind === 'action' && pendingRecovery.action !== undefined) {
      if (resolvePendingActionRecovery(fresh, pendingRecovery.action) === 'collision') {
        hardFail('id_collision', pendingRecovery); return;
      }
    }
    if (fresh !== null) { adopt(fresh); runtime.setSessionSeriesLock(fresh.series); }
    else { activeRef.current = null; setActiveSession(null); }
    recovery.current = null; setSafetyBlocked(false); setError(null);
    runtime.setSessionSafetyBlock(false); runtime.releaseCanonicalCommand(); runtime.pause();
    mutationTail.current = Promise.resolve(true);
  }, [adopt, hardFail, repository, runtime]);

  return { sessions, activeSession, projection, hydrated, pending, safetyBlocked, error,
    createCurrentSession, selectSession, leaveSession, enter, exit, complete, recover };
}
