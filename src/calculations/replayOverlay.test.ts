/**
 * calculations/replayOverlay.test.ts
 *
 * B2d Phase 1 — exercises the REAL production overlay module.
 *
 * Phase 0 characterized the released INPUT contracts with test-local anchor
 * arithmetic because `replayOverlay.ts` did not exist. That local arithmetic is
 * retired: every anchor now comes from the production `markerAnchorUtcMs`, and
 * every behavioural assertion calls `resolveOverlayEligibility` /
 * `deriveReplayOverlay`. The released input-contract sections are retained
 * because they freeze facts the production module depends on but does not own.
 */
import { describe, expect, it } from 'vitest';
import {
  appendBacktestAction, createBacktestSession, projectBacktestSession,
  sameSessionSeries, validateExecutionFill,
} from './backtestSession.js';
import { REPLAY_TIMEFRAME_MS, deriveReplayBars } from './htfDerivation.js';
import {
  EMPTY_OVERLAY, deriveReplayOverlay, markerAnchorUtcMs, resolveOverlayEligibility,
  type OverlayEligibility,
} from './replayOverlay.js';
import { MINUTE_MS, type HistoricalBar } from '@apptypes/marketData.js';
import type {
  BacktestAction, BacktestSession, BacktestSessionProjection, BacktestSessionSeries, ExecutionFill,
} from '@apptypes/backtestSession.js';
import type { ReplaySnapshot, ReplayTimeframe } from '@apptypes/replay.js';

const SID = '11111111-1111-4111-8111-111111111111';
const TID = '33333333-3333-4333-8333-333333333333';
const TID2 = '55555555-5555-4555-8555-555555555555';
const ISO = '2026-08-14T12:00:00.000Z';
const SERIES: BacktestSessionSeries = { root: 'NQ', expiryYear: 2016, expiryMonth: 3, timeframe: '1m' };
/** UTC midnight, so every supported bucket boundary aligns with the origin. */
const T0 = Date.parse('2016-03-01T00:00:00Z');
const TIMEFRAMES: ReplayTimeframe[] = ['1m', '5m', '15m', '1h'];
const ALL = Number.MAX_SAFE_INTEGER;
const ELIGIBLE: OverlayEligibility = { eligible: true };
const INELIGIBLE: OverlayEligibility = { eligible: false };

const bar = (t: number, p: number): HistoricalBar => ({ t, o: p, h: p, l: p, c: p, v: 1 });

interface Leg {
  kind: 'entry' | 'exit';
  quantity: number;
  price: number;
  /** Offset of the SOURCE BAR START from T0, in whole canonical minutes. */
  sourceMinute: number;
  side?: 'long' | 'short';
  stop?: number | null;
  /** A new flat-to-flat episode needs a fresh tradeId; a closed one is never reused. */
  tradeId?: string;
}

/**
 * Builds a session through the released append path only. The fill is shaped
 * exactly as `replayRuntime.beginExecutionCommand` shapes it: the decision
 * instant is the source bar's CLOSE, one canonical minute after its start.
 */
function build(legs: readonly Leg[]): BacktestSession {
  return legs.reduce<BacktestSession>((session, leg, index) => {
    const sourceBarStartUtcMs = T0 + leg.sourceMinute * MINUTE_MS;
    const decisionUtcMs = sourceBarStartUtcMs + MINUTE_MS;
    const fill: ExecutionFill = {
      decisionUtcMs,
      sourceBarStartUtcMs,
      sourceBarCloseUtcMs: sourceBarStartUtcMs + MINUTE_MS,
      price: leg.price,
      basis: 'revealed_1m_close',
    };
    const base = {
      actionVersion: 1 as const,
      actionId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
      tradeId: leg.tradeId ?? TID, sessionId: SID, sequence: index + 1, quantity: leg.quantity,
      fill, clientCreatedAt: ISO,
    };
    const action: BacktestAction = leg.kind === 'entry'
      ? { ...base, kind: 'entry', side: leg.side ?? 'long', initialStopPrice: leg.stop ?? null }
      : { ...base, kind: 'exit' };
    return appendBacktestAction(session, action,
      { cursorUtcMs: decisionUtcMs, displayTimeframe: '1m', speed: 1 }, ISO);
  }, createBacktestSession({
    sessionId: SID, series: SERIES,
    progress: { cursorUtcMs: T0, displayTimeframe: '1m', speed: 1 }, createdAt: ISO,
  }));
}

