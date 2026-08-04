/**
 * calculations/tradeCalc.ts
 *
 * Phase 2B — Trade calculation functions.
 *
 * Every function in this file is copied VERBATIM from the original
 * single-file app. The ONLY changes are:
 *   - TypeScript type annotations added
 *   - `getP()` replaced with `getPipEntry()` from constants
 *     (getPipEntry is identical: PT[sym] ?? { f:1, pv:1, t:'forex' })
 *   - `isFut()` replaced with `isFutures()` from constants (identical)
 *   - `pointLabel()` replaced with `getPointLabel()` from constants (identical)
 *
 * Backward compatibility: FULLY PRESERVED
 * No calculation logic has been changed.
 * Results are mathematically identical to the original app.
 */

import { getPipEntry, isFutures, getPointLabel } from '@constants/pipValues.js';
import type { Account } from '@apptypes/account.js';
import type { RawTradeContent } from '@apptypes/trade.js';

// ─── Minimal trade shape needed for calculations ──────────────
// Full shape is documented in src/types/trade.js
// Using a minimal type here so calculation functions are self-contained.
// Phase 20B — Production Readiness Fixes (item 4): TradeLike derives
// its field types from the canonical trade shape (types/trade.ts, all
// 39 fields) instead of a hand-maintained partial list.
//
// Gap-analysis G-1 — derives from RawTradeContent (business content
// only), not RawTrade (= RawTradeContent & SyncMetadata). The
// calculation layer's input has never had a legitimate reason to
// depend on sync identity (syncId/syncStatus/etc.) — it only ever
// reads business fields (entryPrice, stopLoss, symbol, ...). Deriving
// from RawTrade tied L3 (analytics, sync-agnostic) to L2's persistence
// identity model by accident, and — since RawTrade/RawTradeContent are
// interfaces with no index signature of their own — made a real
// `RawTrade[]` value structurally UNASSIGNABLE to the old
// `TradeLike[]` (a type with an explicit `[key: string]: unknown`
// catch-all requires its own index signature on the source, which
// interfaces never have), which was the exact cause of the one
// backtesting-relevant baseline `tsc` error. Removing the catch-all
// index signature (below) — now redundant, since RawTradeContent's 39
// declared fields already cover everything a real trade carries, and
// every access in this file is by declared field name, never by
// dynamic string key — is what actually restores assignability; the
// two changes are made together because a `TradeLike` with an index
// signature can never structurally accept a plain interface value
// regardless of which interface it's built from.
//
// This is a TYPE-LEVEL-ONLY change: TypeScript types are erased at
// compile time, and every field was already present on real trade
// objects at runtime (enrichTrades() has always spread the full
// object via `...t`). Fields keep the SAME `?: string` optionality
// every existing field already had. No runtime behavior changes.
//
// This also makes hypothetical (backtest-simulated) trades expressible
// for the first time: any object satisfying RawTradeContent's business
// fields is valid input, whether or not it carries real sync identity
// or a real persisted _tid — closing gap-analysis G-5 as a byproduct.
type TradeLike = Partial<Omit<RawTradeContent, '_tid'>>;

// ─── Outcome type ────────────────────────────────────────────
export type TradeOutcome = 'Green' | 'Red' | 'Breakeven' | '';

// ─── Enriched trade type ──────────────────────────────────────
// Extends TradeLike with all computed underscore fields.
// Field names match the original enrich() function exactly.
export interface EnrichedFields {
  _i:         number;
  _r:         number | null;
  _pts:       number | null;
  _pl:        number | null;
  _netPL:     number | null;
  _rv:        number | null;
  _rPct:      number | null;
  _plannedR:  number | null;
  _outcome:   TradeOutcome;
  _capital:   number;
  _durMins:   number | null;
  _dur:       string;
  _isFutures: boolean;
  _ptLabel:   'Points' | 'Pips';
}

export type EnrichedTrade = TradeLike & EnrichedFields & { _tid: number };

// ─── Calculation functions — copied verbatim ──────────────────

/**
 * Calculate actual R multiple.
 * Original: function calcR(t)
 */
export function calcR(t: TradeLike): number | null {
  if (!t.entryPrice || !t.stopLoss || !t.exitPrice) return null;
  const ep = +t.entryPrice, sl = +t.stopLoss, ex = +t.exitPrice;
  const d = Math.abs(ep - sl);
  if (!d) return null;
  return t.direction === 'Long' ? (ex - ep) / d : (ep - ex) / d;
}

/**
 * Calculate planned R multiple.
 * Original: function calcPlannedR(t)
 */
export function calcPlannedR(t: TradeLike): number | null {
  if (!t.entryPrice || !t.stopLoss || !t.target) return null;
  const ep = +t.entryPrice, sl = +t.stopLoss, tg = +t.target;
  const d = Math.abs(ep - sl);
  if (!d) return null;
  return t.direction === 'Long' ? (tg - ep) / d : (ep - tg) / d;
}

