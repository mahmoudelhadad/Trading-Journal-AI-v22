import React, { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBacktestAction, createBacktestSession } from '@calculations/backtestSession.js';
import { submitReplayEntryIntent } from '@components/replay/ReplayTradingPanel.js';
import {
  REPLAY_CHECKPOINT_INTERVAL_MS, buildCanonicalReplayAction, captureReplayProgress, coalesceReplayCheckpoint,
  resolvePendingActionRecovery, shouldPersistReplayCheckpoint,
  useReplaySessions, type ReplaySessionsState,
} from './useReplaySessions.js';
import { UserStorageProvider } from '@contexts/UserStorageContext.js';
import { createUserStorageScope, type RawStorage, type UserStorageScope } from '@services/storageNamespace.js';
import {
  BACKTEST_SESSIONS_STORAGE_KEY, createBacktestSessionRepository,
  type BacktestSessionRepository, type BacktestRepositoryResult,
} from '@services/backtestSessionRepository.js';
import type { ReplayRuntime } from '@services/replayRuntime.js';
import { createReplayRuntime } from '@services/replayRuntime.js';
import type { HistoricalAvailability, HistoricalBarReader, HistoricalReadResult } from '@services/historicalBarReader.js';
import type { HistoricalBar, HistoricalSeriesIdentity } from '@apptypes/marketData.js';
import type { BacktestAction, BacktestEntryAction, BacktestSession, SessionProgress } from '@apptypes/backtestSession.js';
import type { ReplaySnapshot } from '@apptypes/replay.js';

