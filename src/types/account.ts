/**
 * types/account.ts
 *
 * Phase 20 — Architecture Cleanup: canonical Account type.
 *
 * Previously duplicated: a JSDoc `@typedef Account` lived here
 * (types/account.js, Phase 1) while the REAL, actively-used TypeScript
 * `interface Account` (imported by 10+ files) lived inside
 * `hooks/useAccounts.ts` (Phase 2B) — a dependency-direction problem,
 * since `calculations/tradeCalc.ts` (pure business logic) had to
 * import a type from a hook file to type its own `enrichTrades()`
 * function. Flagged as finding H-2 in the pre-Phase-19 Architecture
 * Cleanup audit.
 *
 * FIX: this file now holds the single canonical definition.
 * `hooks/useAccounts.ts` imports it and re-exports it (so all 10+
 * existing `import type { Account } from '@hooks/useAccounts.js'`
 * call sites continue to work completely unchanged — zero risk, zero
 * behavior change), while `calculations/tradeCalc.ts` now imports it
 * directly from here instead of from a hook file, resolving the
 * dependency-direction violation.
 *
 * Phase 5a — SYNC_ARCHITECTURE_SPEC.md decision 4, corrected: `Account`
 * now formally extends `SyncMetadata` (§3.2) — it is
 * `Stamped<AccountContent>` (record.ts), the shape an account ACTUALLY
 * carries once it exists in `accounts` state. The 10+ existing
 * consumers (AccManager, TradeRow, TradeTable, FilterBar,
 * exportService, useFilters, etc.) all read EXISTING accounts from
 * that state, so this is a safe widening for every one of them — none
 * construct a bare account literal. `AccountContent` is the new name
 * for the original 4-field-only shape — it is what
 * `components/account/AccManager.tsx` actually constructs before an
 * account has been stamped (add/edit forms build a plain
 * `{id,name,capital,color}` object with no sync identity yet).
 * `id` here remains the pre-existing BUSINESS identifier (record.ts's
 * "Record identity" note) — never the sync identity field, which is
 * `syncId` on the full `Account`.
 */

import type { Stamped } from '@sync/record.js';

/** An account's business content — zero sync identity. See file header. */
export interface AccountContent {
  /** Unique identifier — 'acc_1' for default, 'acc_' + Date.now() for new */
  id: string;
  /** Display name, e.g. 'FTMO 100K' */
  name: string;
  /** Starting capital in USD */
  capital: number;
  /** Hex color string for UI accent, e.g. '#3B82F6' */
  color: string;
}

/**
 * An account as it actually exists once created — business content
 * plus full sync metadata (§3.2). This is what `hooks/useAccounts.ts`'s
 * `accounts` state holds and what every existing consumer reading an
 * account already assumed at runtime. See `AccountContent` above for
 * the pre-stamp shape used only at construction time.
 */
export type Account = Stamped<AccountContent>;
