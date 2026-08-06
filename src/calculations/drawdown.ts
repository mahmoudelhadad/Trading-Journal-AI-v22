/**
 * calculations/drawdown.ts
 *
 * Phase 8 — Analytics Engine: Drawdown analysis.
 *
 * NEW module - no original-app equivalent (the original app never
 * computed drawdown at all). All definitions below are standard
 * trading-statistics conventions, documented per function with
 * Formula / Source / Assumptions / Edge-case handling.
 *
 * Operates on an equity sequence derived from enriched trades in their
 * existing array order (same order enrichTrades() processes them in,
 * which itself preserves original insertion order - consistent with how
 * the Dashboard page already builds its equity curve).
 *
 * Per Phase 9: this module is consumed directly by the new Equity page
 * (buildEquitySequence + computeDrawdown), reusing the SAME functions
 * rather than duplicating equity-curve logic in a separate file — see
 * the Phase 9 report for the rationale (avoids the unnecessary
 * duplication the migration plan's original file list would have
 * introduced with a separate equity.ts module).
 */

import { finiteOrNull, isFiniteNumber, type EnrichedTrade } from './tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface EquityPoint {
  /** Trade sequence index, 0 = starting capital before any trades */
  index:   number;
  /** Cumulative equity in dollars at this point */
  equity:  number;
  /** Trade date, if available (undefined for index 0) */
  date?:   string;
}

export interface DrawdownResult {
  maxDrawdownDollar:  number;
  maxDrawdownPercent: number;
  currentDrawdownDollar:  number;
  currentDrawdownPercent: number;
  drawdownDurationTrades: number;
  recoveryTimeTrades: number | null;
  rollingDrawdown: Array<{ index: number; drawdownDollar: number; drawdownPercent: number }>;
}

// ─── Equity sequence builder ───────────────────────────────────

/**
 * Build a cumulative equity sequence from enriched trades.
 *
 * FORMULA:     equity[0] = startingCapital
 *              equity[i] = equity[i-1] + trades[i-1]._netPL  (or +0 if null)
 * SOURCE:      Same running-total pattern already used by the Dashboard
 *              page's equity curve (Phase 6) and useTrades.ts's
 *              per-account running capital (Phase 2B) — this function
 *              generalises that pattern for reuse, it does not introduce
 *              a new definition of "equity."
 * ASSUMPTIONS: Trades are processed in their existing array order (the
 *              same order the caller's trades array is already in —
 *              this function does not re-sort by date). Callers wanting
 *              a strictly chronological equity curve must pass
 *              chronologically-sorted trades.
 * EDGE CASES:  A trade with a null _netPL (incomplete/open trade)
 *              contributes exactly 0 to the running total, matching
 *              the `t._netPL || 0` pattern already used on the
 *              Dashboard page — it neither advances nor reduces equity.
 *              An empty trades array returns a single-point sequence
 *              containing only the starting capital.
 */
export function buildEquitySequence(
  trades: EnrichedTrade[],
  startingCapital: number,
): EquityPoint[] | null {
  if (!isFiniteNumber(startingCapital)) return null;
  const points: EquityPoint[] = [{ index: 0, equity: startingCapital }];
  let running = startingCapital;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (!isFiniteNumber(t._netPL)) {
      points.push({ index: i + 1, equity: running, date: t.date });
      continue;
    }
    const next = finiteOrNull(running + t._netPL);
    if (next === null) return null;
    running = next;
    points.push({ index: i + 1, equity: running, date: t.date });
  }

  return points;
}

// ─── Drawdown analysis ──────────────────────────────────────────

/**
 * Compute full drawdown analysis from an equity sequence.
 *
 * Definitions used throughout this function:
 *   - "Peak" = the running maximum equity value seen so far, at any
 *     given point in the sequence.
 *   - "Drawdown" at a point = peak_so_far - equity_at_that_point
 *     (always >= 0, since peak_so_far >= equity_at_that_point by
 *     definition of "running maximum").
 *
 * ─────────────────────────────────────────────────────────────
 * maxDrawdownDollar / maxDrawdownPercent
 *   FORMULA:     Largest drawdown value across the entire sequence.
 *                Percent version = (dollarDD / peakAtThatMoment) x 100.
 *   SOURCE:      Standard "Maximum Drawdown" metric, universal across
 *                trading platforms and portfolio analytics.
 *   ASSUMPTIONS: The percentage is relative to the PEAK immediately
 *                preceding that specific drawdown, not the account's
 *                all-time peak or starting capital — this is the
 *                standard convention (a $500 drawdown from a $1,000
 *                peak is a 50% DD regardless of what the peak was
 *                earlier or later in the sequence).
 *   EDGE CASES:  0 for an empty or single-point sequence (no decline
 *                is possible with 0 or 1 data points).
 *
 * currentDrawdownDollar / currentDrawdownPercent
 *   FORMULA:     (peak across the WHOLE sequence) - (equity at the
 *                LAST point in the sequence).
 *   SOURCE:      Standard "current/open drawdown" metric — how far
 *                below the all-time high the account currently sits.
 *   ASSUMPTIONS: Uses the all-time peak across the full sequence, not
 *                just a recent window.
 *   EDGE CASES:  0 if the last point IS the all-time peak (account is
 *                currently at a new high).
 *
 * drawdownDurationTrades
 *   FORMULA:     (trade index of the MAX-drawdown trough) - (trade
 *                index of the peak that preceded it).
 *   SOURCE:      Standard "drawdown duration" concept, expressed here
 *                in trade-count rather than calendar time (this app's
 *                trades are not evenly spaced in time, so a trade-count
 *                measure is more directly comparable across different
 *                trading frequencies than a calendar-day count would be).
 *   ASSUMPTIONS: Measures ONLY the duration of the single LARGEST
 *                drawdown, not every drawdown period in the sequence.
 *   EDGE CASES:  0 if the max drawdown's peak and trough are the same
 *                point (degenerate case, e.g. a single-point sequence).
 *
 * recoveryTimeTrades
 *   FORMULA:     (trade index of the first point, after the max-
 *                drawdown trough, whose equity >= the pre-drawdown
 *                peak) - (trade index of that trough).
 *   SOURCE:      Standard "time to recovery" concept, in trade-count
 *                terms (see drawdownDurationTrades above for why
 *                trade-count is used instead of calendar time).
 *   ASSUMPTIONS: "Recovered" means equity reaches or exceeds the SAME
 *                peak that preceded the max drawdown — not just any
 *                local high, and not necessarily a NEW all-time high
 *                (though reaching the prior peak again often coincides
 *                with one, if no larger peak existed before it).
 *   EDGE CASES:  null if the account never recovers to that peak by
 *                the end of the given sequence — this is a normal,
 *                expected outcome for an account currently in
 *                drawdown, not an error condition.
 *
 * rollingDrawdown
 *   FORMULA:     drawdown-from-running-peak computed at EVERY point in
 *                the sequence (not just the maximum) — i.e. the full
 *                time series, suitable for charting.
 *   SOURCE:      Standard drawdown-curve visualization data, as used
 *                by most equity-curve charting tools.
 *   EDGE CASES:  Empty array for an empty input sequence.
 * ─────────────────────────────────────────────────────────────
 */
