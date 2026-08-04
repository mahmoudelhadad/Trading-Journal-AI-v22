/**
 * calculations/rolling.ts
 *
 * Phase 8 — Analytics Engine: Trade frequency, period aggregation,
 * and rolling time-window statistics.
 * Phase 11 — Refactored to extract summarizeTrades() as a shared,
 * reusable aggregation primitive (see below), consolidating logic that
 * would otherwise be duplicated by the new Strategy page.
 *
 * NEW module - no direct original-app equivalent, though the period
 * aggregation logic intentionally mirrors the style already used by
 * the original app's daily/weekly/monthly period tabs (day-key = full
 * date, week-key = Monday-start ISO date, month-key = YYYY-MM), for
 * internal consistency with the rest of the codebase.
 *
 * Per Phase 9: aggregateByPeriod() is reused directly by the Equity
 * page for its Daily/Weekly/Monthly P&L charts.
 *
 * Per Phase 11 (intentional implementation choice — documented per
 * your rule 3): summarizeTrades() is extracted from what was
 * previously computed inline inside aggregateByPeriod()'s .map()
 * callback. It is IDENTICAL, field-for-field, to the original app's
 * standalone aggG(ts) function (used across StrategyTab, DailyTab,
 * WeeklyTab, MonthlyTab in the original single-file app) — this
 * refactor makes that same shared-aggregation intent explicit in the
 * migrated codebase, where it had previously only been implicit
 * (aggregateByPeriod's internals happened to compute a SUBSET of what
 * aggG computed, under different field names: `trades`/`winRate`
 * instead of `n`/`wr`). aggregateByPeriod's PUBLIC output shape
 * (PeriodStats) is UNCHANGED — this is a purely internal refactor,
 * numerically re-verified to produce identical PeriodStats output
 * before and after (see Phase 11 validation report).
 *
 * summarizeTrades() is now also consumed directly by the new Strategy
 * page (Phase 11) for its by-field groupings (Entry Setup, Daily
 * Setup, Session, Setup Type, Day of Week) and its Before/After 9:30
 * time-of-day comparison — replacing what would otherwise have been a
 * second, separately-implemented copy of the exact same green/red/be/
 * winRate/totalR/avgR/pl/netPL math.
 */

import type { EnrichedTrade } from './tradeCalc.js';

// ─── Types ───────────────────────────────────────────────────

export type PeriodGranularity = 'day' | 'week' | 'month';

export interface PeriodStats {
  key:      string;
  trades:   number;
  totalR:   number;
  netPL:    number;
  winRate:  number | null;
}

/**
 * Full trade-summary shape — field-for-field identical to the original
 * app's aggG(ts) return value. See summarizeTrades() below for the
 * complete Formula/Source/Assumptions/Edge-case documentation.
 */
export interface TradeSummary {
  n:      number;
  green:  number;
  red:    number;
  be:     number;
  wr:     number | null;
  totalR: number;
  avgR:   number | null;
  pl:     number;
  netPL:  number;
}

export interface TradeFrequency {
  avgTradesPerDay:   number | null;
  avgTradesPerWeek:  number | null;
  avgTradesPerMonth: number | null;
  totalTradingDays:  number;
  totalTradingWeeks: number;
  totalTradingMonths: number;
}

// ─── Shared trade summarizer ────────────────────────────────────

