import { describe, expect, it } from 'vitest';
import {
  appendBacktestAction, calculateClosedTrade, canonicalActionEqual, createBacktestSession,
  projectBacktestSession, validateBacktestAction, validateBacktestSession,
} from './backtestSession.js';
import type { BacktestAction, BacktestEntryAction, BacktestSession } from '@apptypes/backtestSession.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const EXIT_ID = '33333333-3333-4333-8333-333333333333';
const TRADE_ID = '44444444-4444-4444-8444-444444444444';
const T0 = 1_700_000_040_000;
const ISO = '2026-08-14T12:00:00.000Z';
const progress = (cursorUtcMs = T0) => ({ cursorUtcMs, displayTimeframe: '1m' as const, speed: 1 as const });
const session = () => createBacktestSession({
  sessionId: SESSION_ID, series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
  progress: progress(), createdAt: ISO,
});
const entry = (overrides: Partial<BacktestEntryAction> = {}): BacktestEntryAction => ({
  actionVersion: 1, actionId: ENTRY_ID, tradeId: TRADE_ID, sessionId: SESSION_ID, sequence: 1,
  kind: 'entry', side: 'long', quantity: 2, initialStopPrice: 99,
  fill: { decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0, price: 100, basis: 'revealed_1m_close' },
  clientCreatedAt: ISO, ...overrides,
});
const exit = (overrides: Partial<Extract<BacktestAction, { kind: 'exit' }>> = {}): Extract<BacktestAction, { kind: 'exit' }> => ({
  actionVersion: 1, actionId: EXIT_ID, tradeId: TRADE_ID, sessionId: SESSION_ID, sequence: 2,
  kind: 'exit', quantity: 2,
  fill: { decisionUtcMs: T0 + 60_000, sourceBarStartUtcMs: T0, sourceBarCloseUtcMs: T0 + 60_000, price: 102.5, basis: 'revealed_1m_close' },
  clientCreatedAt: ISO, ...overrides,
});

