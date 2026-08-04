/**
 * services/storageCutover.ts
 *
 * Phase 6d — SYNC_ARCHITECTURE_SPEC.md §13 Step 6.
 *
 * The one-time, crash-safe LocalStorage -> IndexedDB cutover:
 * sub-step 2's copy phase, sub-step 3's verification phase, sub-step 4's
 * completion marker, and sub-step 5's restart behavior. Pure
 * orchestration over two already-built primitive layers —
 * services/storage.js (the LocalStorage source, read-only here) and
 * services/indexedDbStores.ts (the IndexedDB destination, Phase 6c/6d).
 * This file contains no persistence logic of its own, exactly as
 * services/backupService.ts is pure composition over storage.js's
 * load/save pairs.
 *
 * SCOPE — 6d only, per explicit approval: the mechanism, built inert.
 * NOT wired into anything — `main.jsx`, `AuthContext.tsx`,
 * `syncEngine.ts`, and `scheduler.ts` are all untouched, and nothing
 * imports this file. No namespacing (§3.5 / AN-015 item 2 remains
 * exactly as deferred as it already was). No AN-015 item addressed.
 *
 * ─── PRECONDITIONS (binding on the caller, not enforced here) ─────────
 *
 * Sub-step 0 places two gates on this cutover. Both are *sequencing*
 * decisions owned by whoever invokes it, not by the operation itself —
 * the same split pullManager.ts already uses for its own Tier 2
 * admission preconditions, and the same reason scheduler.ts owns "when
 * a cycle runs" while Push/Pull Manager own "what one cycle does":
 *
 *   1. LEADER-ONLY. "The cutover is leader-only (§5.3) — exactly one
 *      tab performs it, elected by the same Web Lock that governs
 *      ongoing sync; follower tabs wait on the completion marker and
 *      keep reading LocalStorage until it appears." This module does
 *      not call `isLeader()` and does not import Cross-Tab Coordinator.
 *      A caller that invokes `runStorageCutover()` from a follower tab
 *      violates the precondition; the crash-safety protocol below is
 *      designed for sequential restart, NOT for concurrent writers
 *      interleaving within it (§5.3's "Migration ownership" paragraph
 *      says exactly this).
 *   2. AUTHENTICATED USER REQUIRED. "It runs only once an
 *      authenticated `user_id` is available... if no user is signed in,
 *      the cutover is deferred until sign-in completes."
 *
 * ─── DISCLOSED DEVIATION — sub-step 0's stated rationale ──────────────
 *
 * Sub-step 0 justifies gate 2 with "because every record it writes must
 * land in that user's namespace (§3.5)". Per-user namespacing does not
 * exist in this codebase (MIGRATION_NOTES.md AN-015 item 2, deliberately
 * deferred), and Phase 6c built the IndexedDB layer without it by
 * explicit decision. The gate is therefore implementable but its
 * rationale is not, and this cutover copies into a single shared,
 * un-namespaced IndexedDB database.
 *
 * Traced consequence, stated plainly rather than glossed: on a shared
 * device, a second user signing in reads the first user's migrated
 * IndexedDB data. That is byte-for-byte the same defect AN-015 item 2
 * already documents for LocalStorage today (both users already share
 * `fxj_v4_trades`), including for the completion marker, which is
 * likewise global. So this cutover carries the existing limitation
 * forward unchanged — it does NOT introduce a new one, and does not
 * make the existing one worse. Closing it remains AN-015 item 2's own
 * separately-scoped work.
 *
 * ─── WHY THE COPY IS ALWAYS FULL, NEVER RESUMED ──────────────────────
 *
 * Sub-step 5: "the previous cutover attempt (if any) is treated as
 * incomplete, regardless of how far it got. Do not attempt to resume a
 * partial copy. Instead, discard whatever partial IndexedDB business
 * data exists (safe — it was never marked authoritative) and restart
 * the entire copy phase from LocalStorage, which remains untouched and
 * correct throughout." `runStorageCutover()` therefore ALWAYS begins by
 * discarding, and there is deliberately no resume path anywhere in this
 * file — nor any per-store progress state to build one from (see
 * `MigrationStateRecord`'s own note in indexedDbStores.ts).
 *
 * ─── LOCALSTORAGE IS NEVER WRITTEN ───────────────────────────────────
 *
 * Sub-step 2 ("LocalStorage is only ever *read* during this phase,
 * never modified or cleared") and sub-step 6 ("LocalStorage data is
 * *not* cleared immediately — retained for a window as a rollback
 * safety net") are both satisfied structurally: this module imports
 * only `load*` functions from storage.js and no `save*`/`storageRemove`
 * at all, so it has no means of writing LocalStorage even by mistake.
 * The retention *window* itself (deciding when the safety net expires
 * and may be cleared) is not implemented in this phase and has no code
 * here — LocalStorage is simply retained indefinitely for now.
 */

