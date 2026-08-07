/**
 * calculations/tradeCalc.ts
 *
 * Phase 2B — Trade calculation functions.
 *
 * Every function in this file is copied VERBATIM from the original
 * single-file app. The ONLY changes are:
 *   - TypeScript type annotations added
 *   - `getP()` replaced with `findPipEntry()` from constants
 *     (Phase 32C: no generic { f:1, pv:1, t:'forex' } fallback — an
 *     unsupported symbol yields null instead of invented instrument truth)
 *   - `isFut()` replaced with `isFutures()` from constants (identical)
 *   - `pointLabel()` replaced with `getPointLabel()` from constants (identical)
 *
 * Backward compatibility: FULLY PRESERVED
 * No calculation logic has been changed.
 * Phase 32C preserves formulas but returns null when required truth is unavailable.
 */

import { findPipEntry, isFutures, getPointLabel } from '@constants/pipValues.js';
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
  _capital:   number | null;
  _durMins:   number | null;
  _dur:       string;
  _isFutures: boolean;
  _ptLabel:   'Points' | 'Pips';
}

export type EnrichedTrade = TradeLike & EnrichedFields & { _tid: number };

// ─── Finite-number boundary helpers ───────────────────────────

/** True only for JavaScript numbers that can safely cross a derived-value boundary. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Parse a permissive raw value without rewriting it; invalid/blank values are unavailable. */
export function toFiniteNumber(value: unknown): number | null {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return isFiniteNumber(parsed) ? parsed : null;
}

/** Convert a calculated numeric result into the finite-or-null contract. */
export function finiteOrNull(value: number): number | null {
  return isFiniteNumber(value) ? value : null;
}

function positiveFinite(value: unknown): number | null {
  const parsed = toFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function isDirection(value: unknown): value is 'Long' | 'Short' {
  return value === 'Long' || value === 'Short';
}

/**
 * Sum available finite values. Null/undefined/non-finite operands are unavailable
 * contributions; overflow of the finite running sum makes the aggregate unavailable.
 */
export function sumFinite(values: readonly (number | null | undefined)[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!isFiniteNumber(value)) continue;
    const next = total + value;
    if (!isFiniteNumber(next)) return null;
    total = next;
  }
  return total;
}

// ─── Calculation functions — copied verbatim ──────────────────

/**
 * Calculate actual R multiple.
 * Original: function calcR(t)
 */
export function calcR(t: TradeLike): number | null {
  const ep = positiveFinite(t.entryPrice);
  const sl = positiveFinite(t.stopLoss);
  const ex = positiveFinite(t.exitPrice);
  if (ep === null || sl === null || ex === null || !isDirection(t.direction)) return null;
  const d = Math.abs(ep - sl);
  if (!isFiniteNumber(d) || d === 0) return null;
  return finiteOrNull(t.direction === 'Long' ? (ex - ep) / d : (ep - ex) / d);
}

/**
 * Calculate planned R multiple.
 * Original: function calcPlannedR(t)
 */
export function calcPlannedR(t: TradeLike): number | null {
  const ep = positiveFinite(t.entryPrice);
  const sl = positiveFinite(t.stopLoss);
  const tg = positiveFinite(t.target);
  if (ep === null || sl === null || tg === null || !isDirection(t.direction)) return null;
  const d = Math.abs(ep - sl);
  if (!isFiniteNumber(d) || d === 0) return null;
  return finiteOrNull(t.direction === 'Long' ? (tg - ep) / d : (ep - tg) / d);
}

/**
 * Calculate gross P/L in dollars.
 * Original: function calcPL(t)
 * getP() → findPipEntry() — unsupported symbols return null
 */
export function calcPL(t: TradeLike): number | null {
  const ep = positiveFinite(t.entryPrice);
  const ex = positiveFinite(t.exitPrice);
  const size = positiveFinite(t.positionSize);
  const p = findPipEntry(t.symbol);
  if (ep === null || ex === null || size === null || !p || !isDirection(t.direction)) return null;
  const diff = t.direction === 'Long'
    ? ex - ep
    : ep - ex;
  return finiteOrNull(size * diff * p.f * p.pv);
}

/**
 * Calculate risk value in dollars.
 * Original: function calcRisk(t)
 */
export function calcRisk(t: TradeLike): number | null {
  const ep = positiveFinite(t.entryPrice);
  const sl = positiveFinite(t.stopLoss);
  const size = positiveFinite(t.positionSize);
  const p = findPipEntry(t.symbol);
  if (ep === null || sl === null || size === null || !p) return null;
  return finiteOrNull(size * Math.abs(ep - sl) * p.f * p.pv);
}

/**
 * Calculate pips or points result.
 * Original: function calcPoints(t)
 */
export function calcPoints(t: TradeLike): number | null {
  const ep = positiveFinite(t.entryPrice);
  const ex = positiveFinite(t.exitPrice);
  const p = findPipEntry(t.symbol);
  if (ep === null || ex === null || !p || !isDirection(t.direction)) return null;
  const diff = t.direction === 'Long'
    ? ex - ep
    : ep - ex;
  return finiteOrNull(Math.round(diff * p.f * 100) / 100);
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
    return finiteOrNull(Math.floor(d / 60000));
  } catch {
    return null;
  }
}

/**
 * Format duration minutes as display string.
 * Original: function formatDur(mins)
 */
export function formatDur(mins: number | null): string {
  if (!isFiniteNumber(mins)) return '—';
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
  if (!isFiniteNumber(r)) return '';
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
  const accRun: Record<string, number | null> = {};
  accounts.forEach((a) => { accRun[a.id] = finiteOrNull(a.capital); });

  return trades.map((t, i) => {
    // Resolve only real account capital; never invent it for historical orphans.
    const accId = typeof t.accountId === 'string' ? t.accountId : '';
    const accountResolved = accounts.some((account) => account.id === accId);

    const r       = calcR(t);
    const pl      = calcPL(t);
    const rv      = calcRisk(t);
    const commissionText = typeof t.commission === 'string' ? t.commission.trim() : '';
    const comm    = commissionText === '' ? 0 : toFiniteNumber(t.commission);
    const netPL   = pl !== null && comm !== null ? finiteOrNull(pl - comm) : null;
    const capital = accountResolved ? accRun[accId] : null;

    // Advance running capital — matches original
    if (netPL !== null && capital !== null) {
      accRun[accId] = finiteOrNull(capital + netPL);
    }

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
      _rPct:      rv !== null && capital !== null && capital !== 0
        ? finiteOrNull(rv / capital)
        : null,
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
