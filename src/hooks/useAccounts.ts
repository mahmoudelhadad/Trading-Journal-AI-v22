/**
 * hooks/useAccounts.ts
 *
 * Phase 2A hook — manages trading accounts.
 *
 * Replicates EXACTLY the accounts state and CRUD functions from
 * the original App component:
 *
 *   var as = useState(DEFAULT_ACCOUNTS);
 *   var accounts = as[0], setAccounts = as[1];
 *
 *   useEffect(function() {
 *     var a = LS.get('fxj_v4_accounts');
 *     if (a && Array.isArray(a) && a.length) setAccounts(a);
 *   }, []);
 *
 *   useEffect(function() {
 *     LS.set('fxj_v4_accounts', accounts);
 *   }, [accounts]);
 *
 *   function addAccount(a)  { setAccounts(p => p.concat([a])); }
 *   function editAccount(a) { setAccounts(p => p.map(x => x.id === a.id ? a : x)); }
 *   function delAccount(id) { setAccounts(p => p.filter(a => a.id !== id)); }
 *
 * Backward compatibility: FULLY PRESERVED
 * - Same LocalStorage key: 'fxj_v4_accounts'
 * - Same fallback to DEFAULT_ACCOUNTS when storage is empty
 * - Same CRUD operations: add, edit, delete
 * - Account shape unchanged: { id, name, capital, color }
 *
 * Sync architecture rewrite (SYNC_ARCHITECTURE_SPEC.md §13 Step 2): the
 * Phase 4 cloud write-through layer (services/cloudSync.ts) and its
 * hydrate-once-after-migration logic have been removed. This hook is
 * pure local-storage read/write again — no network calls, no auth
 * dependency. Cross-device sync is offline until the new Sync Engine
 * is wired in (§13 Step 5); this is an explicitly sanctioned
 * intermediate state, not a regression.
 *
 * §13 Step 3 follow-up: addAccount() stamps every new account with
 * full sync metadata (createSyncMetadata()) at creation time — the
 * same §6.1 "User creates a record" -> `dirty` transition the Step 3
 * stamping pass and stampIncomingRecord() already use — so a new
 * account is sync-eligible immediately, never waiting on the next
 * app reload's stamping pass. The DEFAULT_ACCOUNTS fallback (adopted
 * when a brand-new user has nothing saved yet) is stamped the same
 * way, at the moment it's actually adopted as this user's live state
 * — never on the shared DEFAULT_ACCOUNTS constant itself, since baking
 * metadata into a module-level value would hand every distinct new
 * user the exact same syncId and load-time timestamp instead of a
 * fresh one per adoption.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { loadAccounts, saveAccounts } from '@services/localDatabase.js';
import { DEFAULT_ACCOUNTS } from '@constants/lists.js';
import type { Account, AccountContent } from '@apptypes/account.js';
import { createSyncMetadata, refreshForLocalWrite } from '@sync/record.js';
import { notifyLocalMutation } from '@sync/syncEngine.js';
import { reportLocalPersistenceFailure } from '@services/localPersistenceEvents.js';

// Phase 20 — Architecture Cleanup: Account is now defined in
// types/account.ts (the architecturally correct location — a pure
// data shape, not something that belongs inside a hook file). Re-
// exported here so every existing `import type { Account } from
// '@hooks/useAccounts.js'` call site (10+ files) continues to work
// completely unchanged. See types/account.ts for the full rationale.
export type { Account, AccountContent };

export type DeleteAccountResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'last_account' | 'referenced_by_trades' | 'not_found';
    };

export interface AccountDeletionPlan {
  result: DeleteAccountResult;
  accounts: Account[];
}

/**
 * Pure account-deletion planner. `activeTrades` is App's unfiltered
 * `rawTrades` read path, so tombstoned trades are excluded before this
 * boundary. `now` is supplied to keep repeated evaluation deterministic.
 */