import {
  loadTrades,
  loadAccounts,
  loadLists,
  loadSettings,
  loadSyncCursors,
} from '@services/storage.js';
import {
  saveTradesIndexedDb,
  saveAccountsIndexedDb,
  saveListsIndexedDb,
  saveSettingsIndexedDb,
  indexedDbCursors,
  clearBusinessDataIndexedDb,
  countBusinessRecordsIndexedDb,
  loadMigrationStateIndexedDb,
  saveMigrationStateIndexedDb,
  MIGRATION_STATE_ID,
  type BusinessStoreName,
} from '@services/indexedDbStores.js';
import { runSyncMetadataStampingPass } from '@sync/stamp.js';
import { SYNC_TABLE_ORDER, type SyncTableName } from '@sync/scheduler.js';
import type { TableCursorRow } from '@sync/localStores.js';
import type { SingletonRecord } from '@sync/record.js';
import type { RawTrade } from '@apptypes/trade.js';
import type { Account } from '@apptypes/account.js';

/**
 * How many times the copy may be restarted because the LocalStorage
 * source changed underneath it before the marker could be written. Bounds
 * the option-A re-check loop so continuous concurrent writing degrades to
 * "try again next load" rather than spinning.
 */
const MAX_CUTOVER_ATTEMPTS = 3;

// ─── Result types ──────────────────────────────────────────────────────

export interface StoreCountMismatch {
  store: BusinessStoreName;
  source: number;
  copied: number;
}

export type CutoverOutcome =
  /** The completion marker was already present — nothing was discarded, copied, or written. */
  | { kind: 'already_complete' }
  /** Copy + verification both succeeded; the completion marker is now written. */
  | { kind: 'completed'; counts: Record<BusinessStoreName, number> }
  /** Verification found a per-store count mismatch. Marker NOT written — the next attempt restarts from scratch (sub-step 5). */
  | { kind: 'verification_failed'; mismatches: StoreCountMismatch[] }
  /** A read/write threw. Marker NOT written — the next attempt restarts from scratch (sub-step 5). */
  | { kind: 'failed'; error: string }
  /**
   * The LocalStorage source kept changing underneath the copy (another
   * tab writing while this one migrated), so the copy could never be
   * proven current. Marker NOT written; retries on the next load,
   * exactly like every other non-completing outcome (sub-step 5).
   */
  | { kind: 'source_changed'; attempts: number };

// ─── Sub-step 5's gate ─────────────────────────────────────────────────

/**
 * Sub-step 5: "on every app load, before trusting IndexedDB for any
 * business-data read or write, check for the completion marker."
 *
 * FAILS SAFE TOWARD LOCALSTORAGE: returns `false` — not a thrown
 * error — if IndexedDB cannot even be opened or read. This is a gate
 * answering "may I trust IndexedDB yet?", and an unreadable IndexedDB
 * answers that unambiguously: no. §5.3 already prescribes exactly this
 * fallback behavior ("keep reading LocalStorage until it appears"), so
 * collapsing every failure to `false` here produces the specified
 * outcome rather than hiding a decision. A caller needing to
 * distinguish "marker genuinely absent" from "IndexedDB unavailable"
 * can call `loadMigrationStateIndexedDb()` directly, which still throws.
 */
export async function isCutoverComplete(): Promise<boolean> {
  try {
    const state = await loadMigrationStateIndexedDb();
    return state?.cutoverCompletedAt != null;
  } catch {
    return false;
  }
}

