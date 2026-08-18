/**
 * calculations/replayOverlay.ts
 *
 * B2d Phase 1 — pure derivation of the Replay chart overlay.
 *
 * No React, no lightweight-charts, no DOM, no storage. Everything here is a
 * function of released projection state plus two immutable inputs, so the
 * overlay is a DERIVED VALUE: it acquires no persistence and needs no
 * imperative cleanup. A cleared overlay is simply an empty derivation.
 *
 * ── AUTHORITIES (none of them re-implemented here) ─────────────
 *   marker source     projection.visibleActions            — and only that
 *   classification    episode membership (closedTrades / openAggregate)
 *   marker time       action.fill.sourceBarStartUtcMs      — never decisionUtcMs
 *   bucket size       REPLAY_TIMEFRAME_MS (htfDerivation)  — no new constant
 *   line values       projection.openAggregate             — never openPosition
 *   series identity   sameSessionSeries (backtestSession)  — no new comparator
 *
 * No basis, P/L, R, risk, or rational arithmetic is recomputed. The only numeric
 * operation performed on price-domain data is the bucket floor on a timestamp.
 */
import { sameSessionSeries } from './backtestSession.js';
import { REPLAY_TIMEFRAME_MS } from './htfDerivation.js';
import type {
  BacktestAction, BacktestSession, BacktestSessionProjection,
} from '@apptypes/backtestSession.js';
import type { ReplaySnapshot, ReplayTimeframe } from '@apptypes/replay.js';

/** Semantic marker classes. Side is carried in the class, not a separate field. */
export type MarkerClass =
  | 'entry_long' | 'entry_short'
  | 'scale_long' | 'scale_short'
  | 'partial_long' | 'partial_short'
  | 'final_long' | 'final_short';

export interface OverlayMarker {
  /** Canonical identity; also the marker key. Exactly one marker per action. */
  actionId: string;
  /** Bucket-floored `fill.sourceBarStartUtcMs` for the current display timeframe. */
  anchorUtcMs: number;
  klass: MarkerClass;
  quantity: number;
  /** Canonical action sequence, used to order executions sharing one bucket. */
  sequence: number;
}

export interface OverlayLine {
  kind: 'basis' | 'stop';
  price: number;
}

export interface ReplayOverlay {
  markers: readonly OverlayMarker[];
  lines: readonly OverlayLine[];
}

/**
 * The single overlay-wide readiness authority. Computed once at the composition
 * boundary and passed in, so this module never learns anything about the runtime.
 */
export interface OverlayEligibility {
  eligible: boolean;
}

/** Shared frozen empty result — referentially stable for consumer memoization. */
export const EMPTY_OVERLAY: ReplayOverlay = Object.freeze({
  markers: Object.freeze([]) as readonly OverlayMarker[],
  lines: Object.freeze([]) as readonly OverlayLine[],
});

/**
 * Overlay readiness.
 *
 * `canonicalBarrier` and `safetyBlocked` are deliberately ABSENT. Both are
 * trading-mutation states, not chart-data validity: during an in-flight
 * execution the series, buffer and coverage are settled and unchanged, and the
 * released trading panel keeps rendering the aggregate while safety-blocked.
 * Suppressing the overlay for either would flicker the lines around every
 * execution and put two surfaces into disagreement.
 *
 * The series comparison is load-bearing, not decoration: `resumeSession`
 * publishes the new series, bars and `loading: false` BEFORE its promise
 * settles, while the controller adopts the newly selected session only after
 * awaiting it — so a render can observe the new contract with the previous
 * session still active.
 */
export function resolveOverlayEligibility(
  activeSession: BacktestSession | null,
  snapshot: ReplaySnapshot,
): OverlayEligibility {
  const eligible = activeSession !== null
    && sameSessionSeries(activeSession.series, snapshot.series)
    && snapshot.loading === false
    && snapshot.importing === false
    && snapshot.error === null
    && snapshot.bars.length > 0;
  return { eligible };
}

interface EpisodeMembership {
  side: 'long' | 'short';
  isOpeningEntry: boolean;
  isFinalExit: boolean;
}

/**
 * Indexes every action of every projected episode by `actionId`.
 *
 * The episode views hold the SAME action instances as `visibleActions`, so this
 * is a classification lookup only — never a second marker source. Emitting from
 * both would render each closed execution twice.
 */