const SID = '11111111-1111-4111-8111-111111111111';
const AID = '22222222-2222-4222-8222-222222222222';
const TID = '33333333-3333-4333-8333-333333333333';
const T0 = 1_700_000_040_000;
const ISO = '2026-08-14T12:00:00.000Z';
const session = () => createBacktestSession({
  sessionId: SID, series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
  progress: { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, createdAt: ISO,
});
const action = (quantity = 1): BacktestEntryAction => ({
  actionVersion: 1, actionId: AID, tradeId: TID, sessionId: SID, sequence: 1, kind: 'entry', side: 'long', quantity, initialStopPrice: null,
  fill: { decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0, price: 100, basis: 'revealed_1m_close' }, clientCreatedAt: ISO,
});
const snapshot = (overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot => ({
  series: session().series, nowUtcMs: T0, speed: 1, timeframe: '1m', playState: 'paused', bars: [],
  availability: { available: true }, coverageStartUtcMs: null, coverageEndUtcMs: null,
  loading: false, importing: false, error: null, canonicalBarrier: null, ...overrides,
});

const SID_B = '55555555-5555-4555-8555-555555555555';
const OWNER_A = 'a1234567-89ab-4cde-8fab-0123456789ab';
const OWNER_B = 'b1234567-89ab-4cde-8fab-0123456789ab';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function clone<T>(value: T): T { return structuredClone(value); }

function sessionB(): BacktestSession {
  return createBacktestSession({
    sessionId: SID_B, series: { root: 'ES', expiryYear: 2026, expiryMonth: 12, timeframe: '1m' },
    progress: { cursorUtcMs: T0 + 120_000, displayTimeframe: '5m', speed: 5 }, createdAt: '2026-08-14T12:02:00.000Z',
  });
}

function openSession(): BacktestSession {
  return appendBacktestAction(session(), action(), { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, ISO);
}

class MemoryStorage implements RawStorage {
  values = new Map<string, string>();
  writes = 0;
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes += 1; this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const TestUserStorageProvider = UserStorageProvider as React.ComponentType<{
  scope: UserStorageScope;
  children?: React.ReactNode;
}>;

class RepositoryStub implements BacktestSessionRepository {
  sessions: BacktestSession[];
  listCalls = 0;
  createCalls: BacktestSession[] = [];
  saveCalls: Array<{ sessionId: string; expectedRevision: number; progress: SessionProgress }> = [];
  appendCalls: Array<{ sessionId: string; expectedRevision: number; action: BacktestAction; progress: SessionProgress }> = [];
  completeCalls: Array<{ sessionId: string; expectedRevision: number; progress: SessionProgress }> = [];
  listQueue: Array<Promise<BacktestRepositoryResult<BacktestSession[]>>> = [];
  saveQueue: Array<Promise<BacktestRepositoryResult<BacktestSession>>> = [];
  appendQueue: Array<Promise<BacktestRepositoryResult<BacktestSession>>> = [];
  completeQueue: Array<Promise<BacktestRepositoryResult<BacktestSession>>> = [];

  constructor(sessions: BacktestSession[]) { this.sessions = clone(sessions); }

  async listSessions() {
    this.listCalls += 1;
    return this.listQueue.shift() ?? { ok: true as const, value: clone(this.sessions) };
  }

  async createSession(value: BacktestSession) {
    this.createCalls.push(clone(value)); this.sessions.push(clone(value));
    return { ok: true as const, value: clone(value) };
  }

  async saveProgress(sessionId: string, expectedRevision: number, progress: SessionProgress, updatedAt: string) {
    this.saveCalls.push({ sessionId, expectedRevision, progress: clone(progress) });
    const queued = this.saveQueue.shift(); if (queued) return queued;
    const current = this.sessions.find((item) => item.sessionId === sessionId)!;
    const next = { ...current, ...progress, revision: current.revision + 1, updatedAt };
    this.replace(next); return { ok: true as const, value: clone(next) };
  }

  async appendAction(sessionId: string, expectedRevision: number, value: BacktestAction, progress: SessionProgress, updatedAt: string) {
    this.appendCalls.push({ sessionId, expectedRevision, action: clone(value), progress: clone(progress) });
    const queued = this.appendQueue.shift(); if (queued) return queued;
    const current = this.sessions.find((item) => item.sessionId === sessionId)!;
    const next = appendBacktestAction(current, value, progress, updatedAt);
    this.replace(next); return { ok: true as const, value: clone(next) };
  }

  async completeSession(sessionId: string, expectedRevision: number, progress: SessionProgress, updatedAt: string) {
    this.completeCalls.push({ sessionId, expectedRevision, progress: clone(progress) });
    const queued = this.completeQueue.shift(); if (queued) return queued;
    const current = this.sessions.find((item) => item.sessionId === sessionId)!;
    const next: BacktestSession = { ...current, ...progress, status: 'completed', revision: current.revision + 1, updatedAt };
    this.replace(next); return { ok: true as const, value: clone(next) };
  }

  replace(value: BacktestSession) {
    this.sessions = [clone(value), ...this.sessions.filter((item) => item.sessionId !== value.sessionId)];
  }
}

class RuntimeStub {
  snapshot: ReplaySnapshot;
  executionCaptures = 0;
  completionCaptures = 0;
  releases = 0;
  locks: Array<BacktestSession['series'] | null> = [];
  resumeCalls: Array<{ series: BacktestSession['series']; cursorUtcMs: number }> = [];
  resumeQueue: Array<Promise<boolean>> = [];
  resumeAuthority = 0;
  fillPrice = 100;

  constructor(value = snapshot()) { this.snapshot = value; }
  getSnapshot = () => this.snapshot;
  pause = vi.fn(() => { this.snapshot = { ...this.snapshot, playState: 'paused' }; });
  beginExecutionCommand = vi.fn((series: BacktestSession['series']) => {
    if (this.snapshot.canonicalBarrier !== null) return { ok: false as const, reason: 'command_pending' as const };
    this.executionCaptures += 1; this.snapshot = { ...this.snapshot, canonicalBarrier: 'action' };
    return { ok: true as const, progress: captureReplayProgress(this.snapshot), fill: {
      decisionUtcMs: this.snapshot.nowUtcMs, sourceBarStartUtcMs: this.snapshot.nowUtcMs - 60_000,
      sourceBarCloseUtcMs: this.snapshot.nowUtcMs, price: this.fillPrice, basis: 'revealed_1m_close' as const,
    }, series };
  });
  beginCompletionCommand = vi.fn(() => {
    if (this.snapshot.canonicalBarrier !== null) return { ok: false as const, reason: 'command_pending' as const };
    this.completionCaptures += 1; this.snapshot = { ...this.snapshot, canonicalBarrier: 'completion' };
    return { ok: true as const, progress: captureReplayProgress(this.snapshot) };
  });
  releaseCanonicalCommand = vi.fn(() => { this.releases += 1; this.snapshot = { ...this.snapshot, canonicalBarrier: null }; });
  setSessionSafetyBlock = vi.fn();
  setSessionMutationBlocked = vi.fn();
  setSessionSeriesLock = vi.fn((series: BacktestSession['series'] | null) => { this.locks.push(series === null ? null : clone(series)); });
  setTimeframe = vi.fn((timeframe: ReplaySnapshot['timeframe']) => { this.snapshot = { ...this.snapshot, timeframe }; });
  setSpeed = vi.fn((speed: number) => { this.snapshot = { ...this.snapshot, speed: speed as ReplaySnapshot['speed'] }; return true; });
  async resumeSession(series: BacktestSession['series'], cursorUtcMs: number) {
    const token = ++this.resumeAuthority;
    this.resumeCalls.push({ series: clone(series), cursorUtcMs });
    const queued = this.resumeQueue.shift();
    const allowed = queued ? await queued : true;
    if (!allowed || token !== this.resumeAuthority) return false;
    this.snapshot = { ...this.snapshot, series: clone(series), nowUtcMs: cursorUtcMs, playState: 'paused' };
    return true;
  }
}

interface MountedHarness {
  repository: RepositoryStub;
  runtime: RuntimeStub;
  state(): ReplaySessionsState;
  render(owner: string, repository?: RepositoryStub): Promise<void>;
  setSnapshot(patch: Partial<ReplaySnapshot>): Promise<void>;
  unmount(): Promise<void>;
}

function installMinimalDom(): Element {
  const doc = { nodeType: 9, addEventListener() {}, removeEventListener() {}, defaultView: null as unknown };
  const win = { document: doc, HTMLIFrameElement: function HTMLIFrameElement() {}, event: undefined };
  doc.defaultView = win;
  Object.assign(globalThis, { window: win, document: doc, IS_REACT_ACT_ENVIRONMENT: true });
  return {
    nodeType: 1, tagName: 'DIV', nodeName: 'DIV', ownerDocument: doc,
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, insertBefore() {}, textContent: '',
  } as unknown as Element;
}

async function mountController(
  initialSessions: BacktestSession[] = [session()],
  initialRepository = new RepositoryStub(initialSessions),
): Promise<MountedHarness> {
  const runtime = new RuntimeStub(snapshot({ series: clone(initialSessions[0].series), nowUtcMs: initialSessions[0].cursorUtcMs }));
  let repository = initialRepository;
  let owner = OWNER_A;
  let storage = new MemoryStorage();
  let scope = createUserStorageScope(owner, storage);
  let currentSnapshot = runtime.snapshot;
  let currentState!: ReplaySessionsState;
  const root: Root = createRoot(installMinimalDom());
  function Probe() { currentState = useReplaySessions(runtime as unknown as ReplayRuntime, currentSnapshot, { repository }); return null; }
  const renderTree = async () => {
    await act(async () => {
      root.render(React.createElement(TestUserStorageProvider, { scope }, React.createElement(Probe)));
      await Promise.resolve(); await Promise.resolve();
    });
  };
  await renderTree();
  return {
    get repository() { return repository; }, runtime,
    state: () => currentState,
    async render(nextOwner, nextRepository = repository) {
      if (nextOwner !== owner) {
        owner = nextOwner;
        storage = new MemoryStorage();
        scope = createUserStorageScope(owner, storage);
      }
      repository = nextRepository;
      await renderTree();
    },
    async setSnapshot(patch) { runtime.snapshot = { ...runtime.snapshot, ...patch }; currentSnapshot = runtime.snapshot; await renderTree(); },
    async unmount() { await act(async () => root.unmount()); },
  };
}

interface ProductionMountedHarness<T extends BacktestSessionRepository = RepositoryStub> {
  repository: T;
  runtime: ReplayRuntime;
  state(): ReplaySessionsState;
  select(sessionId?: string): Promise<void>;
  unmount(): Promise<void>;
}

const productionBars: HistoricalBar[] = [
  { t: T0 - 60_000, o: 123.75, h: 124, l: 123.5, c: 123.75, v: 10 },
  { t: T0, o: 124, h: 124.5, l: 123.75, c: 124.25, v: 11 },
  { t: T0 + 60_000, o: 124.25, h: 125, l: 124, c: 124.75, v: 12 },
];
const productionAvailability: HistoricalAvailability = {
  available: true, observedFirstUtcMs: T0 - 60_000,
  observedLastUtcMs: T0 + 60_000, observedDays: ['2023-11-14'],
};
const productionRead = (bars: HistoricalBar[]): HistoricalReadResult => ({
  ok: true, bars, returnedFirstUtcMs: bars[0]?.t ?? null,
  returnedLastUtcMs: bars.length === 0 ? null : bars[bars.length - 1].t,
});

async function mountProductionController(initial: BacktestSession): Promise<ProductionMountedHarness<RepositoryStub>>;
async function mountProductionController<T extends BacktestSessionRepository>(
  initial: BacktestSession, suppliedRepository: T, suppliedScope?: UserStorageScope,
  suppliedReader?: HistoricalBarReader,
): Promise<ProductionMountedHarness<T>>;
async function mountProductionController(
  initial: BacktestSession,
  suppliedRepository?: BacktestSessionRepository,
  suppliedScope?: UserStorageScope,
  suppliedReader?: HistoricalBarReader,
): Promise<ProductionMountedHarness<BacktestSessionRepository>> {
  const defaultReader: HistoricalBarReader = {
    getLocalAvailability: vi.fn(async () => productionAvailability),
    readBars: vi.fn(async () => productionRead(productionBars)),
  };
  const reader = suppliedReader ?? defaultReader;
  let frameId = 0;
  const runtime = createReplayRuntime({
    openReader: vi.fn(async () => reader), monotonicNow: () => 0,
    requestFrame: () => { frameId += 1; return frameId; }, cancelFrame: () => {},
    visibility: { isHidden: () => false, add: () => {}, remove: () => {} },
  });
  runtime.attach();
  await runtime.resumeSession(initial.series, initial.cursorUtcMs);
  const repository = suppliedRepository ?? new RepositoryStub([initial]);
  const scope = suppliedScope ?? createUserStorageScope(OWNER_A, new MemoryStorage());
  let currentState!: ReplaySessionsState;
  const root: Root = createRoot(installMinimalDom());
  function Probe() {
    const currentSnapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
    currentState = useReplaySessions(runtime, currentSnapshot, { repository });
    return null;
  }
  await act(async () => {
    root.render(React.createElement(TestUserStorageProvider, { scope }, React.createElement(Probe)));
    await Promise.resolve(); await Promise.resolve();
  });
  return {
    repository, runtime, state: () => currentState,
    async select(sessionId = initial.sessionId) { await act(async () => { await currentState.selectSession(sessionId); }); },
    async unmount() { runtime.detach(); await act(async () => root.unmount()); },
  };
}

async function select(h: MountedHarness, sessionId = SID) {
  await act(async () => { await h.state().selectSession(sessionId); });
  await h.setSnapshot({});
}

async function startCheckpoint(h: MountedHarness, cursorUtcMs: number, pending: ReturnType<typeof deferred<BacktestRepositoryResult<BacktestSession>>>) {
  h.repository.saveQueue.push(pending.promise);
  await h.setSnapshot({ nowUtcMs: cursorUtcMs });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}

async function begin<T>(operation: () => Promise<T>): Promise<{ pending: Promise<T> }> {
  let pending!: Promise<T>;
  await act(async () => { pending = operation(); await Promise.resolve(); });
  return { pending };
}

async function finish<T>(pending: Promise<T>, completion: () => void) {
  await act(async () => { completion(); await pending; });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Replay session controller decisions', () => {
  it('coalesces checkpoints at one-second cadence with newest progress winning', () => {
    expect(REPLAY_CHECKPOINT_INTERVAL_MS).toBe(1000);
    const old = { cursorUtcMs: T0, displayTimeframe: '1m' as const, speed: 1 as const };
    const newest = captureReplayProgress(snapshot({ nowUtcMs: T0 + 999, timeframe: '15m', speed: 30 }));
    expect(coalesceReplayCheckpoint(old, newest)).toEqual({ cursorUtcMs: T0 + 999, displayTimeframe: '15m', speed: 30 });
  });
  it('requests checkpoints only for changed active same-series durable progress', () => {
    expect(shouldPersistReplayCheckpoint(session(), snapshot({ nowUtcMs: T0 + 1 }), false)).toBe(true);
    expect(shouldPersistReplayCheckpoint(session(), snapshot(), false)).toBe(false);
    expect(shouldPersistReplayCheckpoint({ ...session(), status: 'completed' }, snapshot({ nowUtcMs: T0 + 1 }), false)).toBe(false);
    expect(shouldPersistReplayCheckpoint(session(), snapshot({ canonicalBarrier: 'completion', nowUtcMs: T0 + 1 }), false)).toBe(false);
    expect(shouldPersistReplayCheckpoint(session(), snapshot({ series: { ...session().series, root: 'ES' }, nowUtcMs: T0 + 1 }), false)).toBe(false);
    expect(shouldPersistReplayCheckpoint(session(), snapshot({ nowUtcMs: T0 + 1 }), true)).toBe(false);
  });

  it('resolves unknown action outcomes without inventing a new action', () => {
    const pending = action();
    expect(resolvePendingActionRecovery(session(), pending)).toBe('absent');
    const committed = appendBacktestAction(session(), pending, { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, ISO);
    expect(resolvePendingActionRecovery(committed, pending)).toBe('committed');
    expect(resolvePendingActionRecovery(committed, action(2))).toBe('collision');
  });

  it('constructs stable action identity and sequence from the latest verified session only', () => {
    const open = appendBacktestAction(session(), action(), { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, ISO);
    const fill = { decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000, price: 101.25, basis: 'revealed_1m_close' as const };
    const identity = { actionId: '44444444-4444-4444-8444-444444444444', tradeId: TID, clientCreatedAt: '2026-08-14T12:01:00.000Z' };
    const first = buildCanonicalReplayAction(open, fill, identity, { kind: 'exit' });
    const retry = buildCanonicalReplayAction(open, fill, identity, { kind: 'exit' });
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ sequence: 2, quantity: 1, fill, ...identity });
  });
});

describe('mounted Replay session controller ordering', () => {
  it('creates exactly one owner-scoped session only through the explicit controller command', async () => {
    const generatedSessionId = '77777777-7777-4777-8777-777777777777';
    const loadedSeries: BacktestSession['series'] = { root: 'ES', expiryYear: 2027, expiryMonth: 3, timeframe: '1m' };
    const storage = new MemoryStorage();
    const scope = createUserStorageScope(OWNER_A, storage);
    const repository = createBacktestSessionRepository(scope, { runExclusive: async (_name, task) => task() });
    const runtime = new RuntimeStub(snapshot({ series: loadedSeries, nowUtcMs: T0 + 120_000, timeframe: '15m', speed: 30 }));
    let currentState!: ReplaySessionsState;
    const root: Root = createRoot(installMinimalDom());
    function Probe() { currentState = useReplaySessions(runtime as unknown as ReplayRuntime, runtime.snapshot, { repository }); return null; }
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(generatedSessionId);

    try {
      await act(async () => {
        root.render(React.createElement(TestUserStorageProvider, { scope }, React.createElement(Probe)));
        await Promise.resolve(); await Promise.resolve();
      });
      expect(currentState.hydrated).toBe(true);
      expect(currentState.sessions).toEqual([]);
      expect(storage.values.size).toBe(0);
      expect(storage.writes).toBe(0);
      expect(uuid).not.toHaveBeenCalled();

      await act(async () => { await currentState.createCurrentSession(); });

      const physicalKey = scope.physicalKey(BACKTEST_SESSIONS_STORAGE_KEY);
      expect(uuid).toHaveBeenCalledTimes(1);
      expect(storage.writes).toBe(1);
      expect([...storage.values.keys()]).toEqual([physicalKey]);
      const envelope = JSON.parse(storage.values.get(physicalKey)!);
      expect(envelope).toEqual({
        schemaVersion: 1,
        ownerUserId: OWNER_A,
        sessions: {
          [generatedSessionId]: expect.objectContaining({
            schemaVersion: 1, sessionId: generatedSessionId, series: loadedSeries,
            status: 'active', revision: 1, actions: [],
          }),
        },
      });
      expect(currentState.sessions).toHaveLength(1);
      expect(currentState.sessions[0]).toMatchObject({
        schemaVersion: 1, sessionId: generatedSessionId, series: loadedSeries,
        status: 'active', revision: 1, actions: [],
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2); });
      expect(storage.writes).toBe(1);
      expect(storage.values.get(physicalKey)).toBe(JSON.stringify(envelope));
    } finally {
      uuid.mockRestore();
      await act(async () => root.unmount());
    }
  });

  it('coalesces pending checkpoints and persists only the newest captured progress', async () => {
    const h = await mountController();
    await select(h);
    await h.setSnapshot({ nowUtcMs: T0 + 30_000, timeframe: '5m', speed: 5 });
    await h.setSnapshot({ nowUtcMs: T0 + 60_000, timeframe: '15m', speed: 30 });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS); });
    expect(h.repository.saveCalls).toHaveLength(1);
    expect(h.repository.saveCalls[0].progress).toEqual({ cursorUtcMs: T0 + 60_000, displayTimeframe: '15m', speed: 30 });
    await h.unmount();
  });

  it('orders a pending checkpoint before Entry and uses click-time progress', async () => {
    const h = await mountController();
    await select(h);
    await h.setSnapshot({ nowUtcMs: T0 + 60_000 });
    await act(async () => { await h.state().enter('long', 2, 99.75); });
    expect(h.repository.saveCalls).toHaveLength(0);
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.repository.appendCalls[0]).toMatchObject({ expectedRevision: 1, progress: { cursorUtcMs: T0 + 60_000 } });
    expect(h.runtime.executionCaptures).toBe(1);
    expect(h.runtime.releases).toBeGreaterThan(0);
    await h.unmount();
  });

  it('captures Entry context before an in-flight checkpoint wait and adopts its canonical revision', async () => {
    const h = await mountController();
    await select(h);
    const save = deferred<BacktestRepositoryResult<BacktestSession>>();
    await h.setSnapshot({ timeframe: '5m', speed: 2 });
    await startCheckpoint(h, T0 + 60_000, save);
    h.runtime.fillPrice = 123.75;
    await h.setSnapshot({ nowUtcMs: T0 + 120_000, timeframe: '15m', speed: 30 });
    const { pending: command } = await begin(() => submitReplayEntryIntent(h.state(), 'long', 1, 99.75));
    expect(h.repository.appendCalls).toHaveLength(0);
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(1);
    h.runtime.snapshot = { ...h.runtime.snapshot, nowUtcMs: T0 + 180_000, timeframe: '1h', speed: 60 };
    h.runtime.fillPrice = 999.25;
    const checkpoint = { ...session(), cursorUtcMs: T0 + 60_000, displayTimeframe: '5m' as const,
      speed: 2 as const, revision: 2, updatedAt: '2026-08-14T12:01:00.000Z' };
    h.repository.replace(checkpoint);
    await finish(command, () => save.resolve({ ok: true, value: checkpoint }));
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(1);
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.repository.appendCalls[0]).toMatchObject({
      expectedRevision: 2,
      progress: { cursorUtcMs: T0 + 120_000, displayTimeframe: '15m', speed: 30 },
      action: { fill: {
        decisionUtcMs: T0 + 120_000, sourceBarStartUtcMs: T0 + 60_000,
        sourceBarCloseUtcMs: T0 + 120_000, price: 123.75, basis: 'revealed_1m_close',
      } },
    });
    expect(h.state().activeSession?.revision).toBe(3);
    await h.unmount();
  });

  it('orders an in-flight checkpoint before Exit', async () => {
    const initial = openSession();
    const h = await mountController([initial]);
    await select(h);
    const save = deferred<BacktestRepositoryResult<BacktestSession>>();
    await h.setSnapshot({ timeframe: '5m', speed: 2 });
    await startCheckpoint(h, T0 + 60_000, save);
    h.runtime.fillPrice = 97.25;
    await h.setSnapshot({ nowUtcMs: T0 + 120_000, timeframe: '15m', speed: 30 });
    const { pending: command } = await begin(() => h.state().exit());
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(1);
    const checkpoint = { ...initial, cursorUtcMs: T0 + 60_000, displayTimeframe: '5m' as const,
      speed: 2 as const, revision: 3, updatedAt: '2026-08-14T12:01:00.000Z' };
    h.repository.replace(checkpoint);
    await finish(command, () => save.resolve({ ok: true, value: checkpoint }));
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(1);
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.repository.appendCalls[0]).toMatchObject({
      expectedRevision: 3,
      progress: { cursorUtcMs: T0 + 120_000, displayTimeframe: '15m', speed: 30 },
      action: { kind: 'exit', sequence: 2, fill: {
        decisionUtcMs: T0 + 120_000, sourceBarStartUtcMs: T0 + 60_000,
        sourceBarCloseUtcMs: T0 + 120_000, price: 97.25, basis: 'revealed_1m_close',
      } },
    });
    await h.unmount();
  });

  it('orders pending and in-flight checkpoints before Complete', async () => {
    const pendingHarness = await mountController();
    await select(pendingHarness);
    await pendingHarness.setSnapshot({ nowUtcMs: T0 + 60_000 });
    await act(async () => { await pendingHarness.state().complete(); });
    expect(pendingHarness.repository.saveCalls).toHaveLength(0);
    expect(pendingHarness.repository.completeCalls[0]).toMatchObject({ expectedRevision: 1, progress: { cursorUtcMs: T0 + 60_000 } });
    await pendingHarness.unmount();

    const h = await mountController();
    await select(h);
    const save = deferred<BacktestRepositoryResult<BacktestSession>>();
    await h.setSnapshot({ timeframe: '5m', speed: 2 });
    await startCheckpoint(h, T0 + 60_000, save);
    await h.setSnapshot({ nowUtcMs: T0 + 180_000, timeframe: '1h', speed: 60 });
    const { pending: command } = await begin(() => h.state().complete());
    expect(h.runtime.beginCompletionCommand).toHaveBeenCalledTimes(1);
    const checkpoint = { ...session(), cursorUtcMs: T0 + 60_000, displayTimeframe: '5m' as const,
      speed: 2 as const, revision: 2, updatedAt: '2026-08-14T12:01:00.000Z' };
    h.repository.replace(checkpoint);
    await finish(command, () => save.resolve({ ok: true, value: checkpoint }));
    expect(h.runtime.beginCompletionCommand).toHaveBeenCalledTimes(1);
    expect(h.repository.completeCalls).toHaveLength(1);
    expect(h.repository.completeCalls[0]).toMatchObject({ expectedRevision: 2,
      progress: { cursorUtcMs: T0 + 180_000, displayTimeframe: '1h', speed: 60 } });
    await h.unmount();
  });

  it('admits only one of rapid Entry/Entry and Entry/Complete commands', async () => {
    const h = await mountController();
    await select(h);
    const append = deferred<BacktestRepositoryResult<BacktestSession>>();
    h.repository.appendQueue.push(append.promise);
    const { pending: first } = await begin(() => h.state().enter('long', 1, 99.75));
    await act(async () => { await h.state().enter('long', 1, 99.75); await h.state().complete(); });
    expect(h.runtime.executionCaptures).toBe(1);
    expect(h.runtime.completionCaptures).toBe(0);
    expect(h.repository.appendCalls).toHaveLength(1);
    const committed = appendBacktestAction(session(), h.repository.appendCalls[0].action, h.repository.appendCalls[0].progress, ISO);
    h.repository.replace(committed);
    await finish(first, () => append.resolve({ ok: true, value: committed }));
    await h.unmount();
  });

  it('keeps a verified checkpoint in the collection while selection waits for it', async () => {
    const h = await mountController([session(), sessionB()]);
    await select(h);
    const save = deferred<BacktestRepositoryResult<BacktestSession>>();
    await startCheckpoint(h, T0 + 60_000, save);
    const { pending: selection } = await begin(() => h.state().selectSession(SID_B));
    const checkpoint = { ...session(), cursorUtcMs: T0 + 60_000, revision: 2, updatedAt: '2026-08-14T12:03:00.000Z' };
    h.repository.replace(checkpoint);
    await finish(selection, () => save.resolve({ ok: true, value: checkpoint }));
    expect(h.state().sessions.find((item) => item.sessionId === SID)?.revision).toBe(2);
    expect(h.state().activeSession?.sessionId).toBe(SID_B);
    await h.unmount();
  });

  it('keeps a verified checkpoint after Leave without resurrecting the active session', async () => {
    const h = await mountController();
    await select(h);
    const save = deferred<BacktestRepositoryResult<BacktestSession>>();
    await startCheckpoint(h, T0 + 60_000, save);
    const { pending: leaving } = await begin(() => h.state().leaveSession());
    const checkpoint = { ...session(), cursorUtcMs: T0 + 60_000, revision: 2, updatedAt: '2026-08-14T12:03:00.000Z' };
    h.repository.replace(checkpoint);
    await finish(leaving, () => save.resolve({ ok: true, value: checkpoint }));
    expect(h.state().sessions[0].revision).toBe(2);
    expect(h.state().activeSession).toBeNull();
    expect(h.runtime.locks[h.runtime.locks.length - 1]).toBeNull();
    await h.unmount();
  });

  it('gives the latest selection monotonic authority regardless of resume order', async () => {
    for (const order of ['first-last', 'last-first'] as const) {
      const h = await mountController([session(), sessionB()]);
      const firstResume = deferred<boolean>(); const lastResume = deferred<boolean>();
      h.runtime.resumeQueue.push(firstResume.promise, lastResume.promise);
      const { pending: first } = await begin(() => h.state().selectSession(SID));
      const { pending: last } = await begin(() => h.state().selectSession(SID_B));
      if (order === 'first-last') {
        await finish(first, () => firstResume.resolve(true));
        await finish(last, () => lastResume.resolve(true));
      } else {
        await finish(last, () => lastResume.resolve(true));
        await finish(first, () => firstResume.resolve(true));
      }
      expect(h.state().activeSession?.sessionId).toBe(SID_B);
      expect(h.runtime.snapshot.series).toEqual(sessionB().series);
      expect(h.runtime.locks[h.runtime.locks.length - 1]).toEqual(sessionB().series);
      await h.unmount();
    }
  });

  it('invalidates a pending selection on Leave and owner switch', async () => {
    const h = await mountController([session(), sessionB()]);
    const resume = deferred<boolean>(); h.runtime.resumeQueue.push(resume.promise);
    const { pending: selection } = await begin(() => h.state().selectSession(SID));
    await act(async () => { await h.state().leaveSession(); });
    await finish(selection, () => resume.resolve(true));
    expect(h.state().activeSession).toBeNull();

    const oldResume = deferred<boolean>(); h.runtime.resumeQueue.push(oldResume.promise);
    const { pending: oldSelection } = await begin(() => h.state().selectSession(SID_B));
    const nextRepository = new RepositoryStub([sessionB()]);
    await h.render(OWNER_B, nextRepository);
    await finish(oldSelection, () => oldResume.resolve(true));
    expect(h.state().sessions.map((item) => item.sessionId)).toEqual([SID_B]);
    expect(h.state().activeSession).toBeNull();
    expect(h.runtime.locks[h.runtime.locks.length - 1]).toBeNull();
    await h.unmount();
  });
});

