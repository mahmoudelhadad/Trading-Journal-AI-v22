/**
 * hooks/index.ts
 *
 * Barrel export for all hooks.
 *
 * Phase 2A: useSettings, useLists, useAccounts
 * Phase 2B: useTrades, useFilters
 * Phase 8:  useAdvancedAnalytics
 * Phase 14: useAdvancedFilters
 * Phase 15: useTradeReview
 * Phase 18: useRecoveryBin, useRestorePoints
 * Backtesting UI: useBacktests
 */

// ── Phase 2A ────────────────────────────────────────────────
export * from './useSettings.js';
export * from './useLists.js';
export * from './useAccounts.js';

// ── Phase 2B ────────────────────────────────────────────────
export * from './useTrades.js';
export * from './useFilters.js';

// ── Phase 8 ─────────────────────────────────────────────────
export * from './useAdvancedAnalytics.js';

// ── Phase 14 ────────────────────────────────────────────────
export * from './useAdvancedFilters.js';

// ── Phase 15 ────────────────────────────────────────────────
export * from './useTradeReview.js';

// ── Phase 18 ────────────────────────────────────────────────
export * from './useRecoveryBin.js';
export * from './useRestorePoints.js';

// ── Backtesting UI ──────────────────────────────────────────
export * from './useBacktests.js';