function indexEpisodeMembership(projection: BacktestSessionProjection): Map<string, EpisodeMembership> {
  const index = new Map<string, EpisodeMembership>();
  const add = (
    action: BacktestAction, side: 'long' | 'short', isOpeningEntry: boolean, isFinalExit: boolean,
  ) => { index.set(action.actionId, { side, isOpeningEntry, isFinalExit }); };

  for (const trade of projection.closedTrades) {
    trade.entries.forEach((entry, position) => add(entry, trade.side, position === 0, false));
    // A closed episode's last Exit is the one that returned it to Flat.
    trade.exits.forEach((exit, position) => add(exit, trade.side, false, position === trade.exits.length - 1));
  }
  const open = projection.openAggregate;
  if (open !== null) {
    open.entries.forEach((entry, position) => add(entry, open.side, position === 0, false));
    // An open episode has no final Exit by definition; every Exit is partial.
    open.exits.forEach((exit) => add(exit, open.side, false, false));
  }
  return index;
}

function classify(action: BacktestAction, membership: EpisodeMembership): MarkerClass {
  if (action.kind === 'entry') {
    return membership.isOpeningEntry
      ? (membership.side === 'long' ? 'entry_long' : 'entry_short')
      : (membership.side === 'long' ? 'scale_long' : 'scale_short');
  }
  return membership.isFinalExit
    ? (membership.side === 'long' ? 'final_long' : 'final_short')
    : (membership.side === 'long' ? 'partial_long' : 'partial_short');
}

/** Bucket-floors a canonical 1m source-bar start onto the displayed timeframe. */
export function markerAnchorUtcMs(sourceBarStartUtcMs: number, timeframe: ReplayTimeframe): number {
  const bucketMs = REPLAY_TIMEFRAME_MS[timeframe];
  return Math.floor(sourceBarStartUtcMs / bucketMs) * bucketMs;
}

function deriveLines(projection: BacktestSessionProjection): readonly OverlayLine[] {
  const open = projection.openAggregate;
  if (open === null) return EMPTY_OVERLAY.lines;
  const lines: OverlayLine[] = [{ kind: 'basis', price: open.weightedAverageEntryPrice }];
  if (open.initialStopPrice !== null) lines.push({ kind: 'stop', price: open.initialStopPrice });
  return lines;
}

/**
 * Derives the complete overlay for one render.
 *
 * `eligibility` gates the ENTIRE overlay before any projection state is read, so
 * markers and lines can never disagree about readiness — the failure mode that
 * would otherwise leave an NQ basis line drawn over an ES chart, or leave lines
 * standing over an emptied import-barrier buffer.
 *
 * `renderedBarTimes` carries the `t` values currently in `snapshot.bars`. A
 * marker is emitted only when its anchor bucket is actually rendered, so an
 * evicted bar drops its marker and a reloaded bar restores it deterministically.
 * Price lines are exempt: a horizontal level does not depend on the bar window.
 */
export function deriveReplayOverlay(
  eligibility: OverlayEligibility,
  projection: BacktestSessionProjection | null,
  timeframe: ReplayTimeframe,
  renderedBarTimes: ReadonlySet<number>,
): ReplayOverlay {
  if (!eligibility.eligible || projection === null) return EMPTY_OVERLAY;

  const membership = indexEpisodeMembership(projection);
  const markers: OverlayMarker[] = [];
  for (const action of projection.visibleActions) {
    const episode = membership.get(action.actionId);
    // Every visible action belongs to exactly one projected episode; an absent
    // entry would mean the projection disagreed with itself, so skip rather
    // than invent a classification.
    if (episode === undefined) continue;
    const anchorUtcMs = markerAnchorUtcMs(action.fill.sourceBarStartUtcMs, timeframe);
    if (!renderedBarTimes.has(anchorUtcMs)) continue;
    markers.push({
      actionId: action.actionId,
      anchorUtcMs,
      klass: classify(action, episode),
      quantity: action.quantity,
      sequence: action.sequence,
    });
  }
  markers.sort((left, right) => left.anchorUtcMs - right.anchorUtcMs || left.sequence - right.sequence);

  return { markers, lines: deriveLines(projection) };
}