/** Entry 2 @20000 → Scale In 3 @20001.25 → Partial Exit 1 → Final Exit 4. */
const SCALED = build([
  { kind: 'entry', quantity: 2, price: 20000, sourceMinute: 0, stop: 19995 },
  { kind: 'entry', quantity: 3, price: 20001.25, sourceMinute: 6, stop: 19995 },
  { kind: 'exit', quantity: 1, price: 20005, sourceMinute: 19 },
  { kind: 'exit', quantity: 4, price: 20010, sourceMinute: 69 },
]);

const SHORT = build([
  { kind: 'entry', quantity: 2, price: 20000, sourceMinute: 0, side: 'short', stop: 20005 },
  { kind: 'entry', quantity: 3, price: 19998.75, sourceMinute: 6, side: 'short', stop: 20005 },
  { kind: 'exit', quantity: 1, price: 19995, sourceMinute: 19 },
  { kind: 'exit', quantity: 4, price: 19990, sourceMinute: 69 },
]);

/** Rendered bucket times produced by the RELEASED derivation for given minutes. */
function renderedTimes(minutes: readonly number[], timeframe: ReplayTimeframe): ReadonlySet<number> {
  const bars = minutes.map((minute) => bar(T0 + minute * MINUTE_MS, 100 + minute));
  return new Set(deriveReplayBars(bars, timeframe).map((derived) => derived.t));
}

const ALL_MINUTES = [0, 6, 19, 60, 69, 70];
const RENDERED_1M = renderedTimes(ALL_MINUTES, '1m');

const overlayOf = (
  session: BacktestSession, cursor = ALL, timeframe: ReplayTimeframe = '1m',
  rendered: ReadonlySet<number> = RENDERED_1M,
) => deriveReplayOverlay(ELIGIBLE, projectBacktestSession(session, cursor), timeframe, rendered);

const classesOf = (session: BacktestSession, cursor = ALL) =>
  overlayOf(session, cursor).markers.map((marker) => marker.klass);