/**
 * Calculate gross P/L in dollars.
 * Original: function calcPL(t)
 * getP() → getPipEntry() — identical behavior
 */
export function calcPL(t: TradeLike): number | null {
  if (!t.entryPrice || !t.exitPrice || !t.positionSize || !t.symbol) return null;
  const p = getPipEntry(t.symbol);
  const diff = t.direction === 'Long'
    ? +t.exitPrice - +t.entryPrice
    : +t.entryPrice - +t.exitPrice;
  return +t.positionSize * diff * p.f * p.pv;
}

/**
 * Calculate risk value in dollars.
 * Original: function calcRisk(t)
 */
export function calcRisk(t: TradeLike): number | null {
  if (!t.entryPrice || !t.stopLoss || !t.positionSize || !t.symbol) return null;
  const p = getPipEntry(t.symbol);
  return +t.positionSize * Math.abs(+t.entryPrice - +t.stopLoss) * p.f * p.pv;
}

/**
 * Calculate pips or points result.
 * Original: function calcPoints(t)
 */
export function calcPoints(t: TradeLike): number | null {
  if (!t.entryPrice || !t.exitPrice || !t.symbol) return null;
  const p = getPipEntry(t.symbol);
  const diff = t.direction === 'Long'
    ? +t.exitPrice - +t.entryPrice
    : +t.entryPrice - +t.exitPrice;
  return Math.round(diff * p.f * 100) / 100;
}

/**
 * Calculate trade duration in minutes.
 * Original: function parseDurMins(t)
 */
export function parseDurMins(t: TradeLike): number | null {
  if (!t.entryTime || !t.exitTime || !t.date) return null;
  try {
    const d = Math.abs(
      new Date(t.date + 'T' + t.exitTime).getTime() -
      new Date(t.date + 'T' + t.entryTime).getTime(),
    );
    return Math.floor(d / 60000);
  } catch {
    return null;
  }
}

/**
 * Format duration minutes as display string.
 * Original: function formatDur(mins)
 */
export function formatDur(mins: number | null): string {
  if (mins === null) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

/**
 * Determine trade outcome from R value.
 * Original: function outcome(r)
 * Thresholds: > 0.2 = Green, < -0.2 = Red, else Breakeven
 */
export function calcOutcome(r: number | null): TradeOutcome {
  if (r === null) return '';
  return r > 0.2 ? 'Green' : r < -0.2 ? 'Red' : 'Breakeven';
}

// ─── Enrich function — copied verbatim ───────────────────────

/**
 * Enrich an array of raw trades with all computed fields.
 * Original: function enrich(trades, accounts)
 *
 * This function:
 * 1. Initialises a running capital tracker per account
 * 2. For each trade, computes all underscore fields
 * 3. Tracks cumulative capital per account as trades are processed
 *
 * The order of trades in the input array determines the capital
 * running total — this matches the original app behavior exactly.
 */
export function enrichTrades(
  trades: TradeLike[],
  accounts: Account[],
): EnrichedTrade[] {
  // Running capital per account — initialised from account.capital
  // Matches original: var accRun = {}; accounts.forEach(a => accRun[a.id] = a.capital)
  const accRun: Record<string, number> = {};
  accounts.forEach((a) => { accRun[a.id] = a.capital; });

  return trades.map((t, i) => {
    // Resolve account capital — matches original exactly
    const accId = (t.accountId as string) || accounts[0]?.id || 'acc_1';
    if (accRun[accId] === undefined) {
      const acc = accounts.find((a) => a.id === accId);
      accRun[accId] = acc ? acc.capital : 10000;
    }

    const r       = calcR(t);
    const pl      = calcPL(t);
    const rv      = calcRisk(t);
    const comm    = t.commission ? +t.commission : 0;
    const netPL   = pl !== null ? pl - comm : null;
    const capital = accRun[accId];

    // Advance running capital — matches original
    if (netPL !== null) accRun[accId] += netPL;

    const durMins = parseDurMins(t);

    // Spread all raw fields, then add computed fields
    // Matches original: var o={}; Object.keys(t).forEach(k => o[k]=t[k]); o._i=...
    return {
      ...t,
      _i:         i + 1,
      _r:         r,
      _pts:       calcPoints(t),
      _pl:        pl,
      _netPL:     netPL,
      _rv:        rv,
      _rPct:      rv && capital ? rv / capital : null,
      _plannedR:  calcPlannedR(t),
      _outcome:   calcOutcome(r),
      _capital:   capital,
      _durMins:   durMins,
      _dur:       formatDur(durMins),
      _isFutures: isFutures(t.symbol || ''),
      _ptLabel:   getPointLabel(t.symbol || ''),
    } as EnrichedTrade;
  });
}