/**
 * Summarize an arbitrary list of enriched trades into aggregate stats.
 *
 * FORMULA:     n      = ts.length
 *              green  = count where _outcome === 'Green'
 *              red    = count where _outcome === 'Red'
 *              be     = count where _outcome === 'Breakeven'
 *              wr     = green / (green + red), or null if green+red === 0
 *              totalR = sum(_r ?? 0)
 *              avgR   = totalR / n, or null if n === 0
 *              pl     = sum(_pl ?? 0)          (gross P/L)
 *              netPL  = sum(_netPL ?? 0)       (net P/L)
 * SOURCE:      Field-for-field identical to the original single-file
 *              app's standalone aggG(ts) function, which was already
 *              shared across StrategyTab, DailyTab, WeeklyTab, and
 *              MonthlyTab in the original app. This migration makes
 *              that sharing explicit as an exported, reusable function
 *              rather than a page-local closure.
 * ASSUMPTIONS: `ts` can be ANY subset of trades — grouped by date,
 *              by a field value (e.g. entrySetup==='FVG'), by a
 *              time-of-day filter, or ungrouped. This function makes
 *              no assumption about how the caller selected `ts`.
 * EDGE CASES:  Returns {n:0, green:0, red:0, be:0, wr:null, totalR:0,
 *              avgR:null, pl:0, netPL:0} for an empty input array —
 *              sums are legitimately 0, but rate/average fields
 *              requiring a non-zero denominator are null, not 0.
 */
export function summarizeTrades(ts: EnrichedTrade[]): TradeSummary {
  const n = ts.length;
  const green = ts.filter((t) => t._outcome === 'Green').length;
  const red   = ts.filter((t) => t._outcome === 'Red').length;
  const be    = ts.filter((t) => t._outcome === 'Breakeven').length;
  const d = green + red;
  const wr = d > 0 ? green / d : null;
  const totalR = ts.reduce((s, t) => s + (t._r ?? 0), 0);
  const pl     = ts.reduce((s, t) => s + (t._pl ?? 0), 0);
  const netPL  = ts.reduce((s, t) => s + (t._netPL ?? 0), 0);
  const avgR = n > 0 ? totalR / n : null;

  return { n, green, red, be, wr, totalR, avgR, pl, netPL };
}

// ─── Generic grouping helper ────────────────────────────────────
// Added Phase 20 — Architecture Cleanup (finding M-2): extracts the
// "accumulate trades into Record<key, Trade[]> buckets" pattern that
// was independently hand-rolled in multiple pages (Insights.tsx had
// 3 near-identical copies in one file; Calendar.tsx had its own for
// day-of-month grouping). Pure, dependency-free, zero behavior change
// versus any of those inline versions — same accumulation logic,
// just parameterized by a key-extraction function.

/**
 * Group trades into buckets keyed by the result of `keyFn`.
 * FORMULA: for each trade, compute key = keyFn(trade); skip the trade
 *          entirely if keyFn returns null/undefined/''  (matches every
 *          existing inline version's "if (!t.someField) return;" guard).
 * EDGE CASES: a trade whose key is an empty string is treated the same
 *          as null/undefined (excluded) — matches the falsy-check
 *          convention already used by every inline version this
 *          replaces.
 */
export function groupTradesBy<T>(
  trades: T[],
  keyFn: (trade: T) => string | number | null | undefined,
): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  trades.forEach((t) => {
    const key = keyFn(t);
    if (key === null || key === undefined || key === '') return;
    const k = String(key);
    if (!groups[k]) groups[k] = [];
    groups[k].push(t);
  });
  return groups;
}

// ─── Period key helpers ────────────────────────────────────────

function getWeekKey(dateStr: string): string {
  const dt = new Date(`${dateStr}T12:00`);
  const day = dt.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  return dt.toISOString().split('T')[0];
}

function getPeriodKey(dateStr: string, granularity: PeriodGranularity): string {
  if (granularity === 'day') return dateStr;
  if (granularity === 'week') return getWeekKey(dateStr);
  return dateStr.slice(0, 7);
}

// ─── Period aggregation ─────────────────────────────────────────

