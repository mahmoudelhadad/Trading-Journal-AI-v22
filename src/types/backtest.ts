/**
 * types/backtest.ts
 *
 * Backtesting Foundation — canonical BacktestResult type.
 *
 * Per AD-014: backtest results are unsynced, Class B local data — no
 * SyncMetadata, no resolver, no IndexedDB, keyed by an independently
 * generated id (calculations/idGenerator.ts's nextId()), not a syncId
 * and not a _tid.
 *
 * `filterGroup` is the entire "strategy definition" for this phase — a
 * snapshot copy of the FilterGroup the result was run with (not a live
 * reference to a SavedFilter, which may later be edited or deleted),
 * so a stored result stays self-describing on its own.
 *
 * `matchedTradeIds` records which real trades (_tid) matched at run
 * time. This is retained rather than recomputed because it is NOT
 * reconstructable once the underlying trades are later edited or
 * deleted — unlike every other field below, which is a pure
 * derivation of the matched trade set and is cheap to recompute if
 * ever needed again.
 *
 * The equity curve (drawdown.ts's EquityPoint[]) is deliberately NOT
 * part of this type — only its derived summary (`drawdown`,
 * DrawdownResult) is persisted. The full per-trade sequence is
 * recomputable on demand from `matchedTradeIds` + `startingCapital`
 * via buildEquitySequence(), consistent with AD-014's framing of a
 * backtest result as regenerable from its inputs. This was the sole
 * Blocking finding of the phase's pre-implementation review, resolved
 * before this file was written.
 */

import type { FilterGroup } from '@calculations/filterEngine.js';
import type { TradeSummary } from '@calculations/rolling.js';
import type { DrawdownResult } from '@calculations/drawdown.js';
import type {
  StreakResult,
  AverageStreaks,
  LongestStreaks,
} from '@calculations/streaks.js';
import type { CoreAnalytics } from '@calculations/analytics.js';

/** A single stored backtest run — see file header for field rationale. */
export interface BacktestResult {
  id:        string;
  name:      string;
  createdAt: number;

  filterGroup:     FilterGroup;
  startingCapital: number;

  matchedTradeIds: number[];
  tradeCount:      number;

  summary:        TradeSummary;
  drawdown:       DrawdownResult;
  streaks:        StreakResult;
  averageStreaks: AverageStreaks;
  longestStreaks: LongestStreaks;
  core:           CoreAnalytics;
}