export function computeDrawdown(equitySequence: EquityPoint[]): DrawdownResult | null {
  if (equitySequence.length === 0) {
    return {
      maxDrawdownDollar: 0,
      maxDrawdownPercent: 0,
      currentDrawdownDollar: 0,
      currentDrawdownPercent: 0,
      drawdownDurationTrades: 0,
      recoveryTimeTrades: null,
      rollingDrawdown: [],
    };
  }

  if (equitySequence.some((point) => !isFiniteNumber(point.index) || !isFiniteNumber(point.equity))) {
    return null;
  }

  let runningPeak = equitySequence[0].equity;
  let runningPeakIndex = equitySequence[0].index;

  let maxDDDollar = 0;
  let maxDDPercent = 0;
  let maxDDPeakIndex = runningPeakIndex;
  let maxDDTroughIndex = runningPeakIndex;
  let maxDDPeakValue = runningPeak;

  const rollingDrawdown: DrawdownResult['rollingDrawdown'] = [];

  for (const point of equitySequence) {
    if (point.equity > runningPeak) {
      runningPeak = point.equity;
      runningPeakIndex = point.index;
    }

    const ddDollar = finiteOrNull(runningPeak - point.equity);
    if (ddDollar === null) return null;
    const ddPercent = runningPeak !== 0
      ? finiteOrNull((ddDollar / runningPeak) * 100)
      : 0;
    if (ddPercent === null) return null;

    rollingDrawdown.push({ index: point.index, drawdownDollar: ddDollar, drawdownPercent: ddPercent });

    if (ddDollar > maxDDDollar) {
      maxDDDollar      = ddDollar;
      maxDDPercent     = ddPercent;
      maxDDPeakIndex   = runningPeakIndex;
      maxDDTroughIndex = point.index;
      maxDDPeakValue   = runningPeak;
    }
  }

  const lastPoint = equitySequence[equitySequence.length - 1];
  let peakAtEnd = equitySequence[0].equity;
  for (const point of equitySequence) {
    if (point.equity > peakAtEnd) peakAtEnd = point.equity;
  }
  const currentDrawdownDollar = finiteOrNull(peakAtEnd - lastPoint.equity);
  if (currentDrawdownDollar === null) return null;
  const currentDrawdownPercent = peakAtEnd !== 0
    ? finiteOrNull((currentDrawdownDollar / peakAtEnd) * 100)
    : 0;
  if (currentDrawdownPercent === null) return null;

  const drawdownDurationTrades = finiteOrNull(maxDDTroughIndex - maxDDPeakIndex);
  if (drawdownDurationTrades === null) return null;

  let recoveryTimeTrades: number | null = null;
  for (const point of equitySequence) {
    if (point.index <= maxDDTroughIndex) continue;
    if (point.equity >= maxDDPeakValue) {
      recoveryTimeTrades = finiteOrNull(point.index - maxDDTroughIndex);
      if (recoveryTimeTrades === null) return null;
      break;
    }
  }

  return {
    maxDrawdownDollar: maxDDDollar,
    maxDrawdownPercent: maxDDPercent,
    currentDrawdownDollar,
    currentDrawdownPercent,
    drawdownDurationTrades,
    recoveryTimeTrades,
    rollingDrawdown,
  };
}

/**
 * Convenience one-shot: build the equity sequence and compute drawdown
 * in a single call. See buildEquitySequence() and computeDrawdown()
 * above for full Formula/Source/Assumptions/Edge-case documentation.
 */
export function computeDrawdownFromTrades(
  trades: EnrichedTrade[],
  startingCapital: number,
): DrawdownResult | null {
  const sequence = buildEquitySequence(trades, startingCapital);
  return sequence === null ? null : computeDrawdown(sequence);
}