function snapshotOf(overrides: Partial<ReplaySnapshot> = {}): ReplaySnapshot {
  return {
    series: { ...SERIES },
    nowUtcMs: T0, speed: 1, timeframe: '1m', playState: 'paused',
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

// ─── Released input contracts (frozen in Phase 0, retained) ───

describe('replayOverlay input contract — execution marker anchor', () => {
  it('exposes a persisted canonical 1m source-bar start on every action', () => {
    expect(SCALED.actions).toHaveLength(4);
    for (const action of SCALED.actions) {
      expect(validateExecutionFill(action.fill)).toBe(true);
      expect(action.fill.sourceBarCloseUtcMs).toBe(action.fill.sourceBarStartUtcMs + MINUTE_MS);
      expect(action.fill.sourceBarCloseUtcMs).toBeLessThanOrEqual(action.fill.decisionUtcMs);
      expect(action.fill.decisionUtcMs - action.fill.sourceBarCloseUtcMs).toBeLessThan(MINUTE_MS);
    }
  });

  it('never lets the decision time stand in for the source-bar start', () => {
    for (const action of SCALED.actions) {
      expect(action.fill.decisionUtcMs - action.fill.sourceBarStartUtcMs).toBe(MINUTE_MS);
    }
    expect(SCALED.actions.map((action) => action.fill.sourceBarStartUtcMs))
      .toEqual([T0, T0 + 6 * MINUTE_MS, T0 + 19 * MINUTE_MS, T0 + 69 * MINUTE_MS]);
  });

  it('rejects a fill whose source bar is not exactly one canonical minute', () => {
    const valid = SCALED.actions[0].fill;
    expect(validateExecutionFill({ ...valid, sourceBarCloseUtcMs: valid.sourceBarStartUtcMs + 30_000 })).toBe(false);
    expect(validateExecutionFill({ ...valid, decisionUtcMs: valid.sourceBarCloseUtcMs - 1 })).toBe(false);
    expect(validateExecutionFill({ ...valid, decisionUtcMs: valid.sourceBarCloseUtcMs + MINUTE_MS })).toBe(false);
  });
});

describe('replayOverlay input contract — episode projection', () => {
  it('reaches every visible action from exactly one episode projection', () => {
    const projection = projectBacktestSession(SCALED, ALL);
    const grouped = [
      ...projection.closedTrades.flatMap((trade) => [...trade.entries, ...trade.exits]),
      ...(projection.openAggregate === null ? []
        : [...projection.openAggregate.entries, ...projection.openAggregate.exits]),
    ];
    const ids = grouped.map((action) => action.actionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(projection.visibleActions.map((action) => action.actionId)));
  });

  it('shares one action instance between visibleActions and the episode views', () => {
    const projection = projectBacktestSession(SCALED, ALL);
    const trade = projection.closedTrades[0];
    for (const action of [...trade.entries, ...trade.exits]) {
      expect(Object.is(projection.visibleActions.find((item) => item.actionId === action.actionId), action)).toBe(true);
    }
  });

  it('never mutates the session or its serialization across repeated projection', () => {
    const before = JSON.stringify(SCALED);
    for (const cursor of [T0, T0 + 7 * MINUTE_MS, T0 + 20 * MINUTE_MS, ALL]) {
      deriveReplayOverlay(ELIGIBLE, projectBacktestSession(SCALED, cursor), '1m', RENDERED_1M);
    }
    expect(JSON.stringify(SCALED)).toBe(before);
    expect(SCALED.schemaVersion).toBe(1);
    expect(SCALED.revision).toBe(5);
    expect(SCALED.actions.every((action) => action.actionVersion === 1)).toBe(true);
  });
});

// ─── Eligibility ─────────────────────────────────────────────

describe('resolveOverlayEligibility', () => {
  it('is eligible for an active session on the displayed contract', () => {
    expect(resolveOverlayEligibility(SCALED, snapshotOf()).eligible).toBe(true);
  });

  it('is ineligible without an active session', () => {
    expect(resolveOverlayEligibility(null, snapshotOf()).eligible).toBe(false);
  });

  it.each([
    ['a different root (NQ vs ES)', { root: 'ES' as const }],
    ['a different expiry month', { expiryMonth: 6 }],
    ['a different expiry year', { expiryYear: 2017 }],
  ])('is ineligible for %s', (_label, seriesOverride) => {
    const snapshot = snapshotOf({ series: { ...SERIES, ...seriesOverride } });
    expect(resolveOverlayEligibility(SCALED, snapshot).eligible).toBe(false);
  });

  it.each([
    ['loading', { loading: true }],
    ['importing', { importing: true }],
    ['an operational error', { error: 'Historical bars could not be read.' }],
    ['no rendered bars', { bars: [] }],
  ])('is ineligible while %s', (_label, override) => {
    expect(resolveOverlayEligibility(SCALED, snapshotOf(override)).eligible).toBe(false);
  });

  it('stays eligible under a canonical execution barrier', () => {
    // A canonical barrier is a MUTATION barrier: series, buffer and coverage are
    // settled and unchanged, so suppressing the overlay would flicker the lines
    // around every execution for no correctness gain.
    expect(resolveOverlayEligibility(SCALED, snapshotOf({ canonicalBarrier: 'action' })).eligible).toBe(true);
    expect(resolveOverlayEligibility(SCALED, snapshotOf({ canonicalBarrier: 'completion' })).eligible).toBe(true);
  });

  it('uses the released series comparator rather than a new one', () => {
    const snapshot = snapshotOf();
    expect(sameSessionSeries(SCALED.series, snapshot.series)).toBe(true);
    expect(sameSessionSeries(SCALED.series, { ...SERIES, expiryMonth: 6 })).toBe(false);
  });
});

// ─── Whole-overlay gate ──────────────────────────────────────

describe('deriveReplayOverlay — whole-overlay gate', () => {
  it('returns the frozen empty overlay when ineligible, even with an open position', () => {
    const open = projectBacktestSession(SCALED, T0 + 7 * MINUTE_MS);
    expect(open.openAggregate).not.toBeNull();
    const overlay = deriveReplayOverlay(INELIGIBLE, open, '1m', RENDERED_1M);
    expect(overlay.markers).toEqual([]);
    expect(overlay.lines).toEqual([]);
    expect(overlay).toBe(EMPTY_OVERLAY);
  });

  it('clears markers and lines together, never one without the other', () => {
    const eligible = overlayOf(SCALED, T0 + 7 * MINUTE_MS);
    expect(eligible.markers.length).toBeGreaterThan(0);
    expect(eligible.lines.length).toBeGreaterThan(0);
    const cleared = deriveReplayOverlay(INELIGIBLE, projectBacktestSession(SCALED, T0 + 7 * MINUTE_MS), '1m', RENDERED_1M);
    expect(cleared.markers).toHaveLength(0);
    expect(cleared.lines).toHaveLength(0);
  });

  it('returns the empty overlay for a null projection', () => {
    expect(deriveReplayOverlay(ELIGIBLE, null, '1m', RENDERED_1M)).toBe(EMPTY_OVERLAY);
  });
});

// ─── Marker source, uniqueness and classification ────────────

describe('deriveReplayOverlay — markers', () => {
  it('emits exactly one marker per visible action', () => {
    const overlay = overlayOf(SCALED);
    expect(overlay.markers).toHaveLength(4);
    const ids = overlay.markers.map((marker) => marker.actionId);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(SCALED.actions.map((action) => action.actionId));
  });

  it('classifies a full Long episode', () => {
    expect(classesOf(SCALED)).toEqual(['entry_long', 'scale_long', 'partial_long', 'final_long']);
  });

  it('classifies a full Short episode', () => {
    expect(classesOf(SHORT)).toEqual(['entry_short', 'scale_short', 'partial_short', 'final_short']);
  });

  it('classifies a single Long entry with no exits', () => {
    const single = build([{ kind: 'entry', quantity: 1, price: 20000, sourceMinute: 0, stop: 19995 }]);
    expect(classesOf(single)).toEqual(['entry_long']);
  });

  it('classifies a single Short entry with no exits', () => {
    const single = build([{ kind: 'entry', quantity: 1, price: 20000, sourceMinute: 0, side: 'short', stop: 20005 }]);
    expect(classesOf(single)).toEqual(['entry_short']);
  });

  it('classifies repeated partial exits on an open episode', () => {
    const repeated = build([
      { kind: 'entry', quantity: 4, price: 20000, sourceMinute: 0, stop: 19995 },
      { kind: 'exit', quantity: 1, price: 20005, sourceMinute: 6 },
      { kind: 'exit', quantity: 1, price: 20006, sourceMinute: 19 },
    ]);
    expect(classesOf(repeated)).toEqual(['entry_long', 'partial_long', 'partial_long']);
  });

  it('classifies a Scale In taken after a Partial Exit', () => {
    const scaleAfterPartial = build([
      { kind: 'entry', quantity: 2, price: 20000, sourceMinute: 0, stop: 19995 },
      { kind: 'exit', quantity: 1, price: 20005, sourceMinute: 6 },
      { kind: 'entry', quantity: 3, price: 20001.25, sourceMinute: 19, stop: 19995 },
    ]);
    expect(classesOf(scaleAfterPartial)).toEqual(['entry_long', 'partial_long', 'scale_long']);
  });

  it('marks only the closing Exit of a closed episode as final', () => {
    const overlay = overlayOf(SCALED);
    expect(overlay.markers.filter((marker) => marker.klass === 'final_long')).toHaveLength(1);
    expect(overlay.markers[3].actionId).toBe(SCALED.actions[3].actionId);
  });

  it('carries quantity and canonical sequence on every marker', () => {
    expect(overlayOf(SCALED).markers.map((marker) => [marker.quantity, marker.sequence]))
      .toEqual([[2, 1], [3, 2], [1, 3], [4, 4]]);
  });

  it('never emits a duplicate for an action reachable from both views', () => {
    // closedTrades and openAggregate hold the same instances visibleActions holds.
    const partial = build([
      { kind: 'entry', quantity: 2, price: 20000, sourceMinute: 0, stop: 19995 },
      { kind: 'exit', quantity: 2, price: 20005, sourceMinute: 6 },
      { kind: 'entry', quantity: 1, price: 20010, sourceMinute: 19, stop: 20005, tradeId: TID2 },
    ]);
    const overlay = overlayOf(partial);
    expect(overlay.markers).toHaveLength(3);
    expect(new Set(overlay.markers.map((marker) => marker.actionId)).size).toBe(3);
    expect(overlay.markers.map((marker) => marker.klass)).toEqual(['entry_long', 'final_long', 'entry_long']);
  });
});

// ─── Anchor and timeframe ────────────────────────────────────

describe('deriveReplayOverlay — marker anchoring', () => {
  it('anchors 1m markers exactly on the fill source bar', () => {
    expect(overlayOf(SCALED).markers.map((marker) => marker.anchorUtcMs))
      .toEqual(SCALED.actions.map((action) => action.fill.sourceBarStartUtcMs));
  });

  it('never anchors on the decision time', () => {
    for (const marker of overlayOf(SCALED).markers) {
      const action = SCALED.actions.find((item) => item.actionId === marker.actionId)!;
      expect(marker.anchorUtcMs).toBe(action.fill.sourceBarStartUtcMs);
      expect(marker.anchorUtcMs).not.toBe(action.fill.decisionUtcMs);
    }
  });

  it.each(TIMEFRAMES)('anchors onto a bucket the released derivation emitted at %s', (timeframe) => {
    const rendered = renderedTimes(ALL_MINUTES, timeframe);
    const overlay = overlayOf(SCALED, ALL, timeframe, rendered);
    expect(overlay.markers).toHaveLength(4);
    for (const marker of overlay.markers) {
      expect(rendered.has(marker.anchorUtcMs)).toBe(true);
      const bucketMs = REPLAY_TIMEFRAME_MS[timeframe];
      expect(marker.anchorUtcMs % bucketMs).toBe(0);
    }
  });

  it('collapses executions sharing one HTF bucket and orders them by sequence', () => {
    const sameBucket = build([
      { kind: 'entry', quantity: 2, price: 20000, sourceMinute: 0, stop: 19995 },
      { kind: 'entry', quantity: 1, price: 20001, sourceMinute: 3, stop: 19995 },
    ]);
    const rendered = renderedTimes([0, 3], '5m');
    expect(rendered.size).toBe(1);
    const overlay = deriveReplayOverlay(ELIGIBLE, projectBacktestSession(sameBucket, ALL), '5m', rendered);
    expect(overlay.markers.map((marker) => [marker.anchorUtcMs, marker.sequence]))
      .toEqual([[T0, 1], [T0, 2]]);
    expect(overlay.markers.map((marker) => marker.klass)).toEqual(['entry_long', 'scale_long']);
  });

  it('sorts markers by anchor then sequence', () => {
    const overlay = overlayOf(SCALED);
    const anchors = overlay.markers.map((marker) => marker.anchorUtcMs);
    expect([...anchors]).toEqual([...anchors].sort((left, right) => left - right));
  });

  it('exposes the anchor helper used by the derivation', () => {
    expect(markerAnchorUtcMs(T0 + 69 * MINUTE_MS, '1h')).toBe(T0 + 3_600_000);
    expect(markerAnchorUtcMs(T0 + 19 * MINUTE_MS, '15m')).toBe(T0 + 900_000);
    expect(markerAnchorUtcMs(T0 + 6 * MINUTE_MS, '5m')).toBe(T0 + 300_000);
    expect(markerAnchorUtcMs(T0 + 6 * MINUTE_MS, '1m')).toBe(T0 + 6 * MINUTE_MS);
  });
});

// ─── Rendered window ─────────────────────────────────────────

describe('deriveReplayOverlay — rendered-window filter', () => {
  it('drops a marker whose anchor bucket is not rendered and restores it when it is', () => {
    const evicted = renderedTimes([19, 60, 69, 70], '1m');   // minutes 0 and 6 evicted
    const partialOverlay = overlayOf(SCALED, ALL, '1m', evicted);
    expect(partialOverlay.markers.map((marker) => marker.klass)).toEqual(['partial_long', 'final_long']);

    const restored = overlayOf(SCALED, ALL, '1m', RENDERED_1M);
    expect(restored.markers).toHaveLength(4);
    expect(restored.markers.map((marker) => marker.actionId))
      .toEqual(SCALED.actions.map((action) => action.actionId));
  });

  it('emits no markers for an empty rendered window but still emits lines', () => {
    const open = projectBacktestSession(SCALED, T0 + 7 * MINUTE_MS);
    const overlay = deriveReplayOverlay(ELIGIBLE, open, '1m', new Set());
    expect(overlay.markers).toHaveLength(0);
    // A price line is a horizontal level and does not depend on the bar window.
    expect(overlay.lines).toHaveLength(2);
  });
});

// ─── Rewind ──────────────────────────────────────────────────

describe('deriveReplayOverlay — rewind', () => {
  it('hides executions after the cursor and restores them deterministically', () => {
    const rewound = overlayOf(SCALED, T0 + 7 * MINUTE_MS);
    expect(rewound.markers.map((marker) => marker.klass)).toEqual(['entry_long', 'scale_long']);
    const forward = overlayOf(SCALED, ALL);
    expect(forward.markers).toHaveLength(4);
    expect(forward.markers.slice(0, 2).map((marker) => marker.actionId))
      .toEqual(rewound.markers.map((marker) => marker.actionId));
  });

  it('emits nothing before the first entry', () => {
    const overlay = overlayOf(SCALED, T0);
    expect(overlay.markers).toHaveLength(0);
    expect(overlay.lines).toHaveLength(0);
  });

  it('reclassifies a closing Exit as partial while the later Exit is hidden', () => {
    // At this cursor the episode is still open, so its last visible Exit is a
    // partial — the classification follows the projection, not the raw action.
    expect(classesOf(SCALED, T0 + 20 * MINUTE_MS))
      .toEqual(['entry_long', 'scale_long', 'partial_long']);
  });
});

// ─── Lines ───────────────────────────────────────────────────

describe('deriveReplayOverlay — basis and stop lines', () => {
  it('emits a basis line and a stop line for an anchored open position', () => {
    expect(overlayOf(SCALED, T0 + 7 * MINUTE_MS).lines).toEqual([
      { kind: 'basis', price: 20000.75 },
      { kind: 'stop', price: 19995 },
    ]);
  });

  it('moves the basis line on a Scale In', () => {
    const beforeScale = overlayOf(SCALED, T0 + MINUTE_MS).lines;
    const afterScale = overlayOf(SCALED, T0 + 7 * MINUTE_MS).lines;
    expect(beforeScale[0]).toEqual({ kind: 'basis', price: 20000 });
    expect(afterScale[0]).toEqual({ kind: 'basis', price: 20000.75 });
  });

  it('leaves the basis line unchanged across a Partial Exit', () => {
    expect(overlayOf(SCALED, T0 + 20 * MINUTE_MS).lines[0]).toEqual({ kind: 'basis', price: 20000.75 });
  });

  it('removes both lines on the Final Exit', () => {
    expect(overlayOf(SCALED, ALL).lines).toEqual([]);
    expect(overlayOf(SCALED, ALL).markers).toHaveLength(4);
  });

  it('emits no stop line for a stopless episode', () => {
    const stopless = build([{ kind: 'entry', quantity: 1, price: 20000, sourceMinute: 0, stop: null }]);
    expect(overlayOf(stopless).lines).toEqual([{ kind: 'basis', price: 20000 }]);
  });

  it('emits a Short episode stop above the basis', () => {
    expect(overlayOf(SHORT, T0 + 7 * MINUTE_MS).lines).toEqual([
      { kind: 'basis', price: 19999.25 },
      { kind: 'stop', price: 20005 },
    ]);
  });

  it('ignores openPosition even when it disagrees with openAggregate', () => {
    const projection = projectBacktestSession(SCALED, T0 + 7 * MINUTE_MS);
    const contradictory: BacktestSessionProjection = {
      ...projection,
      // The legacy compatibility view is the FIRST Entry action; here it is
      // replaced with a deliberately wrong price to prove it is never read.
      openPosition: { ...projection.openPosition!, fill: { ...projection.openPosition!.fill, price: 12345 } },
    };
    const overlay = deriveReplayOverlay(ELIGIBLE, contradictory, '1m', RENDERED_1M);
    expect(overlay.lines).toEqual([
      { kind: 'basis', price: 20000.75 },
      { kind: 'stop', price: 19995 },
    ]);
    expect(overlay.lines.some((line) => line.price === 12345)).toBe(false);
  });
});
