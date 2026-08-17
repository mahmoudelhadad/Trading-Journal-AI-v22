import { describe, expect, it } from 'vitest';
import {
  appendBacktestAction, createBacktestSession, projectBacktestSession,
  validateBacktestAction, validateBacktestSession,
} from '@calculations/backtestSession.js';
import { USER_STORAGE_LOGICAL_KEYS, createUserStorageScope, type RawStorage } from './storageNamespace.js';
import { BACKTEST_SESSIONS_LOCK_NAME, BACKTEST_SESSIONS_STORAGE_KEY, createBacktestSessionRepository } from './backtestSessionRepository.js';
import type { BacktestAction, BacktestEntryAction } from '@apptypes/backtestSession.js';

const OWNER = 'a1234567-89ab-4cde-8fab-0123456789ab';
const OTHER = 'b1234567-89ab-4cde-8fab-0123456789ab';
const SID = '11111111-1111-4111-8111-111111111111';
const AID = '22222222-2222-4222-8222-222222222222';
const TID = '33333333-3333-4333-8333-333333333333';
const T0 = 1_700_000_040_000;
const ISO = '2026-08-14T12:00:00.000Z';
const progress = (cursorUtcMs = T0) => ({ cursorUtcMs, displayTimeframe: '1m' as const, speed: 1 as const });
const makeSession = () => createBacktestSession({ sessionId: SID, series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' }, progress: progress(), createdAt: ISO });
const action = (overrides: Partial<BacktestEntryAction> = {}): BacktestEntryAction => ({
  actionVersion: 1, actionId: AID, tradeId: TID, sessionId: SID, sequence: 1, kind: 'entry', side: 'long', quantity: 1, initialStopPrice: 99,
  fill: { decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0, price: 100, basis: 'revealed_1m_close' }, clientCreatedAt: ISO, ...overrides,
});

class MemoryStorage implements RawStorage {
  values = new Map<string, string>();
  writes = 0;
  failRead = false; failWrite: Error | null = null; dropWrite = false;
  getItem(key: string) { if (this.failRead) throw new Error('read'); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes += 1; if (this.failWrite) throw this.failWrite; if (!this.dropWrite) this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const immediate = async <T>(_name: string, task: () => Promise<T>) => task();
const setup = (owner = OWNER) => {
  const storage = new MemoryStorage();
  const scope = createUserStorageScope(owner, storage);
  return { storage, scope, key: scope.physicalKey(BACKTEST_SESSIONS_STORAGE_KEY), repository: createBacktestSessionRepository(scope, { runExclusive: immediate }) };
};

describe('BacktestSessionRepository', () => {
  it('treats a missing key as empty without eager creation', async () => {
    const h = setup();
    expect(await h.repository.listSessions()).toEqual({ ok: true, value: [] });
    expect(h.storage.values.size).toBe(0);
  });

  it('creates the exact owner-scoped key only on explicit creation and lists it', async () => {
    const h = setup();
    expect((await h.repository.createSession(makeSession())).ok).toBe(true);
    expect([...h.storage.values.keys()]).toEqual([`fxj:user:v1:${OWNER}:${BACKTEST_SESSIONS_STORAGE_KEY}`]);
    const listed = await h.repository.listSessions();
    expect(listed.ok && listed.value[0].sessionId).toBe(SID);
  });

  it('isolates exact captured owners', async () => {
    const storage = new MemoryStorage();
    const a = createBacktestSessionRepository(createUserStorageScope(OWNER, storage), { runExclusive: immediate });
    const b = createBacktestSessionRepository(createUserStorageScope(OTHER, storage), { runExclusive: immediate });
    await a.createSession(makeSession());
    expect(await b.listSessions()).toEqual({ ok: true, value: [] });
  });

  it('changes only B2b bytes across representative session and trading mutations', async () => {
    const storage = new MemoryStorage();
    const scope = createUserStorageScope(OWNER, storage);
    for (const key of USER_STORAGE_LOGICAL_KEYS.filter((key) => key !== BACKTEST_SESSIONS_STORAGE_KEY)) {
      storage.values.set(scope.physicalKey(key), `scoped:${key}:\u0000preserved`);
      storage.values.set(key, `legacy:${key}:\r\npreserved`);
    }
    const protectedBefore = new Map(storage.values);
    const repository = createBacktestSessionRepository(scope, { runExclusive: immediate });

    expect((await repository.createSession(makeSession())).ok).toBe(true);
    expect((await repository.saveProgress(SID, 1, progress(), '2026-08-14T12:00:00.500Z')).ok).toBe(true);
    expect((await repository.appendAction(SID, 2, action(), progress(), '2026-08-14T12:00:01.000Z')).ok).toBe(true);
    const exitAction = {
      actionVersion: 1 as const, actionId: '44444444-4444-4444-8444-444444444444', tradeId: TID,
      sessionId: SID, sequence: 2, kind: 'exit' as const, quantity: 1,
      fill: {
        decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0,
        sourceBarCloseUtcMs: T0 + 60_000, price: 101.25, basis: 'revealed_1m_close' as const,
      },
      clientCreatedAt: '2026-08-14T12:01:00.000Z',
    };
    expect((await repository.appendAction(SID, 3, exitAction,
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z')).ok).toBe(true);
    expect((await repository.completeSession(SID, 4,
      progress(T0 + 60_000), '2026-08-14T12:01:01.000Z')).ok).toBe(true);

    const b2bPhysicalKey = scope.physicalKey(BACKTEST_SESSIONS_STORAGE_KEY);
    expect([...storage.values.keys()].sort()).toEqual([...protectedBefore.keys(), b2bPhysicalKey].sort());
    for (const [key, raw] of protectedBefore) expect(storage.values.get(key)).toBe(raw);
    expect(storage.values.get(b2bPhysicalKey)).toContain(`"sessionId":"${SID}"`);
    expect([...storage.values.keys()].filter((key) => !protectedBefore.has(key))).toEqual([b2bPhysicalKey]);
  });

  it('uses the frozen exclusive lock name and re-reads inside it', async () => {
    const h = setup(); const names: string[] = [];
    const repo = createBacktestSessionRepository(h.scope, { runExclusive: async (name, task) => { names.push(name); return task(); } });
    await repo.createSession(makeSession());
    expect(names).toEqual([BACKTEST_SESSIONS_LOCK_NAME]);
  });

  it('observes a competing committed revision injected at lock acquisition', async () => {
    const h = setup(); await h.repository.createSession(makeSession());
    const repo = createBacktestSessionRepository(h.scope, { runExclusive: async (_name, task) => {
      const envelope = JSON.parse(h.storage.values.get(h.key)!);
      envelope.sessions[SID].revision = 2;
      envelope.sessions[SID].updatedAt = '2026-08-14T12:00:01.000Z';
      h.storage.values.set(h.key, JSON.stringify(envelope));
      return task();
    } });
    expect(await repo.saveProgress(SID, 1, progress(T0 + 2), '2026-08-14T12:00:02.000Z'))
      .toMatchObject({ ok: false, code: 'stale_revision' });
  });

  it('fails closed without Web Locks and writes nothing', async () => {
    const h = setup();
    const repo = createBacktestSessionRepository(h.scope, { runExclusive: async () => { throw new Error('lock_unavailable'); } });
    expect(await repo.createSession(makeSession())).toMatchObject({ ok: false, code: 'lock_unavailable' });
    expect(h.storage.values.size).toBe(0);
  });

  it('increments revision once for verified progress and rejects stale revision', async () => {
    const h = setup(); await h.repository.createSession(makeSession());
    const saved = await h.repository.saveProgress(SID, 1, progress(T0 + 1), '2026-08-14T12:00:01.000Z');
    expect(saved.ok && saved.value.revision).toBe(2);
    expect(await h.repository.saveProgress(SID, 1, progress(T0 + 2), '2026-08-14T12:00:02.000Z')).toMatchObject({ ok: false, code: 'stale_revision' });
  });

  it('resolves identical duplicate action before stale revision with byte-identical no-op', async () => {
    const h = setup(); await h.repository.createSession(makeSession());
    const first = await h.repository.appendAction(SID, 1, action(), progress(), ISO);
    expect(first.ok).toBe(true);
    const before = h.storage.values.get(h.key);
    const duplicate = await h.repository.appendAction(SID, 1, action(), progress(T0 + 999), '2026-08-14T12:01:00.000Z');
    expect(duplicate).toMatchObject({ ok: true, idempotent: true });
    expect(duplicate.ok && duplicate.value.revision).toBe(2);
    expect(duplicate.ok && duplicate.value.updatedAt).toBe(ISO);
    expect(h.storage.values.get(h.key)).toBe(before);
  });

  it('resolves same-ID different canonical content as collision before stale revision', async () => {
    const h = setup();
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, action(), progress(), ISO);
    await h.repository.saveProgress(SID, 2, progress(T0 + 1), '2026-08-14T12:00:01.000Z');
    const beforeRaw = h.storage.values.get(h.key);
    const beforeList = await h.repository.listSessions();
    expect(beforeList.ok).toBe(true);
    if (!beforeList.ok) return;
    const beforeSession = beforeList.value[0];
    const writesBeforeCollision = h.storage.writes;

    expect(await h.repository.appendAction(SID, 2, action({ quantity: 2 }), progress(), ISO))
      .toMatchObject({ ok: false, code: 'id_collision' });

    const afterList = await h.repository.listSessions();
    expect(afterList.ok).toBe(true);
    if (!afterList.ok) return;
    expect(h.storage.writes).toBe(writesBeforeCollision);
    expect(h.storage.values.get(h.key)).toBe(beforeRaw);
    expect(afterList.value[0]).toEqual(beforeSession);
    expect(afterList.value[0]).toMatchObject({ revision: 3, updatedAt: '2026-08-14T12:00:01.000Z' });
    expect(afterList.value[0].actions).toEqual([action()]);
  });

  it('keeps repeated New York wall-clock actions distinct by canonical UTC fill identity', async () => {
    const firstUtcMs = Date.parse('2024-11-03T05:30:00.000Z');
    const secondUtcMs = Date.parse('2024-11-03T06:30:00.000Z');
    const h = setup();
    const initial = createBacktestSession({
      sessionId: SID, series: makeSession().series, progress: progress(firstUtcMs), createdAt: ISO,
    });
    const firstAction = action({ fill: {
      decisionUtcMs: firstUtcMs, sourceBarStartUtcMs: firstUtcMs - 60_000,
      sourceBarCloseUtcMs: firstUtcMs, price: 100, basis: 'revealed_1m_close',
    } });
    const repeatedWallClockAction = action({ fill: {
      decisionUtcMs: secondUtcMs, sourceBarStartUtcMs: secondUtcMs - 60_000,
      sourceBarCloseUtcMs: secondUtcMs, price: 100, basis: 'revealed_1m_close',
    } });
    await h.repository.createSession(initial);
    expect((await h.repository.appendAction(SID, 1, firstAction, progress(firstUtcMs), ISO)).ok).toBe(true);
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;

    expect(await h.repository.appendAction(SID, 1, repeatedWallClockAction, progress(secondUtcMs), ISO))
      .toMatchObject({ ok: false, code: 'id_collision' });
    expect(firstUtcMs).not.toBe(secondUtcMs);
    expect(firstAction.fill.sourceBarStartUtcMs).not.toBe(repeatedWallClockAction.fill.sourceBarStartUtcMs);
    expect(firstAction.fill.sourceBarCloseUtcMs).not.toBe(repeatedWallClockAction.fill.sourceBarCloseUtcMs);
    expect(firstAction.fill.decisionUtcMs).not.toBe(repeatedWallClockAction.fill.decisionUtcMs);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);
  });

  it('rejects an absent action at stale revision without renumbering or writing', async () => {
    const h = setup(); await h.repository.createSession(makeSession());
    await h.repository.saveProgress(SID, 1, progress(T0 + 1), '2026-08-14T12:00:01.000Z');
    const before = h.storage.values.get(h.key);
    expect(await h.repository.appendAction(SID, 1, action(), progress(), ISO)).toMatchObject({ ok: false, code: 'stale_revision' });
    expect(h.storage.values.get(h.key)).toBe(before);
  });

  it('preserves and reports malformed, unknown-schema, and owner-mismatched raw bytes', async () => {
    for (const [raw, code] of [
      ['{broken', 'corrupt'],
      [JSON.stringify({ schemaVersion: 2, ownerUserId: OWNER, sessions: {} }), 'unsupported_schema'],
      [JSON.stringify({ schemaVersion: 1, ownerUserId: OTHER, sessions: {} }), 'owner_mismatch'],
    ] as const) {
      const h = setup(); h.storage.values.set(h.key, raw);
      expect(await h.repository.listSessions()).toMatchObject({ ok: false, code });
      expect(h.storage.values.get(h.key)).toBe(raw);
    }
  });

  it('reports read, write, quota, and read-back verification failures', async () => {
    const read = setup(); read.storage.failRead = true;
    expect(await read.repository.listSessions()).toMatchObject({ ok: false, code: 'read_failed' });
    const write = setup(); write.storage.failWrite = new Error('write');
    expect(await write.repository.createSession(makeSession())).toMatchObject({ ok: false, code: 'write_failed' });
    const quota = setup(); quota.storage.failWrite = new DOMException('full', 'QuotaExceededError');
    expect(await quota.repository.createSession(makeSession())).toMatchObject({ ok: false, code: 'quota_exceeded' });
    const dropped = setup(); dropped.storage.dropWrite = true;
    expect(await dropped.repository.createSession(makeSession())).toMatchObject({ ok: false, code: 'verification_failed' });
  });

  it('reports outcome_unknown when post-write read-back throws', async () => {
    const h = setup(); let reads = 0;
    const scope = { ...h.scope, getRaw: (key: Parameters<typeof h.scope.getRaw>[0]) => { reads += 1; if (reads > 1) throw new Error('verify'); return h.scope.getRaw(key); } };
    const repo = createBacktestSessionRepository(scope, { runExclusive: immediate });
    expect(await repo.createSession(makeSession())).toMatchObject({ ok: false, code: 'outcome_unknown' });
    expect(h.storage.values.has(h.key)).toBe(true);
  });

  it('reloads one exact open Entry identity and refuses completion until flat', async () => {
    const h = setup();
    const persistedEntry = action({
      side: 'short', quantity: 7, initialStopPrice: 101.25,
      fill: {
        decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0,
        price: 100.25, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T11:59:59.123Z',
    });
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, persistedEntry, progress(), ISO);
    const listed = await h.repository.listSessions();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const reloaded = listed.value[0];
    expect(reloaded.actions).toEqual([persistedEntry]);
    expect(reloaded.actions[0]).toEqual({
      actionVersion: 1, actionId: AID, tradeId: TID, sessionId: SID, sequence: 1,
      kind: 'entry', side: 'short', quantity: 7, initialStopPrice: 101.25,
      fill: {
        decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0,
        price: 100.25, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T11:59:59.123Z',
    });
    expect(projectBacktestSession(reloaded).openPosition).toEqual(persistedEntry);
    expect(reloaded).toMatchObject({ status: 'active', revision: 2 });
    expect(await h.repository.completeSession(SID, 2, progress(), ISO)).toMatchObject({ ok: false, code: 'invalid_session' });
    const afterRejectedCompletion = await h.repository.listSessions();
    expect(afterRejectedCompletion.ok).toBe(true);
    if (!afterRejectedCompletion.ok) return;
    expect(afterRejectedCompletion.value[0].actions).toEqual([persistedEntry]);
  });

  it('completes a flat session once and makes it terminal', async () => {
    const h = setup(); await h.repository.createSession(makeSession());
    const completed = await h.repository.completeSession(SID, 1, progress(), '2026-08-14T12:00:01.000Z');
    expect(completed.ok && completed.value).toMatchObject({ status: 'completed', revision: 2 });
    const bytes = h.storage.values.get(h.key);
    const reloaded = await h.repository.listSessions();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value[0]).toEqual(completed.ok ? completed.value : undefined);
    expect(projectBacktestSession(reloaded.value[0]).openPosition).toBeNull();
    expect(await h.repository.saveProgress(SID, 2, progress(T0 + 1), ISO)).toMatchObject({ ok: false, code: 'invalid_session' });
    expect((await h.repository.appendAction(SID, 2, action(), progress(), ISO)).ok).toBe(false);
    expect(await h.repository.completeSession(SID, 2, progress(), ISO)).toMatchObject({ ok: false, code: 'invalid_session' });
    expect(h.storage.values.get(h.key)).toBe(bytes);
    const terminal = await h.repository.listSessions();
    expect(terminal).toEqual(reloaded);
    expect(terminal.ok && terminal.value[0]).toMatchObject({
      status: 'completed', revision: 2, updatedAt: '2026-08-14T12:00:01.000Z', actions: [],
    });
  });

  it('validates the whole envelope, including open-position transition history', async () => {
    const h = setup();
    const invalid = appendBacktestAction(makeSession(), action(), progress(), ISO);
    invalid.actions[0] = { ...invalid.actions[0], sequence: 2 } as BacktestEntryAction;
    h.storage.values.set(h.key, JSON.stringify({ schemaVersion: 1, ownerUserId: OWNER, sessions: { [SID]: invalid } }));
    expect(await h.repository.listSessions()).toMatchObject({ ok: false, code: 'corrupt' });
  });

  it('rejects an unknown envelope property as corrupt without changing raw bytes', async () => {
    const h = setup();
    const raw = JSON.stringify({ schemaVersion: 1, ownerUserId: OWNER, sessions: {}, unknown: true });
    h.storage.values.set(h.key, raw);
    expect(await h.repository.listSessions()).toMatchObject({ ok: false, code: 'corrupt' });
    expect(h.storage.values.get(h.key)).toBe(raw);
  });

  it('does not classify a same-ID action carrying an unknown property as idempotent', async () => {
    const h = setup(); await h.repository.createSession(makeSession()); await h.repository.appendAction(SID, 1, action(), progress(), ISO);
    const before = h.storage.values.get(h.key);
    expect(await h.repository.appendAction(SID, 1, { ...action(), unknown: true } as BacktestEntryAction, progress(), ISO))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    expect(h.storage.values.get(h.key)).toBe(before);
  });

  it('rejects direct repository mutation when progress is below canonical action history', async () => {
    const h = setup(); await h.repository.createSession(makeSession()); await h.repository.appendAction(SID, 1, action(), progress(), ISO);
    const exitAtHighWater = {
      actionVersion: 1 as const, actionId: '44444444-4444-4444-8444-444444444444', tradeId: TID,
      sessionId: SID, sequence: 2, kind: 'exit' as const, quantity: 1, fill: action().fill, clientCreatedAt: ISO,
    };
    const before = h.storage.values.get(h.key);
    expect(await h.repository.appendAction(SID, 2, exitAtHighWater, progress(T0 - 1), ISO))
      .toMatchObject({ ok: false, code: 'invalid_action' });
    expect(h.storage.values.get(h.key)).toBe(before);
  });
});

const V18_PRECISE_EXIT_ID = '6a000000-0000-4000-8000-000000000001';
const V18_SCALE_IN_ENTRY_ID = '7a000000-0000-4000-8000-000000000001';
const V18_PARTIAL_EXIT_ID = '7a000000-0000-4000-8000-000000000002';
const V18_NON_TICK_PRICE = 100.123456789;
const V18_FROZEN_UPDATED_AT = '2026-08-14T12:05:00.000Z';

const futureShapedEnvelope = (actions: readonly unknown[]) => JSON.stringify({
  schemaVersion: 1,
  ownerUserId: OWNER,
  sessions: {
    [SID]: {
      schemaVersion: 1, sessionId: SID,
      series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
      status: 'active', createdAt: ISO, updatedAt: V18_FROZEN_UPDATED_AT,
      startedAtReplayUtcMs: T0, cursorUtcMs: T0 + 60_000, displayTimeframe: '1m', speed: 1,
      revision: 3, actions,
    },
  },
});

describe('Released v1.8.0 repository characterization (B2c Phase 0)', () => {
  it('hydrates a persisted non-tick fill Number with exact IEEE-754 identity and no normalization', async () => {
    const h = setup();
    const preciseExit = {
      actionVersion: 1 as const, actionId: V18_PRECISE_EXIT_ID, tradeId: TID, sessionId: SID,
      sequence: 2, kind: 'exit' as const, quantity: 1,
      fill: {
        decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000,
        price: V18_NON_TICK_PRICE, basis: 'revealed_1m_close' as const,
      },
      clientCreatedAt: '2026-08-14T12:01:00.000Z',
    };
    expect(Number.isSafeInteger(V18_NON_TICK_PRICE / 0.25)).toBe(false);

    expect((await h.repository.createSession(makeSession())).ok).toBe(true);
    expect((await h.repository.appendAction(SID, 1, action(), progress(), ISO)).ok).toBe(true);
    const appended = await h.repository.appendAction(
      SID, 2, preciseExit, progress(T0 + 60_000), '2026-08-14T12:01:00.000Z',
    );
    expect(appended.ok).toBe(true);
    if (!appended.ok) return;

    const raw = h.storage.values.get(h.key);
    expect(raw).toContain('"price":100.123456789');
    expect(JSON.parse(raw!).sessions[SID].actions[1].fill.price).toBe(V18_NON_TICK_PRICE);

    const writesAfterAppend = h.storage.writes;
    const listed = await h.repository.listSessions();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const reloaded = listed.value[0];

    expect(h.storage.writes).toBe(writesAfterAppend);
    expect(h.storage.values.get(h.key)).toBe(raw);
    expect(reloaded).toEqual(appended.value);
    expect(reloaded.actions[1].fill.price).toBe(V18_NON_TICK_PRICE);
    expect(Object.is(reloaded.actions[1].fill.price, V18_NON_TICK_PRICE)).toBe(true);
    expect(reloaded.actions[1].fill.price).not.toBe(100.12345679);

    const [trade] = projectBacktestSession(reloaded).closedTrades;
    expect(Object.is(trade.points, 0.12345678900000223)).toBe(true);
    expect(Object.is(trade.entry.fill.price, 100)).toBe(true);
    expect(Object.is(trade.exit.fill.price, V18_NON_TICK_PRICE)).toBe(true);
  });

  /**
   * FROZEN HISTORICAL FIXTURE — TEST ONLY.
   *
   * This is a verbatim copy of the RELEASED v1.8.0 transition predicate (the
   * entry/exit arm of `validateBacktestSession` at tag v1.8.0). It characterizes
   * what an OLD v1.8.0 client does when handed schema-v1 bytes written by a B2c
   * client: it fails closed. It is deliberately NOT the current B2c validator,
   * is never exported from production, and must not be used as one.
   */
  const releasedV18TransitionSemanticsAccept = (actions: readonly BacktestAction[]): boolean => {
    let open: { tradeId: string; quantity: number } | null = null;
    const tradeIds = new Set<string>();
    for (const candidate of actions) {
      if (candidate.kind === 'entry') {
        if (open !== null || tradeIds.has(candidate.tradeId)) return false;
        tradeIds.add(candidate.tradeId);
        open = { tradeId: candidate.tradeId, quantity: candidate.quantity };
      } else {
        if (open === null || open.tradeId !== candidate.tradeId || open.quantity !== candidate.quantity) return false;
        open = null;
      }
    }
    return true;
  };

  it('characterizes released v1.8.0 semantics failing closed on B2c-shaped schema-v1 bytes', async () => {
    const scaleInEntryA = action();
    const scaleInEntryB = action({
      actionId: V18_SCALE_IN_ENTRY_ID, sequence: 2, quantity: 2,
      fill: {
        decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000,
        price: 101, basis: 'revealed_1m_close',
      },
      clientCreatedAt: V18_FROZEN_UPDATED_AT,
    });
    const partialEntry = action({ quantity: 2 });
    const partialExit = {
      actionVersion: 1 as const, actionId: V18_PARTIAL_EXIT_ID, tradeId: TID, sessionId: SID,
      sequence: 2, kind: 'exit' as const, quantity: 1,
      fill: {
        decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000,
        price: 101.5, basis: 'revealed_1m_close' as const,
      },
      clientCreatedAt: V18_FROZEN_UPDATED_AT,
    };

    for (const history of [[scaleInEntryA, scaleInEntryB], [partialEntry, partialExit]] as const) {
      // Each action is individually well formed, so the released rejection is
      // purely a transition-language decision.
      for (const candidate of history) expect(validateBacktestAction(candidate, 'NQ')).toBe(true);
      const raw = futureShapedEnvelope(history);
      const persistedSession = JSON.parse(raw).sessions[SID];

      const h = setup();
      h.storage.values.set(h.key, raw);
      expect(h.storage.writes).toBe(0);

      // Released v1.8.0 fails closed on these bytes and never rewrites them.
      expect(releasedV18TransitionSemanticsAccept(persistedSession.actions)).toBe(false);
      expect(h.storage.writes).toBe(0);
      expect(h.storage.values.size).toBe(1);
      expect(h.storage.values.get(h.key)).toBe(raw);
      const stillPersisted = JSON.parse(h.storage.values.get(h.key)!).sessions[SID];
      expect(stillPersisted.revision).toBe(3);
      expect(stillPersisted.updatedAt).toBe(V18_FROZEN_UPDATED_AT);
      expect(stillPersisted.actions).toEqual(JSON.parse(JSON.stringify(history)));

      // The current B2c validator intentionally diverges and accepts them.
      expect(validateBacktestSession(persistedSession)).toBe(true);
    }
  });

  it('accepts the same B2c-shaped schema-v1 bytes through the current repository read path', async () => {
    const scaleIn = [
      action(),
      action({
        actionId: V18_SCALE_IN_ENTRY_ID, sequence: 2, quantity: 2,
        fill: {
          decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000,
          price: 101, basis: 'revealed_1m_close',
        },
        clientCreatedAt: V18_FROZEN_UPDATED_AT,
      }),
    ] as const;
    const raw = futureShapedEnvelope(scaleIn);
    const h = setup();
    h.storage.values.set(h.key, raw);
    const writesBefore = h.storage.writes;

    const listed = await h.repository.listSessions();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const reloaded = listed.value[0];
    expect(reloaded.schemaVersion).toBe(1);
    expect(reloaded.actions.map((entry) => entry.actionVersion)).toEqual([1, 1]);
    expect(reloaded.actions).toEqual(JSON.parse(JSON.stringify(scaleIn)));
    expect(projectBacktestSession(reloaded, Number.MAX_SAFE_INTEGER).openAggregate).toMatchObject({
      tradeId: TID, side: 'long', totalEntryQuantity: 3, totalExitedQuantity: 0,
      remainingQuantity: 3, weightedAverageEntryPrice: 302 / 3,
    });
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(raw);
  });
});

const P2_EXIT_A = '5b000000-0000-4000-8000-000000000001';
const P2_EXIT_B = '5b000000-0000-4000-8000-000000000002';
const P2_SCALE_A = '5b000000-0000-4000-8000-000000000003';
const P2_OTHER_TRADE = '5b000000-0000-4000-8000-00000000000b';

const scaleEntry = (actionId: string, sequence: number, quantity: number, price: number, decisionUtcMs: number,
  overrides: Partial<BacktestEntryAction> = {}): BacktestEntryAction => ({
  actionVersion: 1, actionId, tradeId: TID, sessionId: SID, sequence, kind: 'entry', side: 'long',
  quantity, initialStopPrice: 99,
  fill: {
    decisionUtcMs, sourceBarStartUtcMs: decisionUtcMs - 60_000, sourceBarCloseUtcMs: decisionUtcMs,
    price, basis: 'revealed_1m_close',
  },
  clientCreatedAt: ISO, ...overrides,
});
const scaleExit = (actionId: string, sequence: number, quantity: number, price: number, decisionUtcMs: number,
  tradeId = TID) => ({
  actionVersion: 1 as const, actionId, tradeId, sessionId: SID, sequence, kind: 'exit' as const, quantity,
  fill: {
    decisionUtcMs, sourceBarStartUtcMs: decisionUtcMs - 60_000, sourceBarCloseUtcMs: decisionUtcMs,
    price, basis: 'revealed_1m_close' as const,
  },
  clientCreatedAt: ISO,
});

describe('B2c Phase 2 — repository accepts legal scaled histories unchanged', () => {
  it('persists Entry 2 → Scale In 1 → partial Exit 1 → final Exit 2 exactly once each', async () => {
    const h = setup();
    expect((await h.repository.createSession(makeSession())).ok).toBe(true);
    expect((await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO)).ok).toBe(true);
    expect((await h.repository.appendAction(SID, 2, scaleEntry(P2_SCALE_A, 2, 1, 101, T0 + 60_000),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z')).ok).toBe(true);
    expect((await h.repository.appendAction(SID, 3, scaleExit(P2_EXIT_A, 3, 1, 102, T0 + 120_000),
      progress(T0 + 120_000), '2026-08-14T12:02:00.000Z')).ok).toBe(true);
    const final = await h.repository.appendAction(SID, 4, scaleExit(P2_EXIT_B, 4, 2, 103, T0 + 180_000),
      progress(T0 + 180_000), '2026-08-14T12:03:00.000Z');
    expect(final.ok).toBe(true);
    if (!final.ok) return;

    expect(final.value.revision).toBe(5);
    expect(final.value.actions).toHaveLength(4);
    expect(final.value.actions.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(final.value.actions.map((entry) => entry.tradeId))).toEqual(new Set([TID]));
    expect(new Set(final.value.actions.map((entry) => entry.actionId)).size).toBe(4);

    const listed = await h.repository.listSessions();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]).toEqual(final.value);
    const envelope = JSON.parse(h.storage.values.get(h.key)!);
    expect(envelope.schemaVersion).toBe(1);
    expect(Object.keys(envelope).sort()).toEqual(['ownerUserId', 'schemaVersion', 'sessions']);
    expect(envelope.sessions[SID].actions.map((entry: BacktestAction) => entry.actionVersion)).toEqual([1, 1, 1, 1]);

    const projection = projectBacktestSession(listed.value[0], Number.MAX_SAFE_INTEGER);
    expect(projection.openAggregate).toBeNull();
    expect(projection.closedTrades).toHaveLength(1);
    expect(projection.closedTrades[0]).toMatchObject({
      tradeId: TID, side: 'long', quantity: 3,
      weightedEntryPrice: 301 / 3, weightedExitPrice: 308 / 3,
    });
    expect((await h.repository.completeSession(SID, 5, progress(T0 + 180_000), '2026-08-14T12:04:00.000Z')).ok).toBe(true);
  });

  it('reloads a partially exited session as still active with the remaining quantity', async () => {
    const h = setup();
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO);
    expect((await h.repository.appendAction(SID, 2, scaleExit(P2_EXIT_A, 2, 1, 102, T0 + 60_000),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z')).ok).toBe(true);

    const listed = await h.repository.listSessions();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0].status).toBe('active');
    expect(listed.value[0].revision).toBe(3);
    expect(projectBacktestSession(listed.value[0], Number.MAX_SAFE_INTEGER).openAggregate).toMatchObject({
      tradeId: TID, totalEntryQuantity: 2, totalExitedQuantity: 1, remainingQuantity: 1,
      weightedAverageEntryPrice: 100, realizedGrossPL: 40,
    });
    expect(await h.repository.completeSession(SID, 3, progress(T0 + 60_000), '2026-08-14T12:02:00.000Z'))
      .toMatchObject({ ok: false, code: 'invalid_session' });
  });

  it('leaves raw bytes untouched for every rejected scaled transition category', async () => {
    const rejected: readonly [string, BacktestAction][] = [
      // Setup below leaves remaining quantity 3, so 4 is an over-Exit by one.
      ['over-exit by one', scaleExit(P2_EXIT_A, 3, 4, 102, T0 + 120_000)],
      ['different tradeId exit', scaleExit(P2_EXIT_A, 3, 1, 102, T0 + 120_000, P2_OTHER_TRADE)],
      ['opposite-side scale in', scaleEntry(P2_SCALE_A, 3, 1, 102, T0 + 120_000, { side: 'short', initialStopPrice: 103 })],
      ['different tradeId entry', scaleEntry(P2_SCALE_A, 3, 1, 102, T0 + 120_000, { tradeId: P2_OTHER_TRADE })],
      ['changed common stop', scaleEntry(P2_SCALE_A, 3, 1, 102, T0 + 120_000, { initialStopPrice: 98 })],
      ['removed common stop', scaleEntry(P2_SCALE_A, 3, 1, 102, T0 + 120_000, { initialStopPrice: null })],
      ['entry through the stop', scaleEntry(P2_SCALE_A, 3, 1, 98.5, T0 + 120_000)],
      ['zero quantity', scaleEntry(P2_SCALE_A, 3, 0, 102, T0 + 120_000)],
      ['fractional quantity', scaleExit(P2_EXIT_A, 3, 1.5, 102, T0 + 120_000)],
    ];

    for (const [label, candidate] of rejected) {
      const h = setup();
      await h.repository.createSession(makeSession());
      await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO);
      await h.repository.appendAction(SID, 2, scaleEntry(P2_SCALE_A, 2, 1, 101, T0 + 60_000),
        progress(T0 + 60_000), '2026-08-14T12:01:00.000Z');
      const rawBefore = h.storage.values.get(h.key);
      const writesBefore = h.storage.writes;
      const before = JSON.parse(rawBefore!).sessions[SID];

      const result = await h.repository.appendAction(SID, 3, candidate,
        progress(T0 + 120_000), '2026-08-14T12:02:00.000Z');
      expect(result.ok, label).toBe(false);

      expect(h.storage.writes, label).toBe(writesBefore);
      expect(h.storage.values.get(h.key), label).toBe(rawBefore);
      const after = JSON.parse(h.storage.values.get(h.key)!).sessions[SID];
      expect(after.revision, label).toBe(before.revision);
      expect(after.updatedAt, label).toBe(before.updatedAt);
      expect(after.actions, label).toEqual(before.actions);
      expect(after.actions, label).toHaveLength(2);
    }
  });

  it('rejects an over-Exit measured against the quantity remaining after a prior partial Exit', async () => {
    const h = setup();
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO);
    await h.repository.appendAction(SID, 2, scaleEntry(P2_SCALE_A, 2, 1, 101, T0 + 60_000),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z');
    await h.repository.appendAction(SID, 3, scaleExit(P2_EXIT_A, 3, 1, 102, T0 + 120_000),
      progress(T0 + 120_000), '2026-08-14T12:02:00.000Z');
    const listed = await h.repository.listSessions();
    expect(listed.ok && projectBacktestSession(listed.value[0], Number.MAX_SAFE_INTEGER)
      .openAggregate?.remainingQuantity).toBe(2);

    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;
    expect((await h.repository.appendAction(SID, 4, scaleExit(P2_EXIT_B, 4, 3, 103, T0 + 180_000),
      progress(T0 + 180_000), '2026-08-14T12:03:00.000Z')).ok).toBe(false);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);

    // The exact remaining quantity is still accepted afterwards.
    expect((await h.repository.appendAction(SID, 4, scaleExit(P2_EXIT_B, 4, 2, 103, T0 + 180_000),
      progress(T0 + 180_000), '2026-08-14T12:03:00.000Z')).ok).toBe(true);
  });

  it('rejects reuse of a permanently closed tradeId without touching stored bytes', async () => {
    const h = setup();
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO);
    await h.repository.appendAction(SID, 2, scaleExit(P2_EXIT_A, 2, 2, 102, T0 + 60_000),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z');
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;

    expect((await h.repository.appendAction(SID, 3, scaleEntry(P2_SCALE_A, 3, 1, 103, T0 + 120_000),
      progress(T0 + 120_000), '2026-08-14T12:02:00.000Z')).ok).toBe(false);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);

    const reopened = await h.repository.appendAction(SID, 3,
      scaleEntry(P2_SCALE_A, 3, 1, 103, T0 + 120_000, { tradeId: P2_OTHER_TRADE }),
      progress(T0 + 120_000), '2026-08-14T12:02:00.000Z');
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(projectBacktestSession(reopened.value, Number.MAX_SAFE_INTEGER).openAggregate?.tradeId).toBe(P2_OTHER_TRADE);
  });
});

const P5_SCALE = '9d000000-0000-4000-8000-000000000001';
const P5_EXIT = '9d000000-0000-4000-8000-000000000002';
const P5_OTHER_TRADE = '9d000000-0000-4000-8000-00000000000b';

/** Create → Entry 2 @100 → Scale In 1 @101 → Partial Exit 1 @102. Revision 4. */
async function p5OpenScaled(h: ReturnType<typeof setup>) {
  await h.repository.createSession(makeSession());
  await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO);
  await h.repository.appendAction(SID, 2, scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000),
    progress(T0 + 60_000), '2026-08-14T12:01:00.000Z');
  await h.repository.appendAction(SID, 3, scaleExit(P5_EXIT, 3, 1, 102, T0 + 120_000),
    progress(T0 + 120_000), '2026-08-14T12:02:00.000Z');
}

