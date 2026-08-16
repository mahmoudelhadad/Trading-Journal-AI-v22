import { describe, expect, it } from 'vitest';
import { appendBacktestAction, createBacktestSession, projectBacktestSession } from '@calculations/backtestSession.js';
import { USER_STORAGE_LOGICAL_KEYS, createUserStorageScope, type RawStorage } from './storageNamespace.js';
import { BACKTEST_SESSIONS_LOCK_NAME, BACKTEST_SESSIONS_STORAGE_KEY, createBacktestSessionRepository } from './backtestSessionRepository.js';
import type { BacktestEntryAction } from '@apptypes/backtestSession.js';

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
