/**
 * constants/symbols.js
 *
 * All tradeable symbol lists.
 * Values copied verbatim from the original single-file app.
 * No additions, no removals, no reordering.
 *
 * Backward compatibility: PRESERVED
 * These arrays are used for dropdown rendering only — they do not
 * affect stored trade data in LocalStorage.
 */

// ─── Forex Symbols ──────────────────────────────────────────
// Original: FX_SYMBOLS variable in single-file app
export const FX_SYMBOLS = [
  'US100', 'US500', 'US30',
  'XAU/USD',
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD',
  'USD/CAD', 'USD/CHF', 'NZD/USD',
  'EUR/GBP', 'EUR/JPY', 'GBP/JPY',
  'EUR/AUD', 'GBP/AUD', 'AUD/JPY',
  'CAD/JPY', 'EUR/CAD', 'GBP/CAD',
];

// ─── Futures Symbols ────────────────────────────────────────
// Original: FUT_SYMBOLS variable in single-file app
export const FUT_SYMBOLS = [
  'NQ',  'MNQ',
  'ES',  'MES',
  'YM',  'MYM',
  'RTY', 'M2K',
  'GC',  'MGC',
  'SI',  'QI',
  'CL',  'QM',
  'NG',
  'ZB',  'ZN',  'ZF',
  '6E',  '6B',  '6J',  '6C',
  'BTC', 'MBT', 'ETH', 'MET',
];

/** All symbols combined — matches ALL_SYMBOLS usage in original app */
export const ALL_SYMBOLS = [...FX_SYMBOLS, ...FUT_SYMBOLS];
