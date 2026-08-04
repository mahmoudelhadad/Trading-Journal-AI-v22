/**
 * calculations/streaks.ts
 *
 * Phase 8 — Analytics Engine: Streak analysis.
 *
 * STRUCTURAL NOTE: computeStreaks() below is relocated VERBATIM from
 * hooks/useAnalytics.ts (Phase 2B), where it lived as a private inline
 * function. This is a pure code-location move — the algorithm itself is
 * byte-identical to the Phase 2B version (which was itself byte-identical
 * to the original app's inline logic in InsightsTab, verified in Phase 7
 * Validation with 200 randomized test sequences).
 *
 * useAnalytics.ts has been updated to import from here instead of
 * duplicating the function. This was pre-announced in Phase 2B's own
 * docstring: "a dedicated Analytics phase" would extract shared logic —
 * this is that phase. See MIGRATION_NOTES.md → AN-001.
 *
 * NEW in Phase 8 (no original-app equivalent — this analysis never
 * existed before): getAllStreaks(), getAverageStreaks(),
 * getLongestStreaks(). Each documented below with Formula / Source /
 * Assumptions / Edge-case handling.
 */

import type { EnrichedTrade } from './tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export interface StreakResult {
  current: number;
  type:    'W' | 'L' | '';
  maxWin:  number;
  maxLoss: number;
}

export interface StreakRun {
  type:   'W' | 'L';
  length: number;
}

export interface AverageStreaks {
  avgWinStreak:  number | null;
  avgLossStreak: number | null;
}

export interface LongestStreaks {
  longestWinStreak:  number;
  longestLossStreak: number;
}

// ─── computeStreaks() — relocated verbatim, logic unchanged ───

/**
 * Compute current + longest win/loss streak data from enriched trades.
 * FORMULA:     Walks the closed-trade sequence (Green/Red only,
 *              Breakeven excluded) in order, tracking the current run
 *              length and resetting it whenever the outcome type
 *              changes. maxWin/maxLoss track the longest run of each
 *              type seen anywhere in the sequence; current/type track
 *              only the run in progress at the END of the sequence.
 * SOURCE:      Relocated from hooks/useAnalytics.ts (Phase 2B) — see
 *              file header. Original algorithm from the single-file
 *              app's InsightsTab, re-verified byte-identical in Phase 7
 *              Validation (200 randomized sequences, 0 mismatches) and
 *              again in Phase 8 after this relocation.
 * ASSUMPTIONS: Breakeven and unclosed ('') trades are skipped entirely
 *              — they neither extend nor break a streak, as if they
 *              were never in the sequence.
 * EDGE CASES:  Returns {current:0, type:'', maxWin:0, maxLoss:0} for an
 *              empty or all-Breakeven trade set.
 */
export function computeStreaks(trades: EnrichedTrade[]): StreakResult {
  let curStreak = 0;
  let curType: 'W' | 'L' | '' = '';
  let maxWin = 0;
  let maxLoss = 0;
  let tmpW = 0;
  let tmpL = 0;

  const closedTrades = trades.filter(
    (t) => t._outcome === 'Green' || t._outcome === 'Red',
  );

  closedTrades.forEach((t, i) => {
    const isW = t._outcome === 'Green';
    if (i === 0) {
      curType   = isW ? 'W' : 'L';
      curStreak = 1;
      tmpW      = isW ? 1 : 0;
      tmpL      = isW ? 0 : 1;
    } else {
      if ((isW && curType === 'W') || (!isW && curType === 'L')) {
        curStreak++;
      } else {
        curType   = isW ? 'W' : 'L';
        curStreak = 1;
      }
      if (isW) { tmpW++; tmpL = 0; }
      else     { tmpL++; tmpW = 0; }
    }
    maxWin  = Math.max(maxWin,  tmpW);
    maxLoss = Math.max(maxLoss, tmpL);
  });

  return { current: curStreak, type: curType, maxWin, maxLoss };
}

// ─── NEW in Phase 8: full streak-run distribution ──────────────

