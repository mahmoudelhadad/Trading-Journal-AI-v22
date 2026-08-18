/**
 * calculations/replayWorkspace.test.ts
 *
 * B2d Phase 1 — pure workspace calculations.
 *
 * These exercise the real production module. No React environment is required:
 * every function under test is a pure value transformation.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_NAV_HISTORY, NAV_HISTORY_DEPTH, canRedoNav, canUndoNav, isStepBackEnabled,
  isTradingMutationDisabled, lastRevealedClose, parseEntryIntent, parseInitialStop,
  parseOrderQuantity, pushNavState, redoNav, roundPriceToTick, selectBarTargetCursor, undoNav,
  type NavHistory, type TradingMutationState, type WorkspaceNavState,
} from './replayWorkspace.js';
import { getFuturesInstrument } from '@constants/futuresInstruments.js';
import { REPLAY_TIMEFRAME_MS } from './htfDerivation.js';
import { MINUTE_MS, type HistoricalBar } from '@apptypes/marketData.js';
import type { ReplaySnapshot, ReplayTimeframe } from '@apptypes/replay.js';

const T0 = Date.parse('2016-03-01T00:00:00Z');
const ALL_FUTURE = Number.MAX_SAFE_INTEGER;
const TIMEFRAMES: ReplayTimeframe[] = ['1m', '5m', '15m', '1h'];
const bar = (t: number, c: number): HistoricalBar => ({ t, o: c - 1, h: c + 1, l: c - 2, c, v: 3 });
const nav = (cursorUtcMs: number, displayTimeframe: ReplayTimeframe = '1m'): WorkspaceNavState =>
  ({ cursorUtcMs, displayTimeframe });

function snapshotOf(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  return {
    series: { root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' },
    nowUtcMs: T0 + 10 * MINUTE_MS, speed: 1, timeframe: '1m', playState: 'paused',
    bars: [bar(T0, 100)],
    availability: {
      available: true, observedFirstUtcMs: T0, observedLastUtcMs: T0 + 600_000,
      observedDays: ['2016-03-01'],
    },
    coverageStartUtcMs: T0, coverageEndUtcMs: T0 + 2 * 86_400_000,
    loading: false, importing: false, error: null, canonicalBarrier: null,
    ...overrides,
  };
}

function tradingState(overrides: Partial<TradingMutationState> = {}): TradingMutationState {
  return {
    pending: false, safetyBlocked: false,
    activeSession: { status: 'active' }, projection: { rewound: false },
    ...overrides,
  };
}

// ─── Undo / Redo ──────────────────────────────────────────────

describe('replayWorkspace — workspace navigation history', () => {
  it('starts empty and offers no transition', () => {
    expect(canUndoNav(EMPTY_NAV_HISTORY)).toBe(false);
    expect(canRedoNav(EMPTY_NAV_HISTORY)).toBe(false);
    expect(undoNav(EMPTY_NAV_HISTORY, nav(T0))).toBeNull();
    expect(redoNav(EMPTY_NAV_HISTORY, nav(T0))).toBeNull();
  });

  it('pushes the state navigated away from', () => {
    const history = pushNavState(EMPTY_NAV_HISTORY, nav(T0));
    expect(canUndoNav(history)).toBe(true);
    expect(canRedoNav(history)).toBe(false);
    expect(history.undo).toEqual([nav(T0)]);
  });

  it('undoes to the pushed state and makes the current state redoable', () => {
    const history = pushNavState(EMPTY_NAV_HISTORY, nav(T0, '5m'));
    const undone = undoNav(history, nav(T0 + MINUTE_MS, '1m'))!;
    expect(undone.state).toEqual(nav(T0, '5m'));
    expect(canUndoNav(undone.history)).toBe(false);
    expect(canRedoNav(undone.history)).toBe(true);

    const redone = redoNav(undone.history, undone.state)!;
    expect(redone.state).toEqual(nav(T0 + MINUTE_MS, '1m'));
    expect(canUndoNav(redone.history)).toBe(true);
    expect(canRedoNav(redone.history)).toBe(false);
  });

  it('walks several navigation states in both directions', () => {
    let history: NavHistory = EMPTY_NAV_HISTORY;
    history = pushNavState(history, nav(T0, '1m'));
    history = pushNavState(history, nav(T0 + MINUTE_MS, '5m'));
    history = pushNavState(history, nav(T0 + 2 * MINUTE_MS, '15m'));

    const first = undoNav(history, nav(T0 + 3 * MINUTE_MS, '1h'))!;
    expect(first.state).toEqual(nav(T0 + 2 * MINUTE_MS, '15m'));
    const second = undoNav(first.history, first.state)!;
    expect(second.state).toEqual(nav(T0 + MINUTE_MS, '5m'));
    const third = undoNav(second.history, second.state)!;
    expect(third.state).toEqual(nav(T0, '1m'));
    expect(undoNav(third.history, third.state)).toBeNull();

    const back = redoNav(third.history, third.state)!;
    expect(back.state).toEqual(nav(T0 + MINUTE_MS, '5m'));
  });

  it('clears the redo branch on a new push', () => {
    const history = pushNavState(EMPTY_NAV_HISTORY, nav(T0));
    const undone = undoNav(history, nav(T0 + MINUTE_MS))!;
    expect(canRedoNav(undone.history)).toBe(true);
    const pushed = pushNavState(undone.history, nav(T0 + 5 * MINUTE_MS));
    expect(canRedoNav(pushed)).toBe(false);
    expect(redoNav(pushed, nav(T0 + 6 * MINUTE_MS))).toBeNull();
  });

  it('caps depth at 50 and discards the oldest entry', () => {
    let history: NavHistory = EMPTY_NAV_HISTORY;
    for (let index = 0; index < NAV_HISTORY_DEPTH + 10; index += 1) {
      history = pushNavState(history, nav(T0 + index * MINUTE_MS));
    }
    expect(NAV_HISTORY_DEPTH).toBe(50);
    expect(history.undo).toHaveLength(NAV_HISTORY_DEPTH);
    expect(history.undo[0]).toEqual(nav(T0 + 10 * MINUTE_MS));
    expect(history.undo[NAV_HISTORY_DEPTH - 1]).toEqual(nav(T0 + (NAV_HISTORY_DEPTH + 9) * MINUTE_MS));
  });

  it('stores only a cursor and a display timeframe', () => {
    // Structural proof that no execution, session or repository revision can be
    // represented, so Undo cannot rewrite simulated trading history.
    const history = pushNavState(EMPTY_NAV_HISTORY, nav(T0, '5m'));
    expect(Object.keys(history.undo[0]).sort()).toEqual(['cursorUtcMs', 'displayTimeframe']);
  });

  it('never mutates the history it was given', () => {
    const history = pushNavState(EMPTY_NAV_HISTORY, nav(T0));
    const before = JSON.stringify(history);
    pushNavState(history, nav(T0 + MINUTE_MS));
    undoNav(history, nav(T0 + MINUTE_MS));
    expect(JSON.stringify(history)).toBe(before);
    expect(EMPTY_NAV_HISTORY.undo).toHaveLength(0);
    expect(EMPTY_NAV_HISTORY.redo).toHaveLength(0);
  });
});

// ─── Select Bar ───────────────────────────────────────────────

describe('replayWorkspace — Select Bar target', () => {
  it.each(TIMEFRAMES)('targets the selected bar close at %s', (timeframe) => {
    const barStart = T0 + 3_600_000;
    const cursor = T0 + 2 * 3_600_000;
    expect(selectBarTargetCursor(barStart, timeframe, cursor))
      .toBe(barStart + REPLAY_TIMEFRAME_MS[timeframe]);
  });

  it('uses the released bucket authority, not a new constant', () => {
    expect(selectBarTargetCursor(T0, '5m', ALL_FUTURE)).toBe(T0 + 300_000);
    expect(selectBarTargetCursor(T0, '15m', ALL_FUTURE)).toBe(T0 + 900_000);
    expect(selectBarTargetCursor(T0, '1h', ALL_FUTURE)).toBe(T0 + 3_600_000);
    expect(selectBarTargetCursor(T0, '1m', ALL_FUTURE)).toBe(T0 + MINUTE_MS);
  });

  it('clamps to the current cursor so selection can never look ahead', () => {
    const barStart = T0 + 3_600_000;
    const cursor = barStart + 10 * MINUTE_MS;
    // Only revealed bars render, so this clamp is defence in depth.
    expect(selectBarTargetCursor(barStart, '1h', cursor)).toBe(cursor);
    expect(selectBarTargetCursor(barStart, '1m', cursor)).toBe(barStart + MINUTE_MS);
  });

  it('is idempotent when the selected bar is already the current one', () => {
    const barStart = T0 + 5 * MINUTE_MS;
    const cursor = barStart + MINUTE_MS;
    expect(selectBarTargetCursor(barStart, '1m', cursor)).toBe(cursor);
  });
});

// ─── Last revealed close ──────────────────────────────────────

describe('replayWorkspace — last revealed close', () => {
  it('is null when nothing is rendered', () => {
    expect(lastRevealedClose([])).toBeNull();
  });

  it('reports the only rendered close', () => {
    expect(lastRevealedClose([bar(T0, 20000.25)])).toBe(20000.25);
  });

  it('reports the newest rendered close only', () => {
    expect(lastRevealedClose([
      bar(T0, 20000), bar(T0 + MINUTE_MS, 20001.5), bar(T0 + 2 * MINUTE_MS, 20002.75),
    ])).toBe(20002.75);
  });

  it('reads the close, never the open, high or low', () => {
    const only = bar(T0, 20000);
    expect(lastRevealedClose([only])).toBe(only.c);
    expect(lastRevealedClose([only])).not.toBe(only.o);
    expect(lastRevealedClose([only])).not.toBe(only.h);
    expect(lastRevealedClose([only])).not.toBe(only.l);
  });
});

// ─── Shared trading-mutation predicate ────────────────────────

describe('replayWorkspace — trading mutation predicate', () => {
  it('allows an active, hydrated, non-rewound session', () => {
    expect(isTradingMutationDisabled(tradingState())).toBe(false);
  });

  it.each([
    ['a pending command', { pending: true }],
    ['a safety block', { safetyBlocked: true }],
    ['no active session', { activeSession: null }],
    ['a completed session', { activeSession: { status: 'completed' as const } }],
    ['a rewound projection', { projection: { rewound: true } }],
  ])('disables trading for %s', (_label, override) => {
    expect(isTradingMutationDisabled(tradingState(override))).toBe(true);
  });

  it('allows trading when the projection is absent but the session is active', () => {
    // Mirrors the released panel expression exactly: `projection?.rewound === true`.
    expect(isTradingMutationDisabled(tradingState({ projection: null }))).toBe(false);
  });

  it('does not consider chart or overlay state', () => {
    // Trading validity and chart-data validity are separate contracts, so a
    // loading or import-barrier chart must not disable trading through here.
    const keys = Object.keys(tradingState()).sort();
    expect(keys).toEqual(['activeSession', 'pending', 'projection', 'safetyBlocked']);
  });
});

// ─── Step Backward coarse enablement bound ────────────────────

describe('replayWorkspace — Step Backward coarse enablement bound', () => {
  it('is enabled in a normal available paused state', () => {
    expect(isStepBackEnabled(snapshotOf(), false)).toBe(true);
  });

  it.each([
    ['loading', { loading: true }],
    ['importing', { importing: true }],
    ['an action barrier', { canonicalBarrier: 'action' as const }],
    ['a completion barrier', { canonicalBarrier: 'completion' as const }],
    ['no availability', { availability: { available: false as const } }],
  ])('is disabled while %s', (_label, override) => {
    expect(isStepBackEnabled(snapshotOf(override), false)).toBe(false);
  });

  it('is disabled while safety-blocked', () => {
    expect(isStepBackEnabled(snapshotOf(), true)).toBe(false);
  });

  it('is disabled at or below the first available bar close', () => {
    expect(isStepBackEnabled(snapshotOf({ nowUtcMs: T0 }), false)).toBe(false);
    expect(isStepBackEnabled(snapshotOf({ nowUtcMs: T0 + MINUTE_MS }), false)).toBe(false);
    expect(isStepBackEnabled(snapshotOf({ nowUtcMs: T0 + MINUTE_MS + 1 }), false)).toBe(true);
  });

  it('performs no previous-bar search', () => {
    // The bound is deliberately coarse: it ignores the bar set entirely, so it
    // cannot become a second step-back algorithm. A press that passes it may
    // still receive a deterministic runtime no-op at the true boundary.
    expect(isStepBackEnabled(snapshotOf({ bars: [] }), false)).toBe(true);
    expect(isStepBackEnabled(snapshotOf({ bars: [bar(T0, 1)] }), false)).toBe(true);
  });
});

// ─── B2d Phase 5 — shared order-input parsing ─────────────────

describe('parseOrderQuantity', () => {
  it('accepts whole positive contract counts', () => {
    expect(parseOrderQuantity('1')).toBe(1);
    expect(parseOrderQuantity('4')).toBe(4);
    expect(parseOrderQuantity(' 7 ')).toBe(7);
  });

  it('rejects zero, negative, fractional, blank and non-numeric text', () => {
    for (const text of ['0', '-1', '-3', '1.5', '0.25', '', '   ', 'abc', 'x', 'NaN', 'Infinity']) {
      expect(parseOrderQuantity(text), text).toBeNull();
    }
  });
});

describe('parseInitialStop', () => {
  it('treats blank as a valid absent stop', () => {
    expect(parseInitialStop('')).toEqual({ ok: true, price: null });
    expect(parseInitialStop('   ')).toEqual({ ok: true, price: null });
  });

  it('accepts finite positive prices, including fractional ticks', () => {
    expect(parseInitialStop('19995')).toEqual({ ok: true, price: 19995 });
    expect(parseInitialStop('19995.25')).toEqual({ ok: true, price: 19995.25 });
  });

  it('rejects zero, negative and non-numeric text', () => {
    for (const text of ['0', '-1', 'abc', 'NaN', 'Infinity', '1,000']) {
      expect(parseInitialStop(text), text).toEqual({ ok: false });
    }
  });
});

describe('parseEntryIntent', () => {
  it('carries the exact arguments a flat entry submits', () => {
    expect(parseEntryIntent('3', '19995')).toEqual({ quantity: 3, initialStopPrice: 19995 });
    expect(parseEntryIntent('2', '')).toEqual({ quantity: 2, initialStopPrice: null });
  });

  it('is null whenever either field is invalid — the released entry gate', () => {
    expect(parseEntryIntent('0', '19995')).toBeNull();
    expect(parseEntryIntent('1.5', '')).toBeNull();
    expect(parseEntryIntent('', '')).toBeNull();
    expect(parseEntryIntent('3', '-5')).toBeNull();
    expect(parseEntryIntent('3', 'abc')).toBeNull();
  });
});

describe('roundPriceToTick', () => {
  const NQ_TICK = getFuturesInstrument('NQ').tickSize;

  it('snaps an arbitrary clicked price to the nearest tick', () => {
    expect(roundPriceToTick(20000.13, NQ_TICK)).toBe(20000.25);   // .13 is nearer .25 than .00
    expect(roundPriceToTick(20000.12, NQ_TICK)).toBe(20000);      // .12 is nearer .00
    expect(roundPriceToTick(20000.375, NQ_TICK)).toBe(20000.5);   // exact half rounds up
    expect(roundPriceToTick(19995, NQ_TICK)).toBe(19995);
  });

  it('erases binary floating residue so the text parses back exactly', () => {
    const rounded = roundPriceToTick(19999.999999999996, NQ_TICK)!;
    expect(rounded).toBe(20000);
    expect(String(rounded)).toBe('20000');
    expect(Number(String(rounded))).toBe(rounded);
    const fractional = roundPriceToTick(20000.2499999999, NQ_TICK)!;
    expect(String(fractional)).toBe('20000.25');
    expect(Number(String(fractional))).toBe(fractional);
  });

  it('produces prices the released tick-alignment convention accepts', () => {
    // `backtestSession.isTickAligned`: price / tickSize must be a safe integer.
    for (const raw of [20000.13, 19987.6, 21042.7431, 20000.999]) {
      const rounded = roundPriceToTick(raw, NQ_TICK)!;
      expect(Number.isSafeInteger(rounded / NQ_TICK), String(raw)).toBe(true);
    }
  });

  it('rejects non-finite prices, non-positive tick sizes and non-positive results', () => {
    expect(roundPriceToTick(Number.NaN, NQ_TICK)).toBeNull();
    expect(roundPriceToTick(Number.POSITIVE_INFINITY, NQ_TICK)).toBeNull();
    expect(roundPriceToTick(20000, 0)).toBeNull();
    expect(roundPriceToTick(20000, -0.25)).toBeNull();
    expect(roundPriceToTick(20000, Number.NaN)).toBeNull();
    expect(roundPriceToTick(0, NQ_TICK)).toBeNull();
    expect(roundPriceToTick(-20000, NQ_TICK)).toBeNull();
  });

  it('works for a whole-number tick size', () => {
    expect(roundPriceToTick(101.4, 1)).toBe(101);
    expect(roundPriceToTick(101.6, 1)).toBe(102);
  });
});