describe('mounted Replay session controller safety and recovery', () => {
  it('rejects invalid captured-fill stops without persistence or a safety block, then remains usable', async () => {
    const h = await mountController();
    await select(h);
    for (const [side, stop] of [['long', 99.9], ['long', 101], ['short', 99]] as const) {
      const releases = h.runtime.releases;
      await act(async () => { await h.state().enter(side, 1, stop); });
      expect(h.repository.appendCalls).toHaveLength(0);
      expect(h.runtime.releases).toBe(releases + 1);
      expect(h.runtime.snapshot.canonicalBarrier).toBeNull();
      expect(h.runtime.pause).toHaveBeenCalled();
      expect(h.state()).toMatchObject({ pending: false, safetyBlocked: false });
      expect(h.state().error).toContain('tick-aligned');
    }
    await act(async () => { await h.state().enter('long', 1, 99.75); });
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.state().safetyBlocked).toBe(false);
    await h.unmount();
  });

  it('does not start checkpoints under action or completion barriers', async () => {
    for (const barrier of ['action', 'completion'] as const) {
      const h = await mountController();
      await select(h);
      await h.setSnapshot({ nowUtcMs: T0 + 60_000, canonicalBarrier: barrier });
      await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2); });
      expect(h.repository.saveCalls).toHaveLength(0);
      await h.unmount();
    }
  });

  it('abandons a captured Entry when the older in-flight checkpoint fails', async () => {
    const h = await mountController();
    await select(h);
    const checkpoint = deferred<BacktestRepositoryResult<BacktestSession>>();
    await h.setSnapshot({ timeframe: '5m', speed: 2 });
    await startCheckpoint(h, T0 + 60_000, checkpoint);
    h.runtime.fillPrice = 123.75;
    await h.setSnapshot({ nowUtcMs: T0 + 120_000, timeframe: '15m', speed: 30 });
    const { pending: entry } = await begin(() => submitReplayEntryIntent(h.state(), 'long', 4, 99.75));
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(1);
    expect(h.repository.appendCalls).toHaveLength(0);
    expect(h.runtime.snapshot).toMatchObject({ canonicalBarrier: 'action', playState: 'paused' });

    await finish(entry, () => checkpoint.resolve({ ok: false, code: 'write_failed', message: 'injected checkpoint failure' }));

    expect(h.repository.saveCalls).toHaveLength(1);
    expect(h.repository.saveCalls[0]).toMatchObject({
      expectedRevision: 1,
      progress: { cursorUtcMs: T0 + 60_000, displayTimeframe: '5m', speed: 2 },
    });
    expect(h.repository.appendCalls).toHaveLength(0);
    expect(h.repository.sessions).toEqual([session()]);
    expect(h.state().activeSession).toEqual(session());
    expect(h.state()).toMatchObject({ pending: false, safetyBlocked: true });
    expect(h.state().error).toContain('could not be written');
    expect(h.runtime.snapshot).toMatchObject({ canonicalBarrier: 'action', playState: 'paused' });

    h.runtime.fillPrice = 999.25;
    await h.setSnapshot({ nowUtcMs: T0 + 180_000, timeframe: '1h', speed: 60 });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 3); });
    expect(h.repository.saveCalls).toHaveLength(1);
    expect(h.repository.appendCalls).toHaveLength(0);
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(1);

    await act(async () => { await h.state().recover(); });
    expect(h.state()).toMatchObject({ safetyBlocked: false, error: null });
    expect(h.runtime.snapshot.canonicalBarrier).toBeNull();
    await act(async () => { await submitReplayEntryIntent(h.state(), 'long', 4, 99.75); });
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.repository.appendCalls[0]).toMatchObject({
      expectedRevision: 1,
      progress: { cursorUtcMs: T0 + 180_000, displayTimeframe: '1h', speed: 60 },
      action: { quantity: 4, fill: {
        decisionUtcMs: T0 + 180_000, sourceBarStartUtcMs: T0 + 120_000,
        sourceBarCloseUtcMs: T0 + 180_000, price: 999.25, basis: 'revealed_1m_close',
      } },
    });
    expect(h.runtime.beginExecutionCommand).toHaveBeenCalledTimes(2);
    await h.unmount();
  });

  it('retains an unknown action barrier, never auto-retries, and recovers identical or absent outcomes', async () => {
    for (const hydration of ['identical', 'absent'] as const) {
      const h = await mountController();
      await select(h);
      h.repository.appendQueue.push(Promise.resolve({ ok: false, code: 'outcome_unknown', message: 'unknown' }));
      await act(async () => { await h.state().enter('long', 1, 99.75); });
      expect(h.repository.appendCalls).toHaveLength(1);
      expect(h.runtime.snapshot.canonicalBarrier).toBe('action');
      expect(h.state().safetyBlocked).toBe(true);
      await h.setSnapshot({ nowUtcMs: T0 + 60_000 });
      await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2); });
      expect(h.repository.appendCalls).toHaveLength(1);
      const submitted = h.repository.appendCalls[0];
      h.repository.sessions = hydration === 'identical'
        ? [appendBacktestAction(session(), submitted.action, submitted.progress, ISO)]
        : [session()];
      await act(async () => { await h.state().recover(); });
      expect(h.state()).toMatchObject({ safetyBlocked: false, error: null });
      expect(h.runtime.snapshot.canonicalBarrier).toBeNull();
      expect(h.repository.appendCalls).toHaveLength(1);
      await h.unmount();
    }
  });

  it('keeps an unknown action collision safety-blocked', async () => {
    const h = await mountController();
    await select(h);
    h.repository.appendQueue.push(Promise.resolve({ ok: false, code: 'outcome_unknown', message: 'unknown' }));
    await act(async () => { await h.state().enter('long', 1, 99.75); });
    const submitted = h.repository.appendCalls[0];
    const collision = { ...submitted.action, quantity: submitted.action.quantity + 1 };
    h.repository.sessions = [appendBacktestAction(session(), collision, submitted.progress, ISO)];
    await act(async () => { await h.state().recover(); });
    expect(h.state().safetyBlocked).toBe(true);
    expect(h.state().error).toContain('conflicts');
    expect(h.runtime.snapshot.canonicalBarrier).toBe('action');
    await h.unmount();
  });

  it('retains an unknown completion barrier and resolves completed or active hydration without retry', async () => {
    for (const completionObserved of [true, false]) {
      const h = await mountController();
      await select(h);
      h.repository.completeQueue.push(Promise.resolve({ ok: false, code: 'outcome_unknown', message: 'unknown' }));
      await act(async () => { await h.state().complete(); });
      expect(h.repository.completeCalls).toHaveLength(1);
      expect(h.runtime.snapshot.canonicalBarrier).toBe('completion');
      const fresh = completionObserved
        ? { ...session(), status: 'completed' as const, revision: 2, updatedAt: '2026-08-14T12:01:00.000Z' }
        : session();
      h.repository.sessions = [fresh];
      await act(async () => { await h.state().recover(); });
      expect(h.state().activeSession?.status).toBe(fresh.status);
      expect(h.state().safetyBlocked).toBe(false);
      expect(h.runtime.snapshot.canonicalBarrier).toBeNull();
      expect(h.repository.completeCalls).toHaveLength(1);
      await h.unmount();
    }
  });

  it('navigates completed sessions without checkpointing or changing repository state', async () => {
    const completed = { ...session(), status: 'completed' as const };
    const h = await mountController([completed]);
    const before = clone(h.repository.sessions);
    await select(h);
    await h.setSnapshot({ nowUtcMs: T0 + 60_000, timeframe: '5m', speed: 5 });
    await act(async () => { await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2); });
    expect(h.repository.saveCalls).toHaveLength(0);
    expect(h.repository.sessions).toEqual(before);
    expect(h.state().activeSession?.revision).toBe(completed.revision);
    await h.unmount();
  });
});

