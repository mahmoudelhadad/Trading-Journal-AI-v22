/**
 * types/trade.ts
 *
 * Phase 20 — Architecture Cleanup: canonical RawTrade type.
 *
 * Previously duplicated: a JSDoc `@typedef RawTrade` lived here
 * (types/trade.js, Phase 1) while the REAL, actively-used TypeScript
 * `interface RawTrade` (imported by 4+ files) lived inside
 * `hooks/useTrades.ts` (Phase 2B). Flagged as finding H-2 in the
 * pre-Phase-19 Architecture Cleanup audit — same pattern as Account
 * (see types/account.ts).
 *
 * FIX: this file now holds the single canonical definition.
 * `hooks/useTrades.ts` imports it and re-exports it (so all existing
 * `import type { RawTrade } from '@hooks/useTrades.js'` call sites
 * continue to work completely unchanged), giving calculations/ and
 * services/ a hook-independent source for this type.
 *
 * Phase 5a — SYNC_ARCHITECTURE_SPEC.md decision 4, corrected: `RawTrade`
 * now formally extends `SyncMetadata` (§3.2) — it is `Stamped<RawTradeContent>`
 * (record.ts), the shape a trade ACTUALLY carries once it exists in
 * `rawTrades` state, matching what every consumer that reads an
 * already-created trade already assumed at runtime. `RawTradeContent`
 * is the new name for the original 39-field-only shape — it is what
 * `createEmptyTrade()` returns and what `convertRow()`
 * (services/importService.ts) produces for a freshly-parsed CSV row:
 * both are genuinely pre-stamp business content with no sync identity
 * yet, and typing them as `RawTrade` would be the exact kind of lie
 * decision 4 asked to remove. See MIGRATION_NOTES.md-style disclosure
 * in the Phase 5a report for the one remaining, narrowly-scoped
 * assertion this ripple could not remove without touching the frozen
 * calculations/tradeCalc.ts `TradeLike`/`EnrichedTrade` types.
 */

import type { Stamped } from '@sync/record.js';

export interface TradeLeg {
  kind:              'entry' | 'exit';
  quantity:          string;   // integer contracts as string
  price:             string;
  date:              string;   // 'YYYY-MM-DD'
  time:              string;   // 'HH:mm:ss' — seconds PRESERVED here
  sourceExecutionId: string;   // digits-only string, NEVER a number
}

/** A trade's business content — zero sync identity. See file header. */
export interface RawTradeContent {
  _tid:           number;
  market:         string;
  symbol:         string;
  date:           string;
  broker:         string;
  account:        string;
  accountId:      string;
  dailySetup:     string;
  liquidity:      string;
  entrySetup:     string;
  intraDaySetup:  string;
  intraDayTF:     string;
  session:        string;
  daySwing:       string;
  linkToChart:    string;
  positionSize:   string;
  direction:      string;
  entryTime:      string;
  exitTime:       string;
  entryPrice:     string;
  stopLoss:       string;
  target:         string;
  exitPrice:      string;
  commission:     string;
  setupType:      string;
  personalRating: string;
  planFollowed:   string;
  emotions:       string;
  beSL:           string;
  afSL:           string;
  sl1:            string;
  sl2:            string;
  sl3:            string;
  tm1:            string;
  tm2:            string;
  tm3:            string;
  tm4:            string;
  tm5:            string;
  tm6:            string;
  error:          string;
  notes:          string;
  legs?:             TradeLeg[];
  sourceInstrument?: string;
  sourcePlatform?:   string;
  sourceAccountId?:  string;
}

/**
 * A trade as it actually exists once created — business content plus
 * full sync metadata (§3.2). This is what `hooks/useTrades.ts`'s
 * `rawTrades` state holds, what `updateTrade()`/`importTrades()`
 * operate on, and what every consumer reading an EXISTING trade should
 * type it as. See `RawTradeContent` above for the pre-stamp shape.
 */
export type RawTrade = Stamped<RawTradeContent>;

/**
 * Creates a new empty trade object.
 * Matches emptyT() function in original app exactly.
 * Called when user opens the "New Trade" form, and by the import
 * pipeline (services/importService.ts) as the base object each parsed
 * CSV/Excel row is merged into.
 *
 * NOTE: the returned object intentionally has NO `_tid` field — matching
 * the original app's emptyT(), which never set _tid until save time
 * (see hooks/useTrades.ts's addTrade, and importService.ts's
 * convertRow, both of which assign _tid explicitly afterward). It also
 * has no sync metadata — a genuinely new/imported trade has none yet
 * (§6.1 "User creates a record" — that transition is `addTrade()`'s
 * job, via `createSyncMetadata()`, not this function's).
 *
 * @param accId - Default account ID
 */
export const createEmptyTrade = (accId: string = 'acc_1'): Omit<RawTradeContent, '_tid'> => ({
  market:         'forex',
  symbol:         '',
  date:           new Date().toISOString().split('T')[0],
  broker:         '',
  account:        '',
  accountId:      accId,
  dailySetup:     '',
  liquidity:      '',
  entrySetup:     '',
  intraDaySetup:  '',
  intraDayTF:     '',
  session:        '',
  daySwing:       '',
  linkToChart:    '',
  positionSize:   '',
  direction:      '',
  entryTime:      '',
  exitTime:       '',
  entryPrice:     '',
  stopLoss:       '',
  target:         '',
  exitPrice:      '',
  commission:     '',
  setupType:      '',
  personalRating: '',
  planFollowed:   '',
  emotions:       '',
  beSL:           '',
  afSL:           '',
  sl1:            '',
  sl2:            '',
  sl3:            '',
  tm1:            '',
  tm2:            '',
  tm3:            '',
  tm4:            '',
  tm5:            '',
  tm6:            '',
  error:          '',
  notes:          '',
});