describe('B2c Phase 5 — idempotency and collision for scaled actions', () => {
  it('resolves an identical Scale-In retry idempotently even at a stale revision', async () => {
    const h = setup();
    await p5OpenScaled(h);
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;

    const retry = await h.repository.appendAction(SID, 1,
      scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000), progress(T0 + 999), '2026-08-14T12:09:00.000Z');
    expect(retry).toMatchObject({ ok: true, idempotent: true });
    if (!retry.ok) return;
    expect(retry.value.revision).toBe(4);
    expect(retry.value.actions).toHaveLength(3);
    expect(retry.value.actions.filter((item) => item.actionId === P5_SCALE)).toHaveLength(1);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);
  });

  it('resolves an identical Partial-Exit retry idempotently even at a stale revision', async () => {
    const h = setup();
    await p5OpenScaled(h);
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;

    const retry = await h.repository.appendAction(SID, 1,
      scaleExit(P5_EXIT, 3, 1, 102, T0 + 120_000), progress(T0 + 999), '2026-08-14T12:09:00.000Z');
    expect(retry).toMatchObject({ ok: true, idempotent: true });
    if (!retry.ok) return;
    expect(retry.value.revision).toBe(4);
    expect(retry.value.actions.filter((item) => item.actionId === P5_EXIT)).toHaveLength(1);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);
  });

  it('classifies a same-id Scale In with different canonical content as a collision', async () => {
    const variants: ReadonlyArray<readonly [string, BacktestAction]> = [
      ['quantity', scaleEntry(P5_SCALE, 2, 2, 101, T0 + 60_000)],
      ['fill price', scaleEntry(P5_SCALE, 2, 1, 101.5, T0 + 60_000)],
      ['tradeId', scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000, { tradeId: P5_OTHER_TRADE })],
      ['stop', scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000, { initialStopPrice: 98 })],
    ];
    for (const [label, candidate] of variants) {
      const h = setup();
      await p5OpenScaled(h);
      const rawBefore = h.storage.values.get(h.key);
      const writesBefore = h.storage.writes;

      expect(await h.repository.appendAction(SID, 4, candidate, progress(T0 + 120_000), ISO), label)
        .toMatchObject({ ok: false, code: 'id_collision' });
      expect(h.storage.writes, label).toBe(writesBefore);
      expect(h.storage.values.get(h.key), label).toBe(rawBefore);
    }
  });

  it('classifies a same-id Exit with different canonical content as a collision', async () => {
    const variants: ReadonlyArray<readonly [string, BacktestAction]> = [
      ['quantity', scaleExit(P5_EXIT, 3, 2, 102, T0 + 120_000)],
      ['fill price', scaleExit(P5_EXIT, 3, 1, 102.5, T0 + 120_000)],
      ['tradeId', scaleExit(P5_EXIT, 3, 1, 102, T0 + 120_000, P5_OTHER_TRADE)],
    ];
    for (const [label, candidate] of variants) {
      const h = setup();
      await p5OpenScaled(h);
      const rawBefore = h.storage.values.get(h.key);
      const writesBefore = h.storage.writes;

      expect(await h.repository.appendAction(SID, 4, candidate, progress(T0 + 120_000), ISO), label)
        .toMatchObject({ ok: false, code: 'id_collision' });
      expect(h.storage.writes, label).toBe(writesBefore);
      expect(h.storage.values.get(h.key), label).toBe(rawBefore);
    }
  });

  it('resolves an identical duplicate before evaluating stale revision, and collision regardless of revision', async () => {
    const h = setup();
    await p5OpenScaled(h);
    // Identical content + stale revision → idempotent success (duplicate wins).
    expect(await h.repository.appendAction(SID, 1, scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000),
      progress(T0 + 60_000), ISO)).toMatchObject({ ok: true, idempotent: true });
    // Different content + correct revision → still a collision, never an append.
    expect(await h.repository.appendAction(SID, 4, scaleEntry(P5_SCALE, 2, 9, 101, T0 + 60_000),
      progress(T0 + 120_000), ISO)).toMatchObject({ ok: false, code: 'id_collision' });
    const listed = await h.repository.listSessions();
    expect(listed.ok && listed.value[0].actions).toHaveLength(3);
  });
});