describe('mounted controller with production ReplayRuntime barriers', () => {
  it('preserves exact durable session bytes while historical data is unavailable and usable again', async () => {
    const storage = new MemoryStorage();
    const scope = createUserStorageScope(OWNER_A, storage);
    const repository = createBacktestSessionRepository(scope, { runExclusive: async (_name, task) => task() });
    const created = await repository.createSession(session());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const physicalKey = scope.physicalKey(BACKTEST_SESSIONS_STORAGE_KEY);
    const rawBefore = storage.values.get(physicalKey);
    const writesBefore = storage.writes;
    let available = false;
    const reader: HistoricalBarReader = {
      getLocalAvailability: vi.fn(async () => available ? productionAvailability : { available: false as const }),
      readBars: vi.fn(async () => available
        ? productionRead(productionBars)
        : { ok: false as const, reason: 'series_unavailable' as const }),
    };
    const h = await mountProductionController(created.value, repository, scope, reader);

    try {
      expect(h.runtime.getSnapshot()).toMatchObject({
        availability: { available: false }, playState: 'paused', error: 'This historical series is unavailable.',
      });
      expect(h.state().sessions).toEqual([created.value]);
      expect(h.state().activeSession).toBeNull();
      await h.select();
      expect(h.state().activeSession).toBeNull();
      expect(storage.writes).toBe(writesBefore);
      expect(storage.values.get(physicalKey)).toBe(rawBefore);
      expect(await repository.listSessions()).toEqual({ ok: true, value: [created.value] });

      available = true;
      await h.select();
      expect(h.runtime.getSnapshot()).toMatchObject({ error: null, availability: productionAvailability });
      expect(h.state().activeSession).toEqual(created.value);
      expect(h.state().projection).toMatchObject({ openPosition: null, closedTrades: [] });
      expect(storage.writes).toBe(writesBefore);
      expect(storage.values.get(physicalKey)).toBe(rawBefore);
      expect(await repository.listSessions()).toEqual({ ok: true, value: [created.value] });
    } finally {
      await h.unmount();
    }
  });

  it('fails closed on a definite quota error without adopting speculative action state', async () => {
    const initial = session();
    const h = await mountProductionController(initial);
    try {
      await h.select();
      h.repository.appendQueue.push(Promise.resolve({
        ok: false, code: 'quota_exceeded', message: 'injected quota failure',
      }));
      await act(async () => { await h.state().enter('long', 2, 123.5); });

      expect(h.repository.appendCalls).toHaveLength(1);
      expect(h.repository.sessions).toEqual([initial]);
      expect(h.state().sessions).toEqual([initial]);
      expect(h.state().activeSession).toEqual(initial);
      expect(h.state()).toMatchObject({ pending: false, safetyBlocked: true });
      expect(h.state().error).toContain('Local storage is full');
      expect(h.runtime.getSnapshot()).toMatchObject({ playState: 'paused', canonicalBarrier: 'action' });

      const failedCursor = h.runtime.getSnapshot().nowUtcMs;
      await act(async () => {
        h.runtime.play();
        await h.runtime.goTo(T0 + 60_000);
        await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 3);
        await h.state().enter('short', 1, 125);
        await h.state().complete();
      });
      expect(h.runtime.getSnapshot()).toMatchObject({ nowUtcMs: failedCursor, playState: 'paused', canonicalBarrier: 'action' });
      expect(h.repository.appendCalls).toHaveLength(1);
      expect(h.repository.saveCalls).toHaveLength(0);
      expect(h.repository.completeCalls).toHaveLength(0);
      expect(h.state().activeSession).toEqual(initial);

      const hydrationCalls = h.repository.listCalls;
      await act(async () => { await h.state().recover(); });
      expect(h.repository.listCalls).toBe(hydrationCalls + 1);
      expect(h.state()).toMatchObject({ safetyBlocked: false, error: null, activeSession: initial });
      expect(h.runtime.getSnapshot()).toMatchObject({ playState: 'paused', canonicalBarrier: null });
    } finally {
      await h.unmount();
    }
  });

  it('keeps the last verified session authoritative after a background checkpoint failure', async () => {
    const initial = session();
    const h = await mountProductionController(initial);
    try {
      await h.select();
      h.repository.saveQueue.push(Promise.resolve({
        ok: false, code: 'write_failed', message: 'injected checkpoint failure',
      }));
      await act(async () => {
        h.runtime.setTimeframe('15m');
        h.runtime.setSpeed(30);
        await h.runtime.goTo(T0 + 30_000);
        h.runtime.play();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS);
        await Promise.resolve(); await Promise.resolve();
      });

      expect(h.repository.saveCalls).toHaveLength(1);
      expect(h.repository.saveCalls[0]).toMatchObject({
        expectedRevision: 1,
        progress: { cursorUtcMs: T0 + 30_000, displayTimeframe: '15m', speed: 30 },
      });
      expect(h.repository.sessions).toEqual([initial]);
      expect(h.state().sessions).toEqual([initial]);
      expect(h.state().activeSession).toEqual(initial);
      expect(h.state()).toMatchObject({ safetyBlocked: true });
      expect(h.state().error).toContain('could not be written');
      expect(h.runtime.getSnapshot().playState).toBe('paused');

      const blockedSnapshot = h.runtime.getSnapshot();
      await act(async () => {
        h.runtime.setTimeframe('1h');
        h.runtime.setSpeed(60);
        h.runtime.play();
        await h.runtime.goTo(T0 + 60_000);
        await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 3);
        await h.state().enter('long', 1, 123.5);
        await h.state().exit();
        await h.state().complete();
      });
      expect(h.runtime.getSnapshot()).toMatchObject({
        nowUtcMs: blockedSnapshot.nowUtcMs, timeframe: blockedSnapshot.timeframe,
        speed: blockedSnapshot.speed, playState: 'paused',
      });
      expect(h.repository.saveCalls).toHaveLength(1);
      expect(h.repository.appendCalls).toHaveLength(0);
      expect(h.repository.completeCalls).toHaveLength(0);
      expect(h.state().activeSession).toEqual(initial);

      await act(async () => { await h.state().recover(); });
      expect(h.state()).toMatchObject({ safetyBlocked: false, error: null, activeSession: initial });
      expect(h.runtime.getSnapshot().playState).toBe('paused');
    } finally {
      await h.unmount();
    }
  });

  it('rejects Entry, Exit, and Complete through the mounted controller and runtime while rewound', async () => {
    const storage = new MemoryStorage();
    const scope = createUserStorageScope(OWNER_A, storage);
    const repository = createBacktestSessionRepository(scope, { runExclusive: async (_name, task) => task() });
    const created = session();
    expect((await repository.createSession(created)).ok).toBe(true);
    const entered = await repository.appendAction(SID, 1, action(),
      { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, ISO);
    expect(entered.ok).toBe(true);
    const exitAction: BacktestAction = {
      actionVersion: 1, actionId: '66666666-6666-4666-8666-666666666666', tradeId: TID,
      sessionId: SID, sequence: 2, kind: 'exit', quantity: 1,
      fill: {
        decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0,
        sourceBarCloseUtcMs: T0 + 60_000, price: 124.75, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T12:01:00.000Z',
    };
    const exited = await repository.appendAction(SID, 2, exitAction,
      { cursorUtcMs: T0 + 60_000, displayTimeframe: '1m', speed: 1 }, '2026-08-14T12:01:00.000Z');
    expect(exited.ok).toBe(true);
    if (!exited.ok) return;

    const h = await mountProductionController(exited.value, repository, scope);
    try {
      await h.select();
      await act(async () => { await h.runtime.goTo(T0); });
      expect(h.state().projection?.rewound).toBe(true);
      const physicalKey = scope.physicalKey(BACKTEST_SESSIONS_STORAGE_KEY);
      const rawBefore = storage.values.get(physicalKey);
      const writesBefore = storage.writes;
      const persistedBefore = await repository.listSessions();
      expect(persistedBefore.ok).toBe(true);
      const cursorBefore = h.runtime.getSnapshot().nowUtcMs;
      const executionCapture = vi.spyOn(h.runtime, 'beginExecutionCommand');
      const completionCapture = vi.spyOn(h.runtime, 'beginCompletionCommand');

      await act(async () => {
        await h.state().enter('long', 3, 123.75);
        await h.state().exit();
        await h.state().complete();
      });

      expect(executionCapture).not.toHaveBeenCalled();
      expect(completionCapture).not.toHaveBeenCalled();
      expect(h.runtime.getSnapshot().nowUtcMs).toBe(cursorBefore);
      expect(h.repository).toBe(repository);
      expect(storage.writes).toBe(writesBefore);
      expect(storage.values.get(physicalKey)).toBe(rawBefore);
      expect(await repository.listSessions()).toEqual(persistedBefore);
      expect(h.state().activeSession).toMatchObject({ revision: 3, status: 'active' });
      expect(h.state().activeSession?.actions).toEqual([action(), exitAction]);
      expect(h.runtime.beginExecutionCommand(created.series)).toEqual({ ok: false, reason: 'not_ready' });
      expect(h.runtime.beginCompletionCommand(created.series)).toEqual({ ok: false, reason: 'not_ready' });
      expect(storage.writes).toBe(writesBefore);

      await act(async () => { await h.runtime.goTo(T0 + 60_000); });
      expect(h.state().projection?.rewound).toBe(false);
      const eligibleExecution = h.runtime.beginExecutionCommand(created.series);
      expect(eligibleExecution.ok).toBe(true);
      h.runtime.releaseCanonicalCommand();
      const eligibleCompletion = h.runtime.beginCompletionCommand(created.series);
      expect(eligibleCompletion.ok).toBe(true);
      h.runtime.releaseCanonicalCommand();
      expect(h.runtime.getSnapshot()).toMatchObject({ nowUtcMs: T0 + 60_000, canonicalBarrier: null });
    } finally {
      await h.unmount();
    }
  });

  it('holds the Entry barrier across runtime commands and checkpoint time, then releases after verified success', async () => {
    const h = await mountProductionController(session());
    await h.select();
    await act(async () => { await h.runtime.goTo(T0 + 30_000); });
    const append = deferred<BacktestRepositoryResult<BacktestSession>>();
    h.repository.appendQueue.push(append.promise);
    const capture = vi.spyOn(h.runtime, 'beginExecutionCommand');
    const completeCapture = vi.spyOn(h.runtime, 'beginCompletionCommand');
    const { pending } = await begin(() => h.state().enter('long', 2, 99.75));
    const captured = h.runtime.getSnapshot();
    expect(captured).toMatchObject({ nowUtcMs: T0 + 30_000, playState: 'paused', canonicalBarrier: 'action' });
    expect(h.repository.appendCalls).toHaveLength(1);

    const alternate: HistoricalSeriesIdentity = { ...session().series, root: 'ES' };
    const importMutation = vi.fn(async () => ({ ok: true as const }));
    await act(async () => {
      h.runtime.play();
      await h.runtime.stepForward();
      await h.runtime.goTo(T0 + 120_000);
      h.runtime.selectSeries(alternate);
      expect(await h.runtime.resumeSession(alternate, T0 + 120_000)).toBe(false);
      expect(await h.runtime.runImport(session().series, importMutation)).toMatchObject({ ok: false, reason: 'command_pending' });
      expect(h.runtime.beginExecutionCommand(session().series)).toEqual({ ok: false, reason: 'command_pending' });
      await h.state().complete();
      await h.state().enter('short', 1, 130);
      await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2);
    });
    expect(h.runtime.getSnapshot()).toMatchObject({
      nowUtcMs: captured.nowUtcMs, series: captured.series, playState: 'paused', canonicalBarrier: 'action',
    });
    expect(importMutation).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(completeCapture).not.toHaveBeenCalled();
    expect(h.repository).toMatchObject({ saveCalls: [], completeCalls: [] });
    expect(h.repository.appendCalls).toHaveLength(1);

    const submitted = h.repository.appendCalls[0];
    const committed = appendBacktestAction(session(), submitted.action, submitted.progress, '2026-08-14T12:00:30.000Z');
    h.repository.replace(committed);
    await finish(pending, () => append.resolve({ ok: true, value: committed }));
    expect(h.state().activeSession?.revision).toBe(committed.revision);
    expect(h.runtime.getSnapshot()).toMatchObject({ canonicalBarrier: null, playState: 'paused' });
    await act(async () => { await h.runtime.goTo(T0 + 60_000); });
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 60_000);
    await h.unmount();
  });

  it('holds the Exit barrier against movement, replacement, and another canonical command, then settles paused', async () => {
    const initial = openSession();
    const h = await mountProductionController(initial);
    await h.select();
    await act(async () => { await h.runtime.goTo(T0 + 30_000); });
    const append = deferred<BacktestRepositoryResult<BacktestSession>>();
    h.repository.appendQueue.push(append.promise);
    const capture = vi.spyOn(h.runtime, 'beginExecutionCommand');
    const { pending } = await begin(() => h.state().exit());
    const captured = h.runtime.getSnapshot();
    const importMutation = vi.fn(async () => ({ ok: true as const }));
    await act(async () => {
      h.runtime.play();
      await h.runtime.stepForward();
      await h.runtime.goTo(T0 + 120_000);
      h.runtime.selectSeries({ ...initial.series, root: 'ES' });
      await h.runtime.runImport(initial.series, importMutation);
      expect(h.runtime.beginExecutionCommand(initial.series)).toEqual({ ok: false, reason: 'command_pending' });
      await h.state().complete();
      await h.state().exit();
    });
    expect(h.runtime.getSnapshot()).toMatchObject({
      nowUtcMs: captured.nowUtcMs, series: captured.series, playState: 'paused', canonicalBarrier: 'action',
    });
    expect(importMutation).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.repository.completeCalls).toHaveLength(0);

    const submitted = h.repository.appendCalls[0];
    const committed = appendBacktestAction(initial, submitted.action, submitted.progress, '2026-08-14T12:00:30.000Z');
    h.repository.replace(committed);
    await finish(pending, () => append.resolve({ ok: true, value: committed }));
    expect(h.runtime.getSnapshot()).toMatchObject({ canonicalBarrier: null, playState: 'paused' });
    h.runtime.play();
    expect(h.runtime.getSnapshot().playState).toBe('playing');
    h.runtime.pause();
    await h.unmount();
  });

  it('holds the Complete barrier across all controller/runtime commands and suppresses checkpoint start', async () => {
    const initial = session();
    const h = await mountProductionController(initial);
    await h.select();
    await act(async () => { await h.runtime.goTo(T0 + 30_000); });
    const completion = deferred<BacktestRepositoryResult<BacktestSession>>();
    h.repository.completeQueue.push(completion.promise);
    const executionCapture = vi.spyOn(h.runtime, 'beginExecutionCommand');
    const completionCapture = vi.spyOn(h.runtime, 'beginCompletionCommand');
    const { pending } = await begin(() => h.state().complete());
    const captured = h.runtime.getSnapshot();
    const importMutation = vi.fn(async () => ({ ok: true as const }));
    await act(async () => {
      h.runtime.play();
      await h.runtime.stepForward();
      await h.runtime.goTo(T0 + 120_000);
      h.runtime.selectSeries({ ...initial.series, root: 'ES' });
      await h.runtime.runImport(initial.series, importMutation);
      expect(h.runtime.beginExecutionCommand(initial.series)).toEqual({ ok: false, reason: 'command_pending' });
      await h.state().enter('long', 1, 99.75);
      await h.state().exit();
      await h.state().complete();
      await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2);
    });
    expect(h.runtime.getSnapshot()).toMatchObject({
      nowUtcMs: captured.nowUtcMs, series: captured.series, playState: 'paused', canonicalBarrier: 'completion',
    });
    expect(importMutation).not.toHaveBeenCalled();
    expect(executionCapture).toHaveBeenCalledTimes(1);
    expect(completionCapture).toHaveBeenCalledTimes(1);
    expect(h.repository.saveCalls).toHaveLength(0);
    expect(h.repository.appendCalls).toHaveLength(0);
    expect(h.repository.completeCalls).toHaveLength(1);

    const committed: BacktestSession = { ...initial, ...h.repository.completeCalls[0].progress,
      status: 'completed', revision: 2, updatedAt: '2026-08-14T12:00:30.000Z' };
    h.repository.replace(committed);
    await finish(pending, () => completion.resolve({ ok: true, value: committed }));
    expect(h.state().activeSession?.status).toBe('completed');
    expect(h.runtime.getSnapshot()).toMatchObject({ canonicalBarrier: null, playState: 'paused' });
    await act(async () => { await h.runtime.goTo(T0 + 60_000); });
    expect(h.runtime.getSnapshot().nowUtcMs).toBe(T0 + 60_000);
    await h.unmount();
  });

  it('retains the production runtime safety block after outcome_unknown until explicit recovery', async () => {
    const h = await mountProductionController(session());
    await h.select();
    const append = deferred<BacktestRepositoryResult<BacktestSession>>();
    h.repository.appendQueue.push(append.promise);
    const { pending } = await begin(() => h.state().enter('long', 1, 99.75));
    await finish(pending, () => append.resolve({ ok: false, code: 'outcome_unknown', message: 'unknown' }));
    expect(h.state().safetyBlocked).toBe(true);
    expect(h.runtime.getSnapshot()).toMatchObject({ canonicalBarrier: 'action', playState: 'paused' });
    await act(async () => {
      h.runtime.play(); await h.runtime.goTo(T0 + 60_000);
      await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2);
    });
    expect(h.runtime.getSnapshot()).toMatchObject({ nowUtcMs: T0, playState: 'paused', canonicalBarrier: 'action' });
    expect(h.repository.appendCalls).toHaveLength(1);
    expect(h.repository.saveCalls).toHaveLength(0);
    const hydrationCalls = h.repository.listCalls;
    await act(async () => { await h.state().recover(); });
    expect(h.repository.listCalls).toBe(hydrationCalls + 1);
    expect(h.state().safetyBlocked).toBe(false);
    expect(h.runtime.getSnapshot().canonicalBarrier).toBeNull();
    await h.unmount();
  });

  it('rejects completed-session controller commands and restores the immutable completion snapshot after view-only navigation', async () => {
    const completed: BacktestSession = { ...session(), status: 'completed', revision: 7,
      updatedAt: '2026-08-14T12:07:00.000Z', cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 };
    const h = await mountProductionController(completed);
    await h.select();
    const before = clone(h.repository.sessions);
    const executionCapture = vi.spyOn(h.runtime, 'beginExecutionCommand');
    const completionCapture = vi.spyOn(h.runtime, 'beginCompletionCommand');
    await act(async () => {
      await h.state().enter('long', 1, 99.75);
      await h.state().exit();
      await h.state().complete();
    });
    expect(executionCapture).not.toHaveBeenCalled();
    expect(completionCapture).not.toHaveBeenCalled();
    expect(h.repository).toMatchObject({ saveCalls: [], appendCalls: [], completeCalls: [] });

    await act(async () => {
      h.runtime.setTimeframe('15m'); h.runtime.setSpeed(30); h.runtime.play();
      await h.runtime.stepForward(); await h.runtime.goTo(T0 + 60_000);
      await vi.advanceTimersByTimeAsync(REPLAY_CHECKPOINT_INTERVAL_MS * 2);
    });
    expect(h.repository).toMatchObject({ saveCalls: [], appendCalls: [], completeCalls: [] });
    expect(h.repository.sessions).toEqual(before);
    expect(h.state().activeSession).toMatchObject({
      revision: 7, updatedAt: completed.updatedAt, cursorUtcMs: T0, displayTimeframe: '1m', speed: 1,
    });

    await h.select();
    expect(h.runtime.getSnapshot()).toMatchObject({
      nowUtcMs: T0, timeframe: '1m', speed: 1, playState: 'paused', canonicalBarrier: null,
    });
    expect(h.repository.sessions).toEqual(before);
    await h.unmount();
  });
});

