/**
 * constants/pipValues.js
 *
 * Pip / point value table.
 * Copied verbatim from the original single-file app (variable: PT).
 *
 * Shape per entry:
 *   f  — price multiplier (to convert price diff to pips/points)
 *   pv — dollar value per pip/point per 1 lot/contract
 *   t  — market type: "forex" | "futures"
 *
 * Backward compatibility: PRESERVED
 * These values drive P/L, risk, and pip calculations.
 * Any change here would break existing trade results.
 */

export const PIP_TABLE = {
  // ── Forex / Indices (treated as forex in original app) ──
  'US100':   { f: 1,     pv: 1,    t: 'forex' },
  'US500':   { f: 1,     pv: 5,    t: 'forex' },
  'US30':    { f: 1,     pv: 5,    t: 'forex' },
  'XAU/USD': { f: 100,   pv: 10,   t: 'forex' },
  'EUR/USD': { f: 10000, pv: 10,   t: 'forex' },
  'GBP/USD': { f: 10000, pv: 10,   t: 'forex' },
  'USD/JPY': { f: 100,   pv: 9.3,  t: 'forex' },
  'AUD/USD': { f: 10000, pv: 10,   t: 'forex' },
  'USD/CAD': { f: 10000, pv: 10,   t: 'forex' },
  'USD/CHF': { f: 10000, pv: 10,   t: 'forex' },
  'NZD/USD': { f: 10000, pv: 10,   t: 'forex' },
  'EUR/GBP': { f: 10000, pv: 13,   t: 'forex' },
  'EUR/JPY': { f: 100,   pv: 9.3,  t: 'forex' },
  'GBP/JPY': { f: 100,   pv: 9.3,  t: 'forex' },
  'EUR/AUD': { f: 10000, pv: 10,   t: 'forex' },
  'GBP/AUD': { f: 10000, pv: 10,   t: 'forex' },
  'AUD/JPY': { f: 100,   pv: 9.3,  t: 'forex' },
  'CAD/JPY': { f: 100,   pv: 9.3,  t: 'forex' },
  'EUR/CAD': { f: 10000, pv: 10,   t: 'forex' },
  'GBP/CAD': { f: 10000, pv: 10,   t: 'forex' },

  // ── Equity Index Futures ─────────────────────────────────
  'NQ':  { f: 1, pv: 20,   t: 'futures' },
  'MNQ': { f: 1, pv: 2,    t: 'futures' },
  'ES':  { f: 1, pv: 50,   t: 'futures' },
  'MES': { f: 1, pv: 5,    t: 'futures' },
  'YM':  { f: 1, pv: 5,    t: 'futures' },
  'MYM': { f: 1, pv: 0.5,  t: 'futures' },
  'RTY': { f: 1, pv: 50,   t: 'futures' },
  'M2K': { f: 1, pv: 5,    t: 'futures' },

  // ── Metals ───────────────────────────────────────────────
  'GC':  { f: 1, pv: 100,  t: 'futures' },
  'MGC': { f: 1, pv: 10,   t: 'futures' },
  'SI':  { f: 1, pv: 5000, t: 'futures' },
  'QI':  { f: 1, pv: 1000, t: 'futures' },

  // ── Energy ───────────────────────────────────────────────
  'CL':  { f: 1, pv: 1000,  t: 'futures' },
  'QM':  { f: 1, pv: 500,   t: 'futures' },
  'NG':  { f: 1, pv: 10000, t: 'futures' },

  // ── Bonds ────────────────────────────────────────────────
  'ZB':  { f: 1, pv: 1000,  t: 'futures' },
  'ZN':  { f: 1, pv: 1000,  t: 'futures' },
  'ZF':  { f: 1, pv: 1000,  t: 'futures' },

  // ── FX Futures ───────────────────────────────────────────
  '6E':  { f: 10000, pv: 12.5, t: 'futures' },
  '6B':  { f: 10000, pv: 6.25, t: 'futures' },
  '6J':  { f: 100,   pv: 12.5, t: 'futures' },
  '6C':  { f: 10000, pv: 10,   t: 'futures' },

  // ── Crypto Futures ───────────────────────────────────────
  'BTC': { f: 1, pv: 5,   t: 'futures' },
  'MBT': { f: 1, pv: 0.1, t: 'futures' },
  'ETH': { f: 1, pv: 50,  t: 'futures' },
  'MET': { f: 1, pv: 0.1, t: 'futures' },
};

/**
 * Get pip/point entry for a symbol.
 * Returns a fallback {f:1, pv:1, t:'forex'} for unknown symbols —
 * matching original app behavior: getP(sym) = PT[sym] || {f:1,pv:1,t:'forex'}
 *
 * @param {string} symbol
 * @returns {{ f: number, pv: number, t: 'forex'|'futures' }}
 */
export const getPipEntry = (symbol) =>
  PIP_TABLE[symbol] ?? { f: 1, pv: 1, t: 'forex' };

/**
 * Returns true if the symbol is a futures contract.
 * Matches original: isFut(sym) = getP(sym).t === 'futures'
 *
 * @param {string} symbol
 * @returns {boolean}
 */
export const isFutures = (symbol) => getPipEntry(symbol).t === 'futures';

/**
 * Returns the correct label for price distance.
 * Matches original: pointLabel(sym) = isFut(sym) ? 'Points' : 'Pips'
 *
 * @param {string} symbol
 * @returns {'Points'|'Pips'}
 */
export const getPointLabel = (symbol) => isFutures(symbol) ? 'Points' : 'Pips';