describe('B2c Phase 5 — repository rejects invalid B2c operations without touching bytes', () => {
  it('refuses Complete while remaining quantity is above zero', async () => {
    const h = setup();
    await p5OpenScaled(h);
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;
    const before = JSON.parse(rawBefore!).sessions[SID];
    expect(projectBacktestSession(before, Number.MAX_SAFE_INTEGER).openAggregate?.remainingQuantity).toBe(2);

    expect(await h.repository.completeSession(SID, 4, progress(T0 + 120_000), '2026-08-14T12:05:00.000Z'))
      .toMatchObject({ ok: false, code: 'invalid_session' });

    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);
    const after = JSON.parse(h.storage.values.get(h.key)!).sessions[SID];
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.status).toBe('active');
  });

  it('rejects every invalid scaled candidate category with byte and revision invariance', async () => {
    const candidates: ReadonlyArray<readonly [string, BacktestAction]> = [
      ['over-exit', scaleExit('9d000000-0000-4000-8000-000000000101', 4, 3, 103, T0 + 180_000)],
      ['wrong-side scale in', scaleEntry('9d000000-0000-4000-8000-000000000102', 4, 1, 103, T0 + 180_000,
        { side: 'short', initialStopPrice: 104 })],
      ['foreign tradeId entry', scaleEntry('9d000000-0000-4000-8000-000000000103', 4, 1, 103, T0 + 180_000,
        { tradeId: P5_OTHER_TRADE })],
      ['foreign tradeId exit', scaleExit('9d000000-0000-4000-8000-000000000104', 4, 1, 103, T0 + 180_000, P5_OTHER_TRADE)],
      ['changed stop', scaleEntry('9d000000-0000-4000-8000-000000000105', 4, 1, 103, T0 + 180_000,
        { initialStopPrice: 98 })],
      ['entry through the stop', scaleEntry('9d000000-0000-4000-8000-000000000106', 4, 1, 98.5, T0 + 180_000)],
    ];
    for (const [label, candidate] of candidates) {
      const h = setup();
      await p5OpenScaled(h);
      const rawBefore = h.storage.values.get(h.key);
      const writesBefore = h.storage.writes;
      const before = JSON.parse(rawBefore!).sessions[SID];

      const result = await h.repository.appendAction(SID, 4, candidate, progress(T0 + 180_000), '2026-08-14T12:03:00.000Z');
      expect(result.ok, label).toBe(false);
      expect(h.storage.writes, label).toBe(writesBefore);
      expect(h.storage.values.get(h.key), label).toBe(rawBefore);
      const after = JSON.parse(h.storage.values.get(h.key)!).sessions[SID];
      expect(after.revision, label).toBe(before.revision);
      expect(after.updatedAt, label).toBe(before.updatedAt);
      expect(after.actions, label).toHaveLength(3);
    }
  });

  it('rejects a no-stop episode having a stop introduced by a later Scale In', async () => {
    const h = setup();
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0, { initialStopPrice: null }), progress(T0), ISO);
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;

    expect((await h.repository.appendAction(SID, 2,
      scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000, { initialStopPrice: 99 }),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z')).ok).toBe(false);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);
  });

  it('rejects reuse of a closed tradeId after a scaled episode returns flat', async () => {
    const h = setup();
    await h.repository.createSession(makeSession());
    await h.repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO);
    await h.repository.appendAction(SID, 2, scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z');
    await h.repository.appendAction(SID, 3, scaleExit(P5_EXIT, 3, 3, 102, T0 + 120_000),
      progress(T0 + 120_000), '2026-08-14T12:02:00.000Z');
    const rawBefore = h.storage.values.get(h.key);
    const writesBefore = h.storage.writes;

    expect((await h.repository.appendAction(SID, 4,
      scaleEntry('9d000000-0000-4000-8000-000000000201', 4, 1, 103, T0 + 180_000),
      progress(T0 + 180_000), '2026-08-14T12:03:00.000Z')).ok).toBe(false);
    expect(h.storage.writes).toBe(writesBefore);
    expect(h.storage.values.get(h.key)).toBe(rawBefore);
  });
});