describe('mounted Replay session controller owner isolation', () => {
  it('suppresses stale hydration and checkpoint publication after an owner switch', async () => {
    const oldRepository = new RepositoryStub([session()]);
    const hydration = deferred<BacktestRepositoryResult<BacktestSession[]>>();
    oldRepository.listQueue.push(hydration.promise);
    const h = await mountController([session()], oldRepository);
    const nextRepository = new RepositoryStub([sessionB()]);
    await h.render(OWNER_B, nextRepository);
    await act(async () => { hydration.resolve({ ok: true, value: [session()] }); await Promise.resolve(); });
    expect(h.state().sessions.map((item) => item.sessionId)).toEqual([SID_B]);

    await select(h, SID_B);
    const checkpoint = deferred<BacktestRepositoryResult<BacktestSession>>();
    await startCheckpoint(h, sessionB().cursorUtcMs + 60_000, checkpoint);
    const thirdRepository = new RepositoryStub([session()]);
    await h.render(OWNER_A, thirdRepository);
    const stale = { ...sessionB(), revision: 2, updatedAt: '2026-08-14T12:04:00.000Z' };
    await act(async () => { checkpoint.resolve({ ok: true, value: stale }); await Promise.resolve(); });
    expect(h.state().sessions.map((item) => item.sessionId)).toEqual([SID]);
    expect(h.state().activeSession).toBeNull();
    await h.unmount();
  });

  it('suppresses stale Entry, Exit, and Complete results after owner switches', async () => {
    for (const kind of ['entry', 'exit', 'complete'] as const) {
      const initial = kind === 'exit' ? openSession() : session();
      const h = await mountController([initial]);
      await select(h);
      const operation = deferred<BacktestRepositoryResult<BacktestSession>>();
      if (kind === 'complete') h.repository.completeQueue.push(operation.promise);
      else h.repository.appendQueue.push(operation.promise);
      const oldRepository = h.repository;
      const { pending } = await begin(() => kind === 'entry'
        ? h.state().enter('long', 1, 99.75)
        : kind === 'exit' ? h.state().exit() : h.state().complete());
      const nextRepository = new RepositoryStub([sessionB()]);
      await h.render(OWNER_B, nextRepository);
      const stale = kind === 'complete'
        ? { ...initial, status: 'completed' as const, revision: initial.revision + 1 }
        : appendBacktestAction(initial, oldRepository.appendCalls[0].action, oldRepository.appendCalls[0].progress, ISO);
      await finish(pending, () => operation.resolve({ ok: true, value: stale }));
      expect(h.state().sessions.map((item) => item.sessionId)).toEqual([SID_B]);
      expect(h.state().activeSession).toBeNull();
      expect(h.runtime.snapshot.canonicalBarrier).toBeNull();
      await h.unmount();
    }
  });

  it('suppresses stale recovery publication after an owner switch', async () => {
    const h = await mountController();
    await select(h);
    h.repository.appendQueue.push(Promise.resolve({ ok: false, code: 'outcome_unknown', message: 'unknown' }));
    await act(async () => { await h.state().enter('long', 1, 99.75); });
    const recovery = deferred<BacktestRepositoryResult<BacktestSession[]>>();
    h.repository.listQueue.push(recovery.promise);
    const { pending } = await begin(() => h.state().recover());
    const nextRepository = new RepositoryStub([sessionB()]);
    await h.render(OWNER_B, nextRepository);
    await finish(pending, () => recovery.resolve({ ok: true, value: [session()] }));
    expect(h.state().sessions.map((item) => item.sessionId)).toEqual([SID_B]);
    expect(h.state().activeSession).toBeNull();
    await h.unmount();
  });
});
