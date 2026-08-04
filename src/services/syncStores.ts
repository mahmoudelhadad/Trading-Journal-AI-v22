/**
 * services/syncStores.ts
 *
 * Phase 5a — SYNC_ARCHITECTURE_SPEC.md §13 Step 5 / §3.3.
 *
 * The concrete wiring for src/sync/localStores.ts's generic factories:
 * this is where the real per-table read/write functions actually get
 * injected. Mirrors the layering already established across this
 * codebase — services/ is where every other piece of "real" I/O lives
 * (storage.js, supabaseClient.ts) — so that src/sync/ itself stays
 * exactly as free of concrete-module imports as it was at the end of
 * Phase 4.
 *
 * PHASE 6f — READS AND WRITES NOW GO THROUGH THE RESOLVER: every
 * `load`/`save`/`remove` injected below comes from
 * services/localDatabase.ts instead of services/storage.js directly, so
 * the Sync Engine's store layer reads and writes whichever local backend
 * is currently authoritative (§13 Step 6 sub-step 5) rather than being
 * hard-wired to LocalStorage. Nothing else about this file changed:
 * the factory calls, the bundle shapes, and the exported function names
 * are all exactly as Phases 5a/5e left them.
 *
 * NO BEHAVIORAL CHANGE WHILE THE MARKER IS ABSENT: the resolver routes
 * to LocalStorage until the cutover completion marker exists, and the
 * cutover is still never executed (it has no caller anywhere). So on
 * every real installation these functions read and write exactly the
 * same LocalStorage keys, with exactly the same contents, as before.
 *
 * `localStorageCursors` MOVED OUT: it now lives in
 * services/localDatabase.ts. It had to, because this file importing the
 * resolver while the resolver imported the cursor accessor from here
 * would have formed a genuine circular dependency — see that module's
 * note on the relocation. The resolver is its only consumer now.
 */

import {
  loadTrades, saveTrades,
  loadAccounts, saveAccounts,
  loadLists, saveLists, removeLists,
  loadSettings, saveSettings, removeSettings,
  cursors,
} from '@services/localDatabase.js';
import {
  createCollectionStores,
  createSingletonStores,
  createCollectionTier2ResolutionStore,
  createSingletonTier2ResolutionStore,
  type LocalStoreBundle,
  type Tier2ResolutionStore,
} from '@sync/localStores.js';
import type { SyncTableName } from '@sync/scheduler.js';
import type { SingletonRecord } from '@sync/record.js';
import type { RawTrade } from '@apptypes/trade.js';
import type { Account } from '@apptypes/account.js';

// ─── Per-table store bundles ──────────────────────────────────────────

export function createTradesStores(): LocalStoreBundle {
  return createCollectionStores<RawTrade>(
    'trades',
    () => loadTrades(),
    (items) => saveTrades(items),
    cursors,
  );
}

export function createAccountsStores(): LocalStoreBundle {
  return createCollectionStores<Account>(
    'accounts',
    // `loadAccounts()` returns null for "nothing saved yet" (unchanged
    // contract, both backends) — normalized to [] here exactly as before.
    async () => (await loadAccounts()) ?? [],
    (items) => saveAccounts(items),
    cursors,
  );
}

export function createListsStores(): LocalStoreBundle {
  return createSingletonStores(
    'lists',
    () => loadLists() as Promise<SingletonRecord<Record<string, unknown>> | null>,
    (record) => saveLists(record),
    cursors,
  );
}

export function createSettingsStores(): LocalStoreBundle {
  return createSingletonStores(
    'settings',
    () => loadSettings() as Promise<SingletonRecord<Record<string, unknown>> | null>,
    (record) => saveSettings(record),
    cursors,
  );
}

/** All four tables' store bundles, in §6.3's fixed table order. Convenience for Phase 5d's `SyncEngineDependencies` assembly. */
export function createAllLocalStores(): Record<SyncTableName, LocalStoreBundle> {
  return {
    trades: createTradesStores(),
    accounts: createAccountsStores(),
    lists: createListsStores(),
    settings: createSettingsStores(),
  };
}

// ─── Tier 2 resolution stores (§8.2) — Phase 5e ───────────────────────
// Independent of `LocalStoreBundle` above (see localStores.ts's own
// header for why) — the concrete wiring for `Tier2ResolutionStore`,
// same layering as everything else in this file: real `load`/`save`
// (and, for singletons, `remove`) functions from the resolver
// (services/localDatabase.ts, Phase 6f), injected into src/sync/'s
// generic factories.

export function createTradesTier2ResolutionStore(): Tier2ResolutionStore {
  return createCollectionTier2ResolutionStore<RawTrade>(
    () => loadTrades(),
    (items) => saveTrades(items),
  );
}

export function createAccountsTier2ResolutionStore(): Tier2ResolutionStore {
  return createCollectionTier2ResolutionStore<Account>(
    async () => (await loadAccounts()) ?? [],
    (items) => saveAccounts(items),
  );
}

export function createListsTier2ResolutionStore(): Tier2ResolutionStore {
  return createSingletonTier2ResolutionStore(
    () => loadLists() as Promise<SingletonRecord<Record<string, unknown>> | null>,
    (record) => saveLists(record),
    () => removeLists(),
  );
}

export function createSettingsTier2ResolutionStore(): Tier2ResolutionStore {
  return createSingletonTier2ResolutionStore(
    () => loadSettings() as Promise<SingletonRecord<Record<string, unknown>> | null>,
    (record) => saveSettings(record),
    () => removeSettings(),
  );
}

/** All four tables' Tier 2 resolution stores, in §6.3's fixed table order. */
export function createAllTier2ResolutionStores(): Record<SyncTableName, Tier2ResolutionStore> {
  return {
    trades: createTradesTier2ResolutionStore(),
    accounts: createAccountsTier2ResolutionStore(),
    lists: createListsTier2ResolutionStore(),
    settings: createSettingsTier2ResolutionStore(),
  };
}