describe('B2c Phase 5 — corrupt scaled envelopes stay fail-closed', () => {
  it('never normalizes or rewrites structurally invalid stored scaled histories', async () => {
    const validEntry = action({ quantity: 2 });
    const cases: ReadonlyArray<readonly [string, readonly unknown[]]> = [
      ['over-exit', [validEntry, {
        actionVersion: 1, actionId: P5_EXIT, tradeId: TID, sessionId: SID, sequence: 2, kind: 'exit', quantity: 3,
        fill: {
          decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000,
          price: 101, basis: 'revealed_1m_close',
        },
        clientCreatedAt: ISO,
      }]],
      ['duplicate action identity', [validEntry, { ...validEntry, sequence: 2 }]],
      ['invalid sequence', [validEntry, {
        ...scaleEntry(P5_SCALE, 3, 1, 101, T0 + 60_000), sequence: 3,
      }]],
    ];
    for (const [label, actions] of cases) {
      const raw = futureShapedEnvelope(actions);
      expect(validateBacktestSession(JSON.parse(raw).sessions[SID]), label).toBe(false);

      const h = setup();
      h.storage.values.set(h.key, raw);
      expect(await h.repository.listSessions(), label).toMatchObject({ ok: false, code: 'corrupt' });
      expect(await h.repository.saveProgress(SID, 3, progress(T0 + 60_000), ISO), label)
        .toMatchObject({ ok: false, code: 'corrupt' });
      expect(await h.repository.appendAction(SID, 3, scaleExit(P5_EXIT, 3, 1, 102, T0 + 120_000),
        progress(T0 + 120_000), ISO), label).toMatchObject({ ok: false, code: 'corrupt' });
      expect(await h.repository.completeSession(SID, 3, progress(T0 + 60_000), ISO), label)
        .toMatchObject({ ok: false, code: 'corrupt' });

      expect(h.storage.writes, label).toBe(0);
      expect(h.storage.values.get(h.key), label).toBe(raw);
      expect(h.storage.values.size, label).toBe(1);
    }
  });
});