// ─── Source-side counts (sub-step 3's "LocalStorage source" half) ──────
//
// COUNT CONVENTIONS, made explicit rather than left implicit — the
// three stored shapes count differently:
//   - Collections (trades, accounts): array length.
//   - Singletons (lists, settings): 0 or 1 — §3.1's "exactly one row
//     per user"; `loadLists`/`loadSettings` return `null` when nothing
//     is stamped yet, which is a legitimate count of 0, not an error.
//   - sync_cursors: the number of table rows present in the stored map
//     (0-4), NOT a fixed 4 — see `copySyncCursors` for why only the
//     rows that actually exist are copied.

interface SourceSnapshot {
  trades: RawTrade[];
  accounts: Account[] | null;
  lists: SingletonRecord<Record<string, unknown>> | null;
  settings: SingletonRecord<Record<string, unknown>> | null;
  cursors: Array<[SyncTableName, TableCursorRow]>;
}

function isSyncTableName(value: string): value is SyncTableName {
  return (SYNC_TABLE_ORDER as readonly string[]).includes(value);
}

function readSource(): SourceSnapshot {
  const rawCursors = loadSyncCursors() as Record<string, TableCursorRow>;
  return {
    trades: loadTrades() as RawTrade[],
    accounts: loadAccounts() as Account[] | null,
    lists: loadLists() as SingletonRecord<Record<string, unknown>> | null,
    settings: loadSettings() as SingletonRecord<Record<string, unknown>> | null,
    // Unknown keys are filtered out of BOTH the copy and the source
    // count, so the two sides stay consistent and an unrecognized key
    // can never manufacture a spurious verification failure.
    cursors: Object.entries(rawCursors).filter((entry): entry is [SyncTableName, TableCursorRow] =>
      isSyncTableName(entry[0]),
    ),
  };
}

function countSource(source: SourceSnapshot): Record<BusinessStoreName, number> {
  return {
    trades: source.trades.length,
    accounts: source.accounts?.length ?? 0,
    lists: source.lists ? 1 : 0,
    settings: source.settings ? 1 : 0,
    sync_cursors: source.cursors.length,
  };
}

// ─── Sub-step 2's copy phase ───────────────────────────────────────────

async function copySyncCursors(cursors: Array<[SyncTableName, TableCursorRow]>): Promise<void> {
  // Only the rows that actually exist in LocalStorage are written —
  // deliberately NOT one row per table in SYNC_TABLE_ORDER. Writing all
  // four unconditionally would leave IndexedDB holding more rows than
  // the source, failing sub-step 3's exact-count verification for a
  // device that has only ever synced some of its tables.
  //
  // `indexedDbCursors.set` is a read-modify-write over
  // DEFAULT_CURSOR_ROW; since the store was just cleared and a complete
  // `TableCursorRow` is passed as the patch, the merged result equals
  // the source row exactly.
  for (const [table, row] of cursors) {
    await indexedDbCursors.set(table, row);
  }
}

async function runCopyPhase(source: SourceSnapshot): Promise<void> {
  await saveTradesIndexedDb(source.trades);
  // `loadAccounts()` returns null for "nothing saved yet" — an empty
  // copy, not a reason to skip. Passing [] keeps the destination store
  // in the same empty state the source is in.
  await saveAccountsIndexedDb(source.accounts ?? []);
  if (source.lists) await saveListsIndexedDb(source.lists);
  if (source.settings) await saveSettingsIndexedDb(source.settings);
  await copySyncCursors(source.cursors);
}

// ─── Sub-step 3's verification phase ───────────────────────────────────

function findMismatches(
  expected: Record<BusinessStoreName, number>,
  actual: Record<BusinessStoreName, number>,
): StoreCountMismatch[] {
  const mismatches: StoreCountMismatch[] = [];
  for (const store of Object.keys(expected) as BusinessStoreName[]) {
    if (expected[store] !== actual[store]) {
      mismatches.push({ store, source: expected[store], copied: actual[store] });
    }
  }
  return mismatches;
}

// ─── The cutover ───────────────────────────────────────────────────────