/**
 * Group trades by day/week/month and compute per-period stats.
 * FORMULA:     Group trades by their period key (day/Monday-of-week/
 *              month), then summarize each group via summarizeTrades()
 *              (see above), mapping its fuller {n,green,red,be,wr,
 *              totalR,avgR,pl,netPL} shape onto this function's public
 *              {key,trades,totalR,netPL,winRate} output shape.
 * SOURCE:      Generalises the aggregation pattern the original app
 *              used separately in its Daily/Weekly/Monthly period tabs
 *              into one parameterised function.
 * ASSUMPTIONS: Trades without a `date` field are silently excluded.
 * EDGE CASES:  Returns an empty array if no trades have a date.
 *              Results are always sorted ascending by period key.
 *
 * Phase 11 note: internally refactored to call summarizeTrades()
 * instead of computing green/red/totalR/netPL/winRate inline a second
 * time. Output shape (PeriodStats) and every numeric value are
 * UNCHANGED — re-verified numerically after this refactor (see Phase
 * 11 validation report). This is an internal-only change; no caller
 * of aggregateByPeriod() needs to change.
 */
export function aggregateByPeriod(
  trades: EnrichedTrade[],
  granularity: PeriodGranularity,
): PeriodStats[] {
  const groups: Record<string, EnrichedTrade[]> = {};

  trades.forEach((t) => {
    if (!t.date) return;
    const key = getPeriodKey(t.date, granularity);
    if (!groups[key]) groups[key] = [];
    groups[key].push(t);
  });

  return Object.entries(groups)
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([key, periodTrades]) => {
      const summary = summarizeTrades(periodTrades);
      return {
        key,
        trades:  summary.n,
        totalR:  summary.totalR,
        netPL:   summary.netPL,
        winRate: summary.wr,
      };
    });
}

// ─── Trade frequency ─────────────────────────────────────────────

export function getTradeFrequency(trades: EnrichedTrade[]): TradeFrequency {
  const datedTrades = trades.filter((t) => t.date);
  const n = datedTrades.length;

  const dayKeys   = new Set(datedTrades.map((t) => getPeriodKey(t.date as string, 'day')));
  const weekKeys  = new Set(datedTrades.map((t) => getPeriodKey(t.date as string, 'week')));
  const monthKeys = new Set(datedTrades.map((t) => getPeriodKey(t.date as string, 'month')));

  return {
    avgTradesPerDay:    dayKeys.size   > 0 ? n / dayKeys.size   : null,
    avgTradesPerWeek:   weekKeys.size  > 0 ? n / weekKeys.size  : null,
    avgTradesPerMonth:  monthKeys.size > 0 ? n / monthKeys.size : null,
    totalTradingDays:   dayKeys.size,
    totalTradingWeeks:  weekKeys.size,
    totalTradingMonths: monthKeys.size,
  };
}

// ─── Rolling window stats ─────────────────────────────────────────

export function getRollingStats(
  trades: EnrichedTrade[],
  windowDays: number,
  referenceDate?: string,
): PeriodStats {
  const datedTrades = trades.filter((t) => t.date);
  if (datedTrades.length === 0) {
    return { key: `rolling-${windowDays}d`, trades: 0, totalR: 0, netPL: 0, winRate: null };
  }

  const refDate = referenceDate
    ? new Date(`${referenceDate}T12:00`)
    : new Date(`${datedTrades.reduce((max, t) => (t.date! > max ? t.date! : max), datedTrades[0].date!)}T12:00`);

  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - windowDays);

  const windowTrades = datedTrades.filter((t) => {
    const d = new Date(`${t.date}T12:00`);
    return d > cutoff && d <= refDate;
  });

  const summary = summarizeTrades(windowTrades);

  return {
    key:     `rolling-${windowDays}d`,
    trades:  summary.n,
    totalR:  summary.totalR,
    netPL:   summary.netPL,
    winRate: summary.wr,
  };
}

export function getStandardRollingWindows(
  trades: EnrichedTrade[],
  referenceDate?: string,
): { last30: PeriodStats; last90: PeriodStats; last365: PeriodStats } {
  return {
    last30:  getRollingStats(trades, 30,  referenceDate),
    last90:  getRollingStats(trades, 90,  referenceDate),
    last365: getRollingStats(trades, 365, referenceDate),
  };
}