describe('Backtest session domain', () => {
  it('creates an explicit active session with immutable 1m series facts', () => {
    expect(session()).toEqual(expect.objectContaining({ schemaVersion: 1, sessionId: SESSION_ID, status: 'active', revision: 1, actions: [], startedAtReplayUtcMs: T0 }));
    expect(session().series).toEqual({ root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' });
  });

  it('accepts flat → entry → full exit and many sequential trades', () => {
    const afterEntry = appendBacktestAction(session(), entry(), progress(), ISO);
    const afterExit = appendBacktestAction(afterEntry, exit(), progress(T0 + 60_000), ISO);
    expect(afterExit.revision).toBe(3);
    expect(projectBacktestSession(afterExit).openPosition).toBeNull();
    expect(projectBacktestSession(afterExit).closedTrades).toHaveLength(1);
  });

  // B2c Phase 2 authorized transition-language evolution. Released v1.8.0 also
  // rejected same-side Scale In and partial Exit; both are now legal and are
  // asserted as such at the end of this test. Everything else stays illegal.
  it('rejects exit while flat, over-Exit, and foreign-trade overlap', () => {
    expect(() => appendBacktestAction(session(), exit(), progress(), ISO)).toThrow('invalid');
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    expect(() => appendBacktestAction(open, exit({ quantity: 3 }), progress(T0 + 60_000), ISO)).toThrow('invalid');
    expect(() => appendBacktestAction(open, entry({
      actionId: EXIT_ID, sequence: 2, tradeId: '66666666-6666-4666-8666-666666666666',
    }), progress(), ISO)).toThrow('invalid');
    expect(appendBacktestAction(open, entry({ actionId: EXIT_ID, sequence: 2 }), progress(), ISO).actions).toHaveLength(2);
    expect(appendBacktestAction(open, exit({ quantity: 1 }), progress(T0 + 60_000), ISO).actions).toHaveLength(2);
  });

  it('requires positive safe whole-contract quantity', () => {
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(validateBacktestAction(entry({ quantity }), 'NQ')).toBe(false);
    }
  });

  it('validates optional initial stops as immutable side-correct tick-aligned risk anchors', () => {
    expect(validateBacktestAction(entry({ initialStopPrice: null }), 'NQ')).toBe(true);
    expect(validateBacktestAction(entry({ initialStopPrice: 99.25 }), 'NQ')).toBe(true);
    expect(validateBacktestAction(entry({ initialStopPrice: 99.1 }), 'NQ')).toBe(false);
    expect(validateBacktestAction(entry({ initialStopPrice: 100 }), 'NQ')).toBe(false);
    expect(validateBacktestAction(entry({ initialStopPrice: 101 }), 'NQ')).toBe(false);
    expect(validateBacktestAction(entry({ side: 'short', initialStopPrice: 101 }), 'NQ')).toBe(true);
  });

  it('calculates NQ long points, ticks, gross P/L, risk, and R independently', () => {
    expect(calculateClosedTrade('NQ', entry(), exit())).toMatchObject({ points: 2.5, ticks: 10, grossPL: 100, initialRisk: 40, rMultiple: 2.5 });
  });

  it('calculates ES short values and null risk/R without a stop', () => {
    const short = entry({ side: 'short', quantity: 3, initialStopPrice: null, fill: { ...entry().fill, price: 5500 } });
    const close = exit({ quantity: 3, fill: { ...exit().fill, price: 5498.5 } });
    expect(calculateClosedTrade('ES', short, close)).toMatchObject({ points: 1.5, ticks: 6, grossPL: 225, initialRisk: null, rMultiple: null });
  });

  it('uses exact stored fill prices without rounding', () => {
    const preciseExit = exit({ fill: { ...exit().fill, price: 100.123456789 } });
    expect(calculateClosedTrade('NQ', entry(), preciseExit).points).toBe(0.12345678900000223);
  });

  it('projects rewind without deleting future canonical history', () => {
    const completedTrade = appendBacktestAction(appendBacktestAction(session(), entry(), progress(), ISO), exit(), progress(T0 + 60_000), ISO);
    const projection = projectBacktestSession(completedTrade, T0);
    expect(projection.rewound).toBe(true);
    expect(projection.visibleActions).toEqual([completedTrade.actions[0]]);
    expect(completedTrade.actions).toHaveLength(2);
    expect(projection.highWaterMarkUtcMs).toBe(T0 + 60_000);
  });

  it('preserves same-decision-time actions by sequence order', () => {
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    const sameTimeExit = exit({ fill: { ...exit().fill, decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0 } });
    const flat = appendBacktestAction(open, sameTimeExit, progress(), ISO);
    expect(projectBacktestSession(flat).visibleActions.map((action) => action.sequence)).toEqual([1, 2]);
  });

  it('rejects a mutation whose decision predates the action high-water mark', () => {
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    expect(() => appendBacktestAction(open, exit({ fill: {
      ...exit().fill, decisionUtcMs: T0 - 1, sourceBarStartUtcMs: T0 - 60_001, sourceBarCloseUtcMs: T0 - 1,
    } }), progress(T0 - 1), ISO)).toThrow('rewound');
  });

  it('compares every canonical action field structurally', () => {
    expect(canonicalActionEqual(entry(), { ...entry() })).toBe(true);
    expect(canonicalActionEqual(entry(), entry({ quantity: 3 }))).toBe(false);
    expect(canonicalActionEqual(entry(), entry({ fill: { ...entry().fill, price: 100.25 } }))).toBe(false);
    expect(canonicalActionEqual(entry(), entry({ clientCreatedAt: '2026-08-14T12:00:01.000Z' }))).toBe(false);
    expect(canonicalActionEqual(entry(), entry({ initialStopPrice: null }))).toBe(false);
  });

  it('rejects completed sessions with an open position', () => {
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    expect(validateBacktestSession({ ...open, status: 'completed' } as BacktestSession)).toBe(false);
  });

  it('requires unique action IDs and unique entry trade IDs', () => {
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    expect(validateBacktestSession({ ...open, actions: [open.actions[0], { ...open.actions[0], sequence: 2 }] })).toBe(false);
    const flat = appendBacktestAction(open, exit(), progress(T0 + 60_000), ISO);
    const reusedTrade = entry({ actionId: '55555555-5555-4555-8555-555555555555', sequence: 3 });
    expect(() => appendBacktestAction(flat, reusedTrade, progress(T0 + 60_000), ISO)).toThrow();
  });

  it('rejects rewound command progress even when the action decision equals the high-water mark', () => {
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    const sameTimeExit = exit({ fill: { ...exit().fill, decisionUtcMs: T0, sourceBarStartUtcMs: T0 - 60_000, sourceBarCloseUtcMs: T0 } });
    expect(() => appendBacktestAction(open, sameTimeExit, progress(T0 - 1), ISO)).toThrow('rewound');
    expect(appendBacktestAction(open, sameTimeExit, progress(T0), ISO).actions).toHaveLength(2);
  });

  it('requires submitted progress cursor to equal the action decision cursor', () => {
    expect(() => appendBacktestAction(session(), entry(), progress(T0 + 1), ISO)).toThrow('invalid_action');
  });

  it('rejects unknown persisted properties at every frozen schema-v1 object boundary', () => {
    const base = session();
    expect(validateBacktestSession({ ...base, unknown: true })).toBe(false);
    expect(validateBacktestSession({ ...base, series: { ...base.series, unknown: true } })).toBe(false);
    expect(validateBacktestAction({ ...entry(), unknown: true }, 'NQ')).toBe(false);
    expect(validateBacktestAction({ ...exit(), unknown: true }, 'NQ')).toBe(false);
    expect(validateBacktestAction({ ...entry(), fill: { ...entry().fill, unknown: true } }, 'NQ')).toBe(false);
  });
});

const V18_OPEN_SESSION_ID = '9a000000-0000-4000-8000-000000000001';
const V18_OPEN_ENTRY_ID = '9a000000-0000-4000-8000-000000000002';
const V18_OPEN_TRADE_ID = '9a000000-0000-4000-8000-000000000003';
const V18_OPEN_T0 = 1_712_345_700_000;
const V18_OPEN_CREATED_AT = '2026-08-14T11:58:00.000Z';
const V18_OPEN_CLIENT_AT = '2026-08-14T11:58:47.321Z';
const V18_OPEN_FILL = {
  decisionUtcMs: V18_OPEN_T0,
  sourceBarStartUtcMs: V18_OPEN_T0 - 60_000,
  sourceBarCloseUtcMs: V18_OPEN_T0,
  price: 20100.75,
  basis: 'revealed_1m_close',
} as const;
const V18_OPEN_ENTRY: BacktestEntryAction = {
  actionVersion: 1, actionId: V18_OPEN_ENTRY_ID, tradeId: V18_OPEN_TRADE_ID, sessionId: V18_OPEN_SESSION_ID,
  sequence: 1, kind: 'entry', side: 'short', quantity: 5, initialStopPrice: 20125.25,
  fill: { ...V18_OPEN_FILL }, clientCreatedAt: V18_OPEN_CLIENT_AT,
};

const V18_CLOSED_SESSION_ID = '9b000000-0000-4000-8000-000000000001';
const V18_CLOSED_ENTRY_ID = '9b000000-0000-4000-8000-000000000002';
const V18_CLOSED_EXIT_ID = '9b000000-0000-4000-8000-000000000003';
const V18_CLOSED_TRADE_ID = '9b000000-0000-4000-8000-000000000004';
const V18_CLOSED_T0 = 1_712_400_000_000;
const V18_CLOSED_CREATED_AT = '2026-08-14T12:10:00.000Z';

const V18_ES_SESSION_ID = '9c000000-0000-4000-8000-000000000001';
const V18_ES_ENTRY_ID = '9c000000-0000-4000-8000-000000000002';
const V18_ES_EXIT_ID = '9c000000-0000-4000-8000-000000000003';
const V18_ES_TRADE_ID = '9c000000-0000-4000-8000-000000000004';
const V18_ES_T0 = 1_712_500_000_000 - (1_712_500_000_000 % 60_000);
const V18_ES_CREATED_AT = '2026-08-14T12:20:00.000Z';

describe('Released v1.8.0 characterization (B2c Phase 0)', () => {
  it('freezes the legacy one-Entry open position, its exact identity, and the Complete barrier', () => {
    const flat = createBacktestSession({
      sessionId: V18_OPEN_SESSION_ID,
      series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
      progress: { cursorUtcMs: V18_OPEN_T0, displayTimeframe: '1m', speed: 1 },
      createdAt: V18_OPEN_CREATED_AT,
    });
    const open = appendBacktestAction(
      flat, V18_OPEN_ENTRY, { cursorUtcMs: V18_OPEN_T0, displayTimeframe: '1m', speed: 1 }, V18_OPEN_CLIENT_AT,
    );
    const projection = projectBacktestSession(open);

    expect(open.actions).toHaveLength(1);
    expect(open.actions.filter((action) => action.kind === 'entry')).toHaveLength(1);
    expect(projection.visibleActions.filter((action) => action.kind === 'entry')).toHaveLength(1);

    expect(projection.openPosition).toBe(open.actions[0]);
    expect(projection.openPosition).toEqual({
      actionVersion: 1, actionId: V18_OPEN_ENTRY_ID, tradeId: V18_OPEN_TRADE_ID, sessionId: V18_OPEN_SESSION_ID,
      sequence: 1, kind: 'entry', side: 'short', quantity: 5, initialStopPrice: 20125.25,
      fill: {
        decisionUtcMs: V18_OPEN_T0, sourceBarStartUtcMs: V18_OPEN_T0 - 60_000, sourceBarCloseUtcMs: V18_OPEN_T0,
        price: 20100.75, basis: 'revealed_1m_close',
      },
      clientCreatedAt: V18_OPEN_CLIENT_AT,
    });
    expect(projection.openPosition?.quantity).toBe(V18_OPEN_ENTRY.quantity);
    expect(projection.openPosition?.side).toBe('short');
    expect(projection.openPosition?.initialStopPrice).toBe(20125.25);
    expect(projection.openPosition?.fill.price).toBe(20100.75);
    expect(projection.closedTrades).toEqual([]);
    expect(projection.highWaterMarkUtcMs).toBe(V18_OPEN_T0);
    expect(projection.rewound).toBe(false);

    expect(open.status).toBe('active');
    expect(open.revision).toBe(2);
    expect(validateBacktestSession(open)).toBe(true);
    expect(validateBacktestSession({ ...open, status: 'completed' } as BacktestSession)).toBe(false);
  });

  it('freezes the legacy flat → Entry → equal-quantity Exit → flat closed-trade snapshot', () => {
    const entryAction: BacktestEntryAction = {
      actionVersion: 1, actionId: V18_CLOSED_ENTRY_ID, tradeId: V18_CLOSED_TRADE_ID, sessionId: V18_CLOSED_SESSION_ID,
      sequence: 1, kind: 'entry', side: 'long', quantity: 4, initialStopPrice: 19995.25,
      fill: {
        decisionUtcMs: V18_CLOSED_T0, sourceBarStartUtcMs: V18_CLOSED_T0 - 60_000, sourceBarCloseUtcMs: V18_CLOSED_T0,
        price: 20000.25, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T12:10:30.000Z',
    };
    const exitAction: Extract<BacktestAction, { kind: 'exit' }> = {
      actionVersion: 1, actionId: V18_CLOSED_EXIT_ID, tradeId: V18_CLOSED_TRADE_ID, sessionId: V18_CLOSED_SESSION_ID,
      sequence: 2, kind: 'exit', quantity: 4,
      fill: {
        decisionUtcMs: V18_CLOSED_T0 + 60_000, sourceBarStartUtcMs: V18_CLOSED_T0,
        sourceBarCloseUtcMs: V18_CLOSED_T0 + 60_000, price: 20010.25, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T12:11:30.000Z',
    };
    const flat = createBacktestSession({
      sessionId: V18_CLOSED_SESSION_ID,
      series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
      progress: { cursorUtcMs: V18_CLOSED_T0, displayTimeframe: '1m', speed: 1 },
      createdAt: V18_CLOSED_CREATED_AT,
    });
    const open = appendBacktestAction(
      flat, entryAction, { cursorUtcMs: V18_CLOSED_T0, displayTimeframe: '1m', speed: 1 }, '2026-08-14T12:10:30.000Z',
    );
    expect(projectBacktestSession(open).openPosition).toBe(open.actions[0]);
    const closed = appendBacktestAction(
      open, exitAction, { cursorUtcMs: V18_CLOSED_T0 + 60_000, displayTimeframe: '1m', speed: 1 },
      '2026-08-14T12:11:30.000Z',
    );
    const projection = projectBacktestSession(closed);

    expect(projection.closedTrades).toHaveLength(1);
    const [trade] = projection.closedTrades;
    expect(trade.tradeId).toBe(V18_CLOSED_TRADE_ID);
    expect(trade.side).toBe('long');
    expect(trade.quantity).toBe(4);
    expect(trade.entry).toBe(closed.actions[0]);
    expect(trade.exit).toBe(closed.actions[1]);
    expect(trade.entry.fill).toEqual({
      decisionUtcMs: V18_CLOSED_T0, sourceBarStartUtcMs: V18_CLOSED_T0 - 60_000, sourceBarCloseUtcMs: V18_CLOSED_T0,
      price: 20000.25, basis: 'revealed_1m_close',
    });
    expect(trade.exit.fill).toEqual({
      decisionUtcMs: V18_CLOSED_T0 + 60_000, sourceBarStartUtcMs: V18_CLOSED_T0,
      sourceBarCloseUtcMs: V18_CLOSED_T0 + 60_000, price: 20010.25, basis: 'revealed_1m_close',
    });
    expect(trade.points).toBe(10);
    expect(trade.ticks).toBe(40);
    expect(trade.grossPL).toBe(800);
    expect(trade.initialRisk).toBe(400);
    expect(trade.rMultiple).toBe(2);

    expect(projection.openPosition).toBeNull();
    expect(closed.status).toBe('active');
    expect(closed.revision).toBe(3);
    expect(validateBacktestSession({ ...closed, status: 'completed' } as BacktestSession)).toBe(true);
    expect(projectBacktestSession(closed, Number.MAX_SAFE_INTEGER).openPosition).toBeNull();
    expect(projectBacktestSession(closed, Number.MAX_SAFE_INTEGER).closedTrades).toHaveLength(1);
  });

  it('freezes the exact legacy numeric path for a single-Entry single-full-Exit ES short episode', () => {
    const entryAction: BacktestEntryAction = {
      actionVersion: 1, actionId: V18_ES_ENTRY_ID, tradeId: V18_ES_TRADE_ID, sessionId: V18_ES_SESSION_ID,
      sequence: 1, kind: 'entry', side: 'short', quantity: 3, initialStopPrice: 5503.25,
      fill: {
        decisionUtcMs: V18_ES_T0, sourceBarStartUtcMs: V18_ES_T0 - 60_000, sourceBarCloseUtcMs: V18_ES_T0,
        price: 5500.75, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T12:20:30.000Z',
    };
    const exitAction: Extract<BacktestAction, { kind: 'exit' }> = {
      actionVersion: 1, actionId: V18_ES_EXIT_ID, tradeId: V18_ES_TRADE_ID, sessionId: V18_ES_SESSION_ID,
      sequence: 2, kind: 'exit', quantity: 3,
      fill: {
        decisionUtcMs: V18_ES_T0 + 60_000, sourceBarStartUtcMs: V18_ES_T0,
        sourceBarCloseUtcMs: V18_ES_T0 + 60_000, price: 5495.25, basis: 'revealed_1m_close',
      },
      clientCreatedAt: '2026-08-14T12:21:30.000Z',
    };
    const flat = createBacktestSession({
      sessionId: V18_ES_SESSION_ID,
      series: { root: 'ES', expiryYear: 2026, expiryMonth: 12, timeframe: '1m' },
      progress: { cursorUtcMs: V18_ES_T0, displayTimeframe: '1m', speed: 1 },
      createdAt: V18_ES_CREATED_AT,
    });
    const closed = appendBacktestAction(
      appendBacktestAction(flat, entryAction, { cursorUtcMs: V18_ES_T0, displayTimeframe: '1m', speed: 1 }, '2026-08-14T12:20:30.000Z'),
      exitAction, { cursorUtcMs: V18_ES_T0 + 60_000, displayTimeframe: '1m', speed: 1 }, '2026-08-14T12:21:30.000Z',
    );

    const direct = calculateClosedTrade('ES', entryAction, exitAction);
    const [projected] = projectBacktestSession(closed).closedTrades;

    for (const trade of [direct, projected]) {
      expect(Object.is(trade.points, 5.5)).toBe(true);
      expect(Object.is(trade.ticks, 22)).toBe(true);
      expect(Object.is(trade.grossPL, 825)).toBe(true);
      expect(Object.is(trade.initialRisk, 375)).toBe(true);
      expect(Object.is(trade.rMultiple, 2.2)).toBe(true);
      expect(trade.quantity).toBe(3);
      expect(trade.side).toBe('short');
      expect(trade.tradeId).toBe(V18_ES_TRADE_ID);
    }
    expect(projected.points).toBe(direct.points);
    expect(projected.grossPL).toBe(direct.grossPL);
    expect(projected.initialRisk).toBe(direct.initialRisk);
    expect(projected.rMultiple).toBe(direct.rMultiple);
  });
});

const SCALE_SESSION_ID = '8d000000-0000-4000-8000-000000000001';
const SCALE_TRADE_ID = '8d000000-0000-4000-8000-00000000000f';
const SCALE_T0 = 1_712_600_000_000 - (1_712_600_000_000 % 60_000);
const SCALE_ISO = '2026-08-14T13:00:00.000Z';

interface ScaleLeg { kind: 'entry' | 'exit'; quantity: number; price: number }

const scaledSession = (
  root: 'NQ' | 'ES',
  side: 'long' | 'short',
  legs: readonly ScaleLeg[],
  initialStopPrice: number | null = null,
  decisionStepMs = 60_000,
): BacktestSession => ({
  schemaVersion: 1, sessionId: SCALE_SESSION_ID,
  series: { root, expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
  status: 'active', createdAt: SCALE_ISO, updatedAt: SCALE_ISO,
  startedAtReplayUtcMs: SCALE_T0, cursorUtcMs: SCALE_T0 + legs.length * 60_000,
  displayTimeframe: '1m', speed: 1, revision: legs.length + 1,
  actions: legs.map((leg, index) => {
    const decisionUtcMs = SCALE_T0 + index * decisionStepMs;
    const base = {
      actionVersion: 1 as const,
      actionId: `8d000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      tradeId: SCALE_TRADE_ID, sessionId: SCALE_SESSION_ID, sequence: index + 1,
      quantity: leg.quantity,
      fill: {
        decisionUtcMs, sourceBarStartUtcMs: decisionUtcMs - 60_000, sourceBarCloseUtcMs: decisionUtcMs,
        price: leg.price, basis: 'revealed_1m_close' as const,
      },
      clientCreatedAt: SCALE_ISO,
    };
    return leg.kind === 'entry'
      ? { ...base, kind: 'entry' as const, side, initialStopPrice }
      : { ...base, kind: 'exit' as const };
  }),
});
const atLeg = (session: BacktestSession, index: number) => projectBacktestSession(session, SCALE_T0 + index * 60_000);

const EXAMPLE_A: readonly ScaleLeg[] = [
  { kind: 'entry', quantity: 1, price: 20000 }, { kind: 'entry', quantity: 2, price: 20001.5 },
  { kind: 'exit', quantity: 1, price: 20003 }, { kind: 'exit', quantity: 2, price: 19999 },
];
const EXAMPLE_B: readonly ScaleLeg[] = [
  { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20002 },
  { kind: 'entry', quantity: 3, price: 20001.25 }, { kind: 'exit', quantity: 2, price: 20003.25 },
  { kind: 'exit', quantity: 2, price: 19999.75 },
];
const EXAMPLE_C: readonly ScaleLeg[] = [
  { kind: 'entry', quantity: 1, price: 20010 }, { kind: 'entry', quantity: 1, price: 20008.5 },
  { kind: 'exit', quantity: 1, price: 20006 }, { kind: 'exit', quantity: 1, price: 20012 },
];
const EXAMPLE_D: readonly ScaleLeg[] = [
  { kind: 'entry', quantity: 2, price: 5000 }, { kind: 'entry', quantity: 1, price: 5002.25 },
  { kind: 'exit', quantity: 1, price: 5004 }, { kind: 'entry', quantity: 2, price: 5001.25 },
  { kind: 'exit', quantity: 4, price: 5003 },
];

describe('B2c Phase 1 — RFC worked examples', () => {
  it('Example A — NQ long scale-in then two exits', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_A, 19995);
    expect(atLeg(session, 1).openAggregate?.weightedAverageEntryPrice).toBe(20001);
    expect(atLeg(session, 2).openAggregate?.realizedGrossPL).toBe(40);
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(trade.weightedEntryPrice).toBe(20001);
    expect(trade.weightedExitPrice).toBe(60001 / 3);
    expect(trade.points).toBe(-2 / 3);
    expect(trade.ticks).toBe(-8 / 3);
    expect(trade.grossPL).toBe(-40);
    expect(trade.initialRisk).toBe(360);
    expect(trade.rMultiple).toBe(-1 / 9);
    expect(trade.quantity).toBe(3);
  });

  it('Example B — NQ long partial exit then scale-in', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_B, 19995);
    expect(atLeg(session, 1).openAggregate?.realizedGrossPL).toBe(40);
    expect(atLeg(session, 2).openAggregate?.weightedAverageEntryPrice).toBe(20000.9375);
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(trade.weightedEntryPrice).toBe(20000.75);
    expect(trade.weightedExitPrice).toBe(20001.6);
    expect(trade.points).toBe(0.85);
    expect(trade.ticks).toBe(3.4);
    expect(trade.grossPL).toBe(85);
    expect(trade.initialRisk).toBe(575);
    expect(trade.rMultiple).toBe(17 / 115);
    expect(trade.quantity).toBe(5);
  });

  it('Example C — NQ short scale-in', () => {
    const session = scaledSession('NQ', 'short', EXAMPLE_C, 20015);
    expect(atLeg(session, 1).openAggregate?.weightedAverageEntryPrice).toBe(20009.25);
    expect(atLeg(session, 2).openAggregate?.realizedGrossPL).toBe(65);
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(trade.weightedEntryPrice).toBe(20009.25);
    expect(trade.weightedExitPrice).toBe(20009);
    expect(trade.points).toBe(0.25);
    expect(trade.ticks).toBe(1);
    expect(trade.grossPL).toBe(10);
    expect(trade.initialRisk).toBe(230);
    expect(trade.rMultiple).toBe(1 / 23);
    expect(trade.quantity).toBe(2);
  });

  it('Example D — ES common-stop scaling', () => {
    const session = scaledSession('ES', 'long', EXAMPLE_D, 4995);
    expect(atLeg(session, 1).openAggregate?.weightedAverageEntryPrice).toBe(5000.75);
    expect(atLeg(session, 2).openAggregate?.realizedGrossPL).toBe(162.5);
    expect(atLeg(session, 3).openAggregate?.weightedAverageEntryPrice).toBe(5001);
    expect(atLeg(session, 3).openAggregate?.anchoredRisk).toBe(1487.5);
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(trade.weightedEntryPrice).toBe(5000.95);
    expect(trade.weightedExitPrice).toBe(5003.2);
    expect(trade.points).toBe(2.25);
    expect(trade.ticks).toBe(9);
    expect(trade.grossPL).toBe(562.5);
    expect(trade.initialRisk).toBe(1487.5);
    expect(trade.rMultiple).toBe(45 / 119);
    expect(trade.quantity).toBe(5);
  });
});

describe('B2c Phase 1 — aggregate fold semantics', () => {
  it('tracks remaining, entered, and exited quantity after every intermediate action', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_B, 19995);
    const shape = [0, 1, 2, 3].map((index) => {
      const aggregate = atLeg(session, index).openAggregate;
      return [aggregate?.totalEntryQuantity, aggregate?.totalExitedQuantity, aggregate?.remainingQuantity];
    });
    expect(shape).toEqual([[2, 0, 2], [2, 1, 1], [5, 1, 4], [5, 3, 2]]);
    expect(atLeg(session, 4).openAggregate).toBeNull();
    expect(atLeg(session, 4).closedTrades).toHaveLength(1);
  });

  it('leaves the basis unchanged across a partial exit and rebuilds it from remaining inventory only', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_B, 19995);
    expect(atLeg(session, 0).openAggregate?.weightedAverageEntryPrice).toBe(20000);
    expect(atLeg(session, 1).openAggregate?.weightedAverageEntryPrice).toBe(20000);
    expect(atLeg(session, 2).openAggregate?.weightedAverageEntryPrice).toBe(20000.9375);
    expect(atLeg(session, 2).openAggregate?.weightedAverageEntryPrice).not.toBe(20000.75);
  });

  it('keeps anchored risk cumulative and never reduced by a partial exit', () => {
    const session = scaledSession('ES', 'long', EXAMPLE_D, 4995);
    // 2@5000 → 500; +1@5002.25 → +362.50; partial Exit → unchanged; +2@5001.25 → +625.
    expect([0, 1, 2, 3].map((index) => atLeg(session, index).openAggregate?.anchoredRisk))
      .toEqual([500, 862.5, 862.5, 1487.5]);
  });

  it('returns null risk and null R for a scaled aggregate without a first-entry stop', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_A, null);
    expect(atLeg(session, 1).openAggregate?.anchoredRisk).toBeNull();
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(trade.initialRisk).toBeNull();
    expect(trade.rMultiple).toBeNull();
    expect(trade.grossPL).toBe(-40);
  });

  it('conserves cumulative partial realizations against final aggregate economics exactly', () => {
    for (const [root, side, legs] of [
      ['NQ', 'long', EXAMPLE_A], ['NQ', 'long', EXAMPLE_B],
      ['NQ', 'short', EXAMPLE_C], ['ES', 'long', EXAMPLE_D],
    ] as const) {
      const session = scaledSession(root, side, legs, null);
      const beforeClose = atLeg(session, legs.length - 2).openAggregate;
      const [trade] = projectBacktestSession(session).closedTrades;
      const finalLeg = legs[legs.length - 1];
      const pointValue = root === 'NQ' ? 20 : 50;
      const closingRealized = side === 'long'
        ? finalLeg.quantity * (finalLeg.price - beforeClose!.weightedAverageEntryPrice) * pointValue
        : finalLeg.quantity * (beforeClose!.weightedAverageEntryPrice - finalLeg.price) * pointValue;
      expect(trade.grossPL).toBe(beforeClose!.realizedGrossPL + closingRealized);
      expect(trade.quantity).toBe(legs.filter((leg) => leg.kind === 'exit').reduce((sum, leg) => sum + leg.quantity, 0));
      expect(trade.entries).toHaveLength(legs.filter((leg) => leg.kind === 'entry').length);
      expect(trade.exits).toHaveLength(legs.filter((leg) => leg.kind === 'exit').length);
    }
  });

  it('does not accumulate drift across repeating rational averages', () => {
    const thirds: readonly ScaleLeg[] = [
      { kind: 'entry', quantity: 1, price: 20000 }, { kind: 'entry', quantity: 2, price: 20001 },
      { kind: 'exit', quantity: 1, price: 20002 }, { kind: 'entry', quantity: 2, price: 20003 },
      { kind: 'exit', quantity: 4, price: 20004 },
    ];
    const session = scaledSession('NQ', 'long', thirds, null);
    expect(atLeg(session, 1).openAggregate?.weightedAverageEntryPrice).toBe(60002 / 3);
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(trade.weightedEntryPrice).toBe(100008 / 5);
    expect(trade.weightedExitPrice).toBe(100018 / 5);
    expect(trade.points).toBe(2);
    expect(trade.grossPL).toBe(200);
    expect(Number.isInteger(trade.grossPL)).toBe(true);
  });

  it('emits Numbers only at the derived projection boundary', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_A, 19995);
    const aggregate = atLeg(session, 1).openAggregate!;
    const [trade] = projectBacktestSession(session).closedTrades;
    for (const value of [
      aggregate.weightedAverageEntryPrice, aggregate.realizedGrossPL, aggregate.anchoredRisk,
      aggregate.totalEntryQuantity, aggregate.remainingQuantity,
      trade.weightedEntryPrice, trade.weightedExitPrice, trade.points, trade.ticks,
      trade.grossPL, trade.initialRisk, trade.rMultiple,
    ]) {
      expect(typeof value).toBe('number');
    }
    expect(JSON.parse(JSON.stringify(trade)).points).toBe(-2 / 3);
  });

  it('folds same-decision-time scale actions by canonical sequence order', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_A, 19995, 0);
    const projection = projectBacktestSession(session, SCALE_T0);
    expect(projection.visibleActions.map((action) => action.sequence)).toEqual([1, 2, 3, 4]);
    expect(projection.closedTrades).toHaveLength(1);
    expect(projection.closedTrades[0].grossPL).toBe(-40);
  });

  it('hides future scale actions behind the replay cursor without deleting them', () => {
    const session = scaledSession('NQ', 'long', EXAMPLE_A, 19995);
    const rewound = projectBacktestSession(session, SCALE_T0);
    expect(rewound.rewound).toBe(true);
    expect(rewound.visibleActions).toHaveLength(1);
    expect(rewound.openAggregate?.totalEntryQuantity).toBe(1);
    expect(rewound.closedTrades).toEqual([]);
    expect(session.actions).toHaveLength(4);
  });

  it('preserves every legacy open-position fact inside the aggregate projection', () => {
    const flat = createBacktestSession({
      sessionId: V18_OPEN_SESSION_ID,
      series: { root: 'NQ', expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
      progress: { cursorUtcMs: V18_OPEN_T0, displayTimeframe: '1m', speed: 1 },
      createdAt: V18_OPEN_CREATED_AT,
    });
    const open = appendBacktestAction(
      flat, V18_OPEN_ENTRY, { cursorUtcMs: V18_OPEN_T0, displayTimeframe: '1m', speed: 1 }, V18_OPEN_CLIENT_AT,
    );
    const projection = projectBacktestSession(open);
    const aggregate = projection.openAggregate!;

    expect(aggregate.tradeId).toBe(V18_OPEN_TRADE_ID);
    expect(aggregate.side).toBe('short');
    expect(aggregate.entries).toEqual([open.actions[0]]);
    expect(aggregate.entries[0]).toBe(open.actions[0]);
    expect(aggregate.entries[0].actionId).toBe(V18_OPEN_ENTRY_ID);
    expect(aggregate.entries[0].fill).toEqual(V18_OPEN_ENTRY.fill);
    expect(aggregate.exits).toEqual([]);
    expect(aggregate.totalEntryQuantity).toBe(5);
    expect(aggregate.totalExitedQuantity).toBe(0);
    expect(aggregate.remainingQuantity).toBe(5);
    expect(aggregate.weightedAverageEntryPrice).toBe(20100.75);
    expect(aggregate.realizedGrossPL).toBe(0);
    expect(aggregate.initialStopPrice).toBe(20125.25);
    expect(aggregate.anchoredRisk).toBe(2450);
    expect(projection.openPosition).toBe(aggregate.entries[0]);
    expect(open.status).toBe('active');
    expect(validateBacktestSession({ ...open, status: 'completed' } as BacktestSession)).toBe(false);
  });

  it('routes a structurally legacy one-Entry one-full-Exit episode through released Number semantics', () => {
    const legacy: readonly ScaleLeg[] = [
      { kind: 'entry', quantity: 1, price: 100 }, { kind: 'exit', quantity: 1, price: 100.123456789 },
    ];
    const session = scaledSession('NQ', 'long', legacy, 99);
    const [trade] = projectBacktestSession(session).closedTrades;
    expect(Object.is(trade.points, 0.12345678900000223)).toBe(true);
    expect(Object.is(trade.grossPL, 0.12345678900000223 * 20 * 1)).toBe(true);
    expect(trade.entries).toEqual([session.actions[0]]);
    expect(trade.exits).toEqual([session.actions[1]]);
    expect(trade.entry).toBe(session.actions[0]);
    expect(trade.exit).toBe(session.actions[1]);
    expect(trade.weightedEntryPrice).toBe(100);
    expect(trade.weightedExitPrice).toBe(100.123456789);
  });
});

const P2_SESSION_ID = '7c000000-0000-4000-8000-000000000001';
const P2_TRADE_A = '7c000000-0000-4000-8000-00000000000a';
const P2_TRADE_B = '7c000000-0000-4000-8000-00000000000b';
const P2_T0 = 1_712_700_000_000 - (1_712_700_000_000 % 60_000);
const P2_ISO = '2026-08-14T14:00:00.000Z';

interface P2Leg {
  kind: 'entry' | 'exit';
  quantity: number;
  price: number;
  tradeId?: string;
  side?: 'long' | 'short';
  initialStopPrice?: number | null;
}

const p2Session = (root: 'NQ' | 'ES' = 'NQ') => createBacktestSession({
  sessionId: P2_SESSION_ID, series: { root, expiryYear: 2026, expiryMonth: 9, timeframe: '1m' },
  progress: { cursorUtcMs: P2_T0, displayTimeframe: '1m', speed: 1 }, createdAt: P2_ISO,
});
const p2Action = (leg: P2Leg, index: number, decisionUtcMs = P2_T0 + index * 60_000): BacktestAction => {
  const base = {
    actionVersion: 1 as const,
    actionId: `7c000000-0000-4000-8000-1${String(index + 1).padStart(11, '0')}`,
    tradeId: leg.tradeId ?? P2_TRADE_A, sessionId: P2_SESSION_ID, sequence: index + 1,
    quantity: leg.quantity,
    fill: {
      decisionUtcMs, sourceBarStartUtcMs: decisionUtcMs - 60_000, sourceBarCloseUtcMs: decisionUtcMs,
      price: leg.price, basis: 'revealed_1m_close' as const,
    },
    clientCreatedAt: P2_ISO,
  };
  return leg.kind === 'entry'
    ? { ...base, kind: 'entry', side: leg.side ?? 'long', initialStopPrice: leg.initialStopPrice ?? null }
    : { ...base, kind: 'exit' };
};
const p2Append = (session: BacktestSession, leg: P2Leg, decisionUtcMs?: number) => {
  const index = session.actions.length;
  const decision = decisionUtcMs ?? P2_T0 + index * 60_000;
  return appendBacktestAction(session, p2Action(leg, index, decision),
    { cursorUtcMs: decision, displayTimeframe: '1m', speed: 1 }, P2_ISO);
};
const p2Build = (legs: readonly P2Leg[], root: 'NQ' | 'ES' = 'NQ') =>
  legs.reduce<BacktestSession>((session, leg) => p2Append(session, leg), p2Session(root));

describe('B2c Phase 2 — legal scaled transition language', () => {
  it('accepts a same-side second Entry under the same tradeId while open', () => {
    const scaled = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 3, price: 20001 },
    ]);
    expect(validateBacktestSession(scaled)).toBe(true);
    expect(scaled.actions).toHaveLength(2);
    expect(scaled.revision).toBe(3);
    const aggregate = projectBacktestSession(scaled).openAggregate!;
    expect(aggregate.tradeId).toBe(P2_TRADE_A);
    expect(aggregate.totalEntryQuantity).toBe(5);
    expect(aggregate.remainingQuantity).toBe(5);
    expect(aggregate.weightedAverageEntryPrice).toBe(100003 / 5);
  });

  it('accepts Entry 2 → Exit 1 as a partial exit that leaves the position open', () => {
    const partial = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20002 },
    ]);
    expect(validateBacktestSession(partial)).toBe(true);
    const projection = projectBacktestSession(partial);
    expect(projection.closedTrades).toEqual([]);
    expect(projection.openAggregate).toMatchObject({
      totalEntryQuantity: 2, totalExitedQuantity: 1, remainingQuantity: 1,
      weightedAverageEntryPrice: 20000, realizedGrossPL: 40,
    });
  });

  it('accepts repeated partial exits before the position is flat', () => {
    const repeated = p2Build([
      { kind: 'entry', quantity: 4, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 },
      { kind: 'exit', quantity: 2, price: 20002 },
    ]);
    expect(validateBacktestSession(repeated)).toBe(true);
    expect(projectBacktestSession(repeated).openAggregate).toMatchObject({
      totalExitedQuantity: 3, remainingQuantity: 1, realizedGrossPL: 100,
    });
  });

  it('accepts a same-side Entry after a partial Exit', () => {
    const reEntered = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20002 },
      { kind: 'entry', quantity: 3, price: 20001.25 },
    ]);
    expect(validateBacktestSession(reEntered)).toBe(true);
    expect(projectBacktestSession(reEntered).openAggregate).toMatchObject({
      totalEntryQuantity: 5, totalExitedQuantity: 1, remainingQuantity: 4,
      weightedAverageEntryPrice: 20000.9375,
    });
  });

  it('returns to Flat only when a final Exit equals the remaining quantity', () => {
    const flat = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 1, price: 20003 },
      { kind: 'exit', quantity: 1, price: 20004 }, { kind: 'exit', quantity: 2, price: 20005 },
    ]);
    expect(validateBacktestSession(flat)).toBe(true);
    const projection = projectBacktestSession(flat);
    expect(projection.openAggregate).toBeNull();
    expect(projection.openPosition).toBeNull();
    expect(projection.closedTrades).toHaveLength(1);
    expect(projection.closedTrades[0].quantity).toBe(3);
    expect(validateBacktestSession({ ...flat, status: 'completed' } as BacktestSession)).toBe(true);
  });

  it('accepts a full Long episode of Entry → Scale In → Partial Exit → Final Exit', () => {
    const long = p2Build([
      { kind: 'entry', quantity: 1, price: 20000, initialStopPrice: 19995 },
      { kind: 'entry', quantity: 2, price: 20001.5, initialStopPrice: 19995 },
      { kind: 'exit', quantity: 1, price: 20003 },
      { kind: 'exit', quantity: 2, price: 19999 },
    ]);
    expect(validateBacktestSession(long)).toBe(true);
    const [trade] = projectBacktestSession(long).closedTrades;
    expect(trade.grossPL).toBe(-40);
    expect(trade.initialRisk).toBe(360);
    expect(trade.rMultiple).toBe(-1 / 9);
  });

  it('accepts the Short equivalent of Entry → Scale In → Partial Exit → Final Exit', () => {
    const short = p2Build([
      { kind: 'entry', quantity: 1, price: 20010, side: 'short', initialStopPrice: 20015 },
      { kind: 'entry', quantity: 1, price: 20008.5, side: 'short', initialStopPrice: 20015 },
      { kind: 'exit', quantity: 1, price: 20006 },
      { kind: 'exit', quantity: 1, price: 20012 },
    ]);
    expect(validateBacktestSession(short)).toBe(true);
    const [trade] = projectBacktestSession(short).closedTrades;
    expect(trade.side).toBe('short');
    expect(trade.grossPL).toBe(10);
    expect(trade.initialRisk).toBe(230);
    expect(trade.rMultiple).toBe(1 / 23);
  });

  it('accepts a new tradeId for a fresh episode after returning Flat', () => {
    const reopened = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 },
      { kind: 'exit', quantity: 1, price: 20002 }, { kind: 'entry', quantity: 1, price: 20003, tradeId: P2_TRADE_B },
    ]);
    expect(validateBacktestSession(reopened)).toBe(true);
    expect(projectBacktestSession(reopened).closedTrades).toHaveLength(1);
    expect(projectBacktestSession(reopened).openAggregate?.tradeId).toBe(P2_TRADE_B);
  });

  it('validates and folds multiple scaled actions sharing one decision timestamp by sequence', () => {
    let session = p2Session();
    for (const leg of [
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 2, price: 20002 },
      { kind: 'exit', quantity: 1, price: 20004 }, { kind: 'exit', quantity: 3, price: 20005 },
    ] as const) session = p2Append(session, leg, P2_T0);
    expect(validateBacktestSession(session)).toBe(true);
    expect(session.actions.map((action) => action.fill.decisionUtcMs)).toEqual([P2_T0, P2_T0, P2_T0, P2_T0]);
    const projection = projectBacktestSession(session, P2_T0);
    expect(projection.visibleActions.map((action) => action.sequence)).toEqual([1, 2, 3, 4]);
    expect(projection.closedTrades).toHaveLength(1);
    expect(projection.closedTrades[0].quantity).toBe(4);
  });

  it('projects every representative validated B2c history deterministically', () => {
    const histories: readonly (readonly P2Leg[])[] = [
      [{ kind: 'entry', quantity: 2, price: 20000 }],
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 }],
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 2, price: 20002 },
        { kind: 'exit', quantity: 3, price: 20004 }, { kind: 'exit', quantity: 1, price: 20005 }],
    ];
    for (const legs of histories) {
      const session = p2Build(legs);
      expect(validateBacktestSession(session)).toBe(true);
      const projection = projectBacktestSession(session);
      expect(projection.visibleActions).toHaveLength(legs.length);
      const aggregate = projection.openAggregate;
      if (aggregate !== null) {
        expect(aggregate.remainingQuantity).toBe(aggregate.totalEntryQuantity - aggregate.totalExitedQuantity);
        expect(aggregate.remainingQuantity).toBeGreaterThan(0);
      } else {
        expect(projection.closedTrades).toHaveLength(1);
      }
    }
  });
});

describe('B2c Phase 2 — rejected transitions', () => {
  const openTwo = () => p2Build([{ kind: 'entry', quantity: 2, price: 20000, initialStopPrice: 19995 }]);
  const expectRejected = (session: BacktestSession, leg: P2Leg) => {
    const before = session.actions.length;
    expect(() => p2Append(session, leg)).toThrow();
    expect(session.actions).toHaveLength(before);
    expect(session.revision).toBe(before + 1);
  };

  it('rejects an Exit larger than the remaining quantity, before and after a partial Exit', () => {
    expectRejected(openTwo(), { kind: 'exit', quantity: 3, price: 20001 });
    const partial = p2Build([
      { kind: 'entry', quantity: 2, price: 20000, initialStopPrice: 19995 },
      { kind: 'exit', quantity: 1, price: 20001 },
    ]);
    expect(projectBacktestSession(partial).openAggregate?.remainingQuantity).toBe(1);
    expectRejected(partial, { kind: 'exit', quantity: 2, price: 20002 });
  });

  it('rejects an opposite-side Scale In', () => {
    expectRejected(openTwo(), { kind: 'entry', quantity: 1, price: 20001, side: 'short', initialStopPrice: 19995 });
  });

  it('rejects an Entry or Exit carrying a different tradeId while open', () => {
    expectRejected(openTwo(), { kind: 'entry', quantity: 1, price: 20001, tradeId: P2_TRADE_B, initialStopPrice: 19995 });
    expectRejected(openTwo(), { kind: 'exit', quantity: 1, price: 20001, tradeId: P2_TRADE_B });
  });

  it('rejects an Exit while Flat', () => {
    expectRejected(p2Session(), { kind: 'exit', quantity: 1, price: 20000 });
  });

  it('rejects zero, negative, fractional, and unsafe quantities on scaled actions', () => {
    for (const quantity of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectRejected(openTwo(), { kind: 'entry', quantity, price: 20001, initialStopPrice: 19995 });
      expectRejected(openTwo(), { kind: 'exit', quantity, price: 20001 });
    }
  });

  it('rejects reuse of a permanently closed tradeId', () => {
    const flat = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 },
      { kind: 'exit', quantity: 1, price: 20002 },
    ]);
    expect(projectBacktestSession(flat).openAggregate).toBeNull();
    expectRejected(flat, { kind: 'entry', quantity: 1, price: 20003, tradeId: P2_TRADE_A });
  });

  it('rejects a later Entry that changes, removes, or introduces the common stop', () => {
    expectRejected(openTwo(), { kind: 'entry', quantity: 1, price: 20001, initialStopPrice: 19994 });
    expectRejected(openTwo(), { kind: 'entry', quantity: 1, price: 20001, initialStopPrice: null });
    const noStop = p2Build([{ kind: 'entry', quantity: 2, price: 20000, initialStopPrice: null }]);
    expectRejected(noStop, { kind: 'entry', quantity: 1, price: 20001, initialStopPrice: 19995 });
  });

  it('rejects a later Entry on the invalid risk side of the common stop', () => {
    expectRejected(openTwo(), { kind: 'entry', quantity: 1, price: 19990, initialStopPrice: 19995 });
    const shortOpen = p2Build([{ kind: 'entry', quantity: 2, price: 20010, side: 'short', initialStopPrice: 20015 }]);
    expectRejected(shortOpen, { kind: 'entry', quantity: 1, price: 20020, side: 'short', initialStopPrice: 20015 });
  });

  it('rejects a completed session that still has remaining quantity', () => {
    const stillOpen = p2Build([
      { kind: 'entry', quantity: 3, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 },
    ]);
    expect(projectBacktestSession(stillOpen).openAggregate?.remainingQuantity).toBe(2);
    expect(validateBacktestSession({ ...stillOpen, status: 'completed' } as BacktestSession)).toBe(false);
    expect(() => p2Append({ ...stillOpen, status: 'completed' } as BacktestSession,
      { kind: 'exit', quantity: 2, price: 20002 })).toThrow('completed');
  });

  // These craft whole histories and validate them directly, which is the path
  // `parseEnvelope` uses on stored bytes. The append-path tests above cannot
  // cover it: a hostile or corrupt envelope never goes through append.
  it('rejects illegal crafted histories at the stored-bytes validation boundary', () => {
    const craft = (legs: readonly P2Leg[]): BacktestSession => ({
      ...p2Session(),
      cursorUtcMs: P2_T0 + (legs.length - 1) * 60_000,
      revision: legs.length + 1,
      actions: legs.map((leg, index) => p2Action(leg, index)),
    });
    const cases: readonly (readonly P2Leg[])[] = [
      // over-Exit by one
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 3, price: 20001 }],
      // over-Exit measured after a prior partial Exit
      [{ kind: 'entry', quantity: 3, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 },
        { kind: 'exit', quantity: 3, price: 20002 }],
      // opposite-side Scale In
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 1, price: 20001, side: 'short' }],
      // Entry under a different tradeId while open
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 1, price: 20001, tradeId: P2_TRADE_B }],
      // Exit under a different tradeId while open
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001, tradeId: P2_TRADE_B }],
      // Exit while flat
      [{ kind: 'exit', quantity: 1, price: 20000 }],
      // common stop changed by a later Entry
      [{ kind: 'entry', quantity: 2, price: 20000, initialStopPrice: 19995 },
        { kind: 'entry', quantity: 1, price: 20001, initialStopPrice: 19994 }],
      // common stop removed by a later Entry
      [{ kind: 'entry', quantity: 2, price: 20000, initialStopPrice: 19995 },
        { kind: 'entry', quantity: 1, price: 20001, initialStopPrice: null }],
      // common stop introduced into a no-stop episode
      [{ kind: 'entry', quantity: 2, price: 20000, initialStopPrice: null },
        { kind: 'entry', quantity: 1, price: 20001, initialStopPrice: 19995 }],
      // later Long Entry filled through the common stop
      [{ kind: 'entry', quantity: 2, price: 20000, initialStopPrice: 19995 },
        { kind: 'entry', quantity: 1, price: 19990, initialStopPrice: 19995 }],
      // later Short Entry filled through the common stop
      [{ kind: 'entry', quantity: 2, price: 20010, side: 'short', initialStopPrice: 20015 },
        { kind: 'entry', quantity: 1, price: 20020, side: 'short', initialStopPrice: 20015 }],
      // reuse of a permanently closed tradeId
      [{ kind: 'entry', quantity: 1, price: 20000 }, { kind: 'exit', quantity: 1, price: 20001 },
        { kind: 'entry', quantity: 1, price: 20002 }],
      // zero and fractional quantities
      [{ kind: 'entry', quantity: 0, price: 20000 }],
      [{ kind: 'entry', quantity: 2, price: 20000 }, { kind: 'exit', quantity: 1.5, price: 20001 }],
    ];
    for (const legs of cases) {
      expect(validateBacktestSession(craft(legs)), JSON.stringify(legs)).toBe(false);
    }
  });

  it('rejects a crafted completed session whose history still has remaining quantity', () => {
    const stillOpen: BacktestSession = {
      ...p2Session(), status: 'completed', revision: 3,
      cursorUtcMs: P2_T0 + 60_000,
      actions: [
        p2Action({ kind: 'entry', quantity: 3, price: 20000 }, 0),
        p2Action({ kind: 'exit', quantity: 1, price: 20001 }, 1),
      ],
    };
    expect(validateBacktestSession(stillOpen)).toBe(false);
    expect(validateBacktestSession({ ...stillOpen, status: 'active' })).toBe(true);
  });

  it('rejects sequence corruption and duplicate action IDs across scaled histories', () => {
    const scaled = p2Build([
      { kind: 'entry', quantity: 2, price: 20000 }, { kind: 'entry', quantity: 1, price: 20001 },
    ]);
    expect(validateBacktestSession({ ...scaled, actions: [scaled.actions[1], scaled.actions[0]] })).toBe(false);
    expect(validateBacktestSession({
      ...scaled, actions: [scaled.actions[0], { ...scaled.actions[0], sequence: 2 }],
    })).toBe(false);
  });
});