/**
 * Segment the closed-trade outcome sequence into runs of consecutive
 * wins/losses and return every run's type and length.
 *
 * FORMULA:     Walks the closed-trade sequence once; each time the
 *              outcome type changes from the previous trade, the prior
 *              run is closed off and pushed to the result list, and a
 *              new run begins. The final in-progress run is pushed
 *              after the loop ends.
 * SOURCE:      New — generalises computeStreaks()'s single "current +
 *              max" tracking into the FULL distribution of run lengths,
 *              needed for the Average Winning/Losing Streak metrics
 *              from the approved migration plan's Advanced Analytics
 *              section (which computeStreaks alone cannot answer).
 * ASSUMPTIONS: Same as computeStreaks() — Breakeven/unclosed trades are
 *              excluded from the sequence entirely, not treated as a
 *              streak-breaking event of their own "type."
 * EDGE CASES:  Returns an empty array for an empty or all-Breakeven
 *              trade set. A trade set with exactly one closed trade
 *              returns a single run of length 1.
 *
 * Example: Green, Green, Red, Green, Red, Red, Red
 *       -> [{type:'W',length:2}, {type:'L',length:1}, {type:'W',length:1}, {type:'L',length:3}]
 */
export function getAllStreaks(trades: EnrichedTrade[]): StreakRun[] {
  const closedTrades = trades.filter(
    (t) => t._outcome === 'Green' || t._outcome === 'Red',
  );

  const runs: StreakRun[] = [];
  let currentType: 'W' | 'L' | null = null;
  let currentLength = 0;

  closedTrades.forEach((t) => {
    const isW = t._outcome === 'Green';
    const type: 'W' | 'L' = isW ? 'W' : 'L';

    if (type === currentType) {
      currentLength++;
    } else {
      if (currentType !== null) {
        runs.push({ type: currentType, length: currentLength });
      }
      currentType   = type;
      currentLength = 1;
    }
  });

  if (currentType !== null) {
    runs.push({ type: currentType, length: currentLength });
  }

  return runs;
}

/**
 * Average length of winning streaks and losing streaks.
 * FORMULA:     avgWinStreak  = mean(length of all runs where type='W')
 *              avgLossStreak = mean(length of all runs where type='L')
 * SOURCE:      Derived directly from getAllStreaks() — no independent
 *              calculation, avoiding duplicate streak-detection logic.
 * ASSUMPTIONS: Each COMPLETED run counts once, regardless of length —
 *              a single 5-trade win streak and five separate 1-trade
 *              win streaks both contribute their own single data point
 *              to the average (this is an average OF STREAKS, not an
 *              average of trades weighted by streak membership).
 * EDGE CASES:  null for a category with zero streaks of that type
 *              (e.g. avgLossStreak is null if every closed trade won).
 */
export function getAverageStreaks(trades: EnrichedTrade[]): AverageStreaks {
  const runs = getAllStreaks(trades);
  const winRuns  = runs.filter((r) => r.type === 'W').map((r) => r.length);
  const lossRuns = runs.filter((r) => r.type === 'L').map((r) => r.length);

  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

  return {
    avgWinStreak:  avg(winRuns),
    avgLossStreak: avg(lossRuns),
  };
}

/**
 * Longest winning streak and longest losing streak.
 * FORMULA:     max(length) over all 'W' runs / all 'L' runs.
 * SOURCE:      Mathematically equivalent to computeStreaks().maxWin /
 *              .maxLoss, exposed as a standalone function for callers
 *              (e.g. the future Strategy page) that only need this
 *              value and not the "current streak in progress" state
 *              that computeStreaks() also returns.
 * ASSUMPTIONS: None beyond getAllStreaks()'s assumptions.
 * EDGE CASES:  0 (not null) for a category with zero streaks of that
 *              type — "longest streak of a type that never occurred"
 *              is well-defined as 0, unlike an average, which is
 *              undefined (null) with zero data points.
 */
export function getLongestStreaks(trades: EnrichedTrade[]): LongestStreaks {
  const runs = getAllStreaks(trades);
  const winLengths  = runs.filter((r) => r.type === 'W').map((r) => r.length);
  const lossLengths = runs.filter((r) => r.type === 'L').map((r) => r.length);

  return {
    longestWinStreak:  winLengths.length  > 0 ? Math.max(...winLengths)  : 0,
    longestLossStreak: lossLengths.length > 0 ? Math.max(...lossLengths) : 0,
  };
}