export function planAccountDeletion(
  accounts: Account[],
  id: string,
  activeTrades: readonly { accountId?: string }[],
  now: string,
): AccountDeletionPlan {
  const activeCount = accounts.filter((account) => account.deletedAt === null).length;
  if (activeCount <= 1) {
    return { result: { ok: false, reason: 'last_account' }, accounts };
  }

  const target = accounts.find((account) => account.id === id && account.deletedAt === null);
  if (!target) {
    return { result: { ok: false, reason: 'not_found' }, accounts };
  }

  if (activeTrades.some((trade) => trade.accountId === id)) {
    return { result: { ok: false, reason: 'referenced_by_trades' }, accounts };
  }

  if (target.baseUpdatedAt === null) {
    return {
      result: { ok: true },
      accounts: accounts.filter((account) => account.id !== id),
    };
  }

  const withTombstone: Account = { ...target, deletedAt: now };
  const tombstoned: Account = {
    ...withTombstone,
    ...refreshForLocalWrite(withTombstone, now),
  };
  return {
    result: { ok: true },
    accounts: accounts.map((account) => (account.id === id ? tombstoned : account)),
  };
}

// ─── Types ───────────────────────────────────────────────────

export interface UseAccountsReturn {
  /**
   * All active accounts, filtered per §3.2/§9.2: an account with
   * `deletedAt` set (a pending tombstone, awaiting push) is excluded
   * here immediately, regardless of `syncStatus`. The underlying
   * storage (and what the Sync Engine's Push Manager sees via
   * services/syncStores.ts) still has it; this is a read-path-only
   * filter, not a delete.
   */
  accounts: Account[];
  /** False until the initial async load has completed (Phase 6f). See the hook body. */
  hydrated: boolean;
  /**
   * Find a single account by ID.
   * Returns undefined if not found.
   */
  getAccount: (id: string) => Account | undefined;
  /**
   * Add a new account.
   * Matches original: addAccount(a) → setAccounts(p => p.concat([a]))
   * `AccountContent` (not `Account`) — see types/account.ts: the
   * caller (AccManager.tsx) constructs a plain business-fields-only
   * object; this function is what actually stamps it (§6.1 "User
   * creates a record" -> `dirty`).
   */
  addAccount: (account: AccountContent) => void;
  /**
   * Update an existing account (matched by id).
   * Matches original: editAccount(a) → setAccounts(p => p.map(...))
   * `AccountContent`, same reasoning as `addAccount` above — the
   * caller never has (and must not need) the existing account's sync
   * metadata just to submit an edit.
   */
  editAccount: (account: AccountContent) => void;
  /**
   * Remove an account by ID only when no active raw trade references it.
   * The explicit result lets the UI distinguish both deletion guards.
   */
  deleteAccount: (
    id: string,
    activeTrades: readonly { accountId?: string }[],
  ) => DeleteAccountResult;
}

// ─── Hook ────────────────────────────────────────────────────

/**
 * useAccounts
 *
 * Provides account management with LocalStorage persistence.
 *
 * Usage:
 *   const { accounts, addAccount, editAccount, deleteAccount } = useAccounts();
 */
