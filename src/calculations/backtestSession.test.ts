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

  it('rejects scaling, exit while flat, partial exit, and reversal-like overlap', () => {
    expect(() => appendBacktestAction(session(), exit(), progress(), ISO)).toThrow('invalid');
    const open = appendBacktestAction(session(), entry(), progress(), ISO);
    expect(() => appendBacktestAction(open, entry({ actionId: EXIT_ID, sequence: 2 }), progress(), ISO)).toThrow('invalid');
    expect(() => appendBacktestAction(open, exit({ quantity: 1 }), progress(T0 + 60_000), ISO)).toThrow('invalid');
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