/**
 * Runs the full §13 Step 6 cutover: discard any partial prior attempt,
 * copy all five stores from LocalStorage, verify per-store counts, and
 * — only if verification passes — write the completion marker as the
 * last write of the entire operation (sub-step 4).
 *
 * Safe to call when already complete (returns `already_complete`
 * without touching anything) and safe to call repeatedly after a
 * failure — every failure path leaves the marker unwritten, which is
 * precisely what makes the next attempt restart from scratch
 * (sub-step 5). LocalStorage remains untouched and authoritative
 * throughout, so no failure here can lose data.
 *
 * Preconditions (leader-only, authenticated user) are the caller's to
 * enforce — see this module's header.
 */
export async function runStorageCutover(): Promise<CutoverOutcome> {
  try {
    if (await isCutoverComplete()) {
      return { kind: 'already_complete' };
    }

    for (let attempt = 1; attempt <= MAX_CUTOVER_ATTEMPTS; attempt += 1) {
      // Sub-step 5: always discard first, never resume.
      await clearBusinessDataIndexedDb();

      // §13 Step 3's stamping pass, BEFORE the snapshot — so that what
      // gets copied is guaranteed to already carry the full §3.2 metadata
      // set ("in the Step 3 shape (sync metadata included)", sub-step 2).
      //
      // THIS ORDERING IS LOAD-BEARING, NOT COSMETIC: every IndexedDB
      // business store keys on `syncId` (services/indexedDbStores.ts), so
      // an unstamped record cannot be written at all — `putAll` fails with
      // "Evaluating the object store's key path did not yield a value".
      // Stamping after the copy would therefore be unreachable for exactly
      // the legacy data it exists to rescue, because the copy would have
      // already aborted.
      //
      // This is the SAME single implementation main.jsx calls — not a
      // second one. Invoking it from both places is intentional: main.jsx
      // keeps behavior identical while the marker is absent (and while the
      // cutover flag is off, when this function never runs at all), and
      // this call is the real safety net if unstamped legacy data ever
      // reaches the cutover by another route. It is idempotent at record
      // granularity, so on the common path — main.jsx having already
      // stamped before React rendered — it writes nothing.
      runSyncMetadataStampingPass();

      // Read the source ONCE, after the discard and stamping, and use that
      // single snapshot for both the copy and the expected counts —
      // reading it twice could straddle a concurrent LocalStorage write
      // from a hook in this same tab and produce a spurious mismatch
      // between data that was actually copied correctly.
      const source = readSource();
      const expected = countSource(source);

      await runCopyPhase(source);

      const actual = await countBusinessRecordsIndexedDb();
      const mismatches = findMismatches(expected, actual);
      if (mismatches.length > 0) {
        return { kind: 'verification_failed', mismatches };
      }

      // WRITE-WINDOW MITIGATION (approved option A). Between the snapshot
      // above and the marker below, another tab's hooks may have written
      // to LocalStorage; such a write is NOT in the copy, and once the
      // marker exists it would become invisible — silent data loss
      // (Principle 1). Re-reading here and restarting on any difference
      // narrows that window from "the whole copy+verify" to "one
      // IndexedDB put". Deliberately NOT a lock or any other
      // synchronization primitive, per the approved decision: this cannot
      // block or delay a writer in any tab, so it introduces no new
      // application behavior.
      const recheck = readSource();
      if (JSON.stringify(source) !== JSON.stringify(recheck)) {
        // Restart from the top — discard, re-snapshot, re-copy. Never a
        // partial resume (sub-step 5).
        continue;
      }

      // Sub-step 4 — the last write of the entire cutover.
      await saveMigrationStateIndexedDb({
        id: MIGRATION_STATE_ID,
        cutoverCompletedAt: new Date().toISOString(),
      });

      return { kind: 'completed', counts: actual };
    }

    // Bounded, so continuous concurrent writing cannot spin forever. No
    // marker was written, so this is simply retried on the next load —
    // identical in effect to every other non-completing outcome.
    return { kind: 'source_changed', attempts: MAX_CUTOVER_ATTEMPTS };
  } catch (err) {
    return { kind: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