export function useAccounts(): UseAccountsReturn {
  // `storedAccounts` is the FULL local record set, tombstones included
  // — persists to LocalStorage and is what the Sync Engine's store
  // layer (services/syncStores.ts) sees in full. `accounts` (below) is
  // the read-path-filtered view every UI consumer gets.
  // PHASE 6f — ASYNC HYDRATION. See useSettings.ts for the full
  // rationale; the pattern is identical. Initial state is the
  // DEFAULT_ACCOUNTS fallback the old synchronous initializer used when
  // storage was empty; the hydration effect replaces it if storage held
  // accounts. Fresh metadata per adoption (§6.1: "User creates a record"
  // -> dirty) — never stamp the shared DEFAULT_ACCOUNTS constant itself.
  const [storedAccounts, setStoredAccounts] = useState<Account[]>(
    () => (DEFAULT_ACCOUNTS as AccountContent[]).map((a) => ({ ...createSyncMetadata(), ...a })),
  );
  const [hydrated, setHydrated] = useState(false);
  /** Audit Issue #1 — see useSettings.ts for the full rationale. */
  const [loadFailed, setLoadFailed] = useState(false);

  // Cancellation only, no "already started" ref guard — see useSettings.ts
  // for why a ref guard would deadlock hydration under <React.StrictMode>.
  // Read-failure handling (audit Issue #1) also mirrors useSettings.ts.
  useEffect(() => {
    let cancelled = false;
    loadAccounts()
      .then((saved) => {
        if (cancelled) return;
        // Matches original: if (a && Array.isArray(a) && a.length) setAccounts(a)
        if (saved) setStoredAccounts(saved as Account[]);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadFailed(true);
        reportLocalPersistenceFailure('accounts', err);
      })
      .finally(() => {
        if (!cancelled) setHydrated(true);
      });
    return () => { cancelled = true; };
  }, []);

  // Persist whenever accounts change — never before hydration, and never
  // after a failed read (which would replace the user's real accounts
  // with DEFAULT_ACCOUNTS — see useSettings.ts). Matches original:
  // useEffect(() => LS.set('fxj_v4_accounts', accounts), [accounts])
  useEffect(() => {
    if (!hydrated || loadFailed) return;
    // Phase 6g-1 (BD-1): see useTrades.ts for the full rationale.
    saveAccounts(storedAccounts).catch((err) => reportLocalPersistenceFailure('accounts', err));
  }, [storedAccounts, hydrated, loadFailed]);

  // ── Read-path filtering (§3.2, §9.2) ──────────────────────
  // A tombstoned account (deletedAt set) is excluded here, immediately,
  // regardless of syncStatus.
  const accounts = useMemo(
    () => storedAccounts.filter((a) => a.deletedAt === null),
    [storedAccounts],
  );

  /**
   * Find account by ID — memoised lookup helper.
   */
  const getAccount = useCallback(
    (id: string): Account | undefined => accounts.find((a) => a.id === id),
    [accounts],
  );

  /**
   * Add a new account.
   * Matches original: setAccounts(p => p.concat([a]))
   */
  const addAccount = useCallback((account: AccountContent) => {
    const stamped = { ...createSyncMetadata(), ...account };
    setStoredAccounts((prev) => [...prev, stamped]);
    notifyLocalMutation('accounts');
  }, []);

  /**
   * Update an existing account (matched by id).
   * Matches original: setAccounts(p => p.map(x => x.id === a.id ? a : x))
   * — EXCEPT for how the replacement is built (see the Phase 5a note
   * this comment used to carry: wholesale-replacing with the caller's
   * plain business-fields-only object silently discarded sync
   * metadata; fixed by merging instead). Phase 5c completes that fix:
   * §5.1/§6.1 "user edits" -> `dirty` — refreshForLocalWrite() marks
   * the record dirty with a fresh localUpdatedAt, preserving syncId/
   * baseUpdatedAt/backoff state exactly as record.ts's own contract
   * requires.
   */
  const editAccount = useCallback((account: AccountContent) => {
    setStoredAccounts((prev) =>
      prev.map((a) => {
        if (a.id !== account.id) return a;
        const merged: Account = { ...a, ...account };
        return { ...merged, ...refreshForLocalWrite(merged) };
      }),
    );
    notifyLocalMutation('accounts');
  }, []);

  /**
   * Remove an account by ID — §9.2 lifecycle (§9.1 explicitly includes
   * Accounts in tombstone scope, same as Trades):
   *   - Never synced (baseUpdatedAt === null): purge locally
   *     immediately, no network call (step 2).
   *   - Otherwise: set deletedAt + mark pending_delete, kept in
   *     storage until the Push Manager's tombstone push succeeds.
   * Guard: if only one ACTIVE account remains, deletion is blocked to
   * prevent orphaned trades — counts active (non-tombstoned) accounts,
   * not raw storage rows, matching what the user actually perceives as
   * "how many accounts do I have." Matches original AccManager guard
   * (accounts.length > 1) in spirit.
   */
  const deleteAccount = useCallback((
    id: string,
    activeTrades: readonly { accountId?: string }[],
  ): DeleteAccountResult => {
    const now = new Date().toISOString();
    let result: DeleteAccountResult = { ok: false, reason: 'not_found' };

    // Called only from AccManager's Delete click. flushSync makes the
    // latest-state updater decision available before that event returns.
    flushSync(() => {
      setStoredAccounts((prev) => {
        const plan = planAccountDeletion(prev, id, activeTrades, now);
        result = plan.result;
        return plan.accounts;
      });
    });

    if (result.ok) notifyLocalMutation('accounts');
    return result;
  }, []);

  return { accounts, getAccount, addAccount, editAccount, deleteAccount, hydrated };
}