describe('B2c Phase 5 — scaled workflows touch only B2b-owned bytes', () => {
  it('leaves Journal and historical-market-data keys byte-identical across a scaled episode', async () => {
    const storage = new MemoryStorage();
    const scope = createUserStorageScope(OWNER, storage);
    for (const key of USER_STORAGE_LOGICAL_KEYS.filter((item) => item !== BACKTEST_SESSIONS_STORAGE_KEY)) {
      storage.values.set(scope.physicalKey(key), `scoped:${key}:\u0000preserved`);
      storage.values.set(key, `legacy:${key}:\r\npreserved`);
    }
    const protectedBefore = new Map(storage.values);
    const repository = createBacktestSessionRepository(scope, { runExclusive: immediate });
    const b2bKey = scope.physicalKey(BACKTEST_SESSIONS_STORAGE_KEY);

    expect((await repository.createSession(makeSession())).ok).toBe(true);
    expect((await repository.appendAction(SID, 1, scaleEntry(AID, 1, 2, 100, T0), progress(T0), ISO)).ok).toBe(true);
    expect((await repository.appendAction(SID, 2, scaleEntry(P5_SCALE, 2, 1, 101, T0 + 60_000),
      progress(T0 + 60_000), '2026-08-14T12:01:00.000Z')).ok).toBe(true);
    expect((await repository.appendAction(SID, 3, scaleExit(P5_EXIT, 3, 1, 102, T0 + 120_000),
      progress(T0 + 120_000), '2026-08-14T12:02:00.000Z')).ok).toBe(true);
    expect((await repository.appendAction(SID, 4,
      scaleExit('9d000000-0000-4000-8000-000000000301', 4, 2, 103, T0 + 180_000),
      progress(T0 + 180_000), '2026-08-14T12:03:00.000Z')).ok).toBe(true);
    expect((await repository.completeSession(SID, 5, progress(T0 + 180_000), '2026-08-14T12:04:00.000Z')).ok).toBe(true);

    for (const [key, raw] of protectedBefore) expect(storage.values.get(key), key).toBe(raw);
    expect([...storage.values.keys()].filter((key) => !protectedBefore.has(key))).toEqual([b2bKey]);
    expect([...storage.values.keys()].sort()).toEqual([...protectedBefore.keys(), b2bKey].sort());
  });
});
