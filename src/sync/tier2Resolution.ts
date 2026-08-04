// Tier 2 resolving actions — SYNC_ARCHITECTURE_SPEC.md §8.2.
//
// Phase 5e. Implements the two RESOLVING dialog actions' own
// algorithms ("Upload Local Data", "Use Cloud Data"). Mirrors the
// established purity boundary (pushManager.ts/pullManager.ts/
// conflictDetector.ts): storage and network access only through
// injected interfaces, never a concrete import. "Single upload
// path"/"single pull path" (§8.2, §10) is preserved exactly:
//   - "Upload Local Data" performs no upload of its own at all — its
//     own binding invariant. It only marks records dirty and returns;
//     the actual push happens through whichever trigger the caller
//     runs afterward (components/sync/SyncConflictReview.tsx uses the
//     live SchedulerCore singleton's existing immediate-push fast
//     path — reached one layer up because it requires that live
//     instance, which this module deliberately never imports).
//   - "Use Cloud Data" reuses `runPullOperation` (pullManager.ts)
//     verbatim for step 3. It does not implement its own pull.
//
// WHY "UPLOAD LOCAL DATA" MARKS *EVERY* RECORD, NOT JUST THE ONE(S)
// THAT TRIGGERED THE ESCALATION: §8.2 never actually says "mark only
// the conflicting record(s)" — it says "marks the relevant divergent
// local records dirty." Its sibling action, "Use Cloud Data," is
// explicit that its own step 1 applies to "every local record in each
// affected table," not a scoped subset. Reading "Upload Local Data"
// as the same whole-table scope is the only interpretation that (a)
// stays symmetric with its sibling — the dialog is a table-level,
// mutually exclusive "trust local" vs. "trust cloud" choice, never a
// per-record cherry-pick the spec describes no UI for — and (b) is a
// no-op for rule 1's first-sync case, where every record is already
// dirty/baseUpdatedAt:null from the Step 3 stamping pass, exactly as
// "the relevant divergent records" would already be in that scenario.
//
// WHY "USE CLOUD DATA" STEP 3 CALLS `runPullOperation` DIRECTLY
// INSTEAD OF GOING THROUGH THE SCHEDULER: a Scheduler-driven cycle
// re-evaluates Tier 2 rule 1 admission (`hasRecordsWithNullBaseUpdatedAt`)
// BEFORE running push/pull for a table (scheduler.ts's `runOneCycle`).
// Step 1 below just set every record's `baseUpdatedAt` to `null` and
// step 2 reset the cursor to `(null, null)` — routing the pull back
// through the Scheduler at that point would satisfy rule 1's condition
// immediately and re-escalate this exact table before the pull the
// user just asked for ever ran, which would never terminate. Calling
// Pull Manager directly is therefore a correctness requirement, not
// merely an implementation-simplicity choice.
//
// SCOPE BOUNDARY: this module does NOT call `resolveTierTwoReview`
// (scheduler.ts) — design decision 4 there keeps that purely
// mechanical and deliberately separate from "having actually performed
// one of these two actions." The caller calls it only after this
// module's result indicates success, per §8.2's own ordering ("nothing
// local is destroyed until the cloud replacement has actually arrived
// and been applied" / "if the pull fails partway, nothing is purged").

import { runPullOperation, type PullTransport, type PullRecordStore, type PullOperationResult } from '@sync/pullManager.js';
import type { Tier2ResolutionStore } from '@sync/localStores.js';
import { PULL_BOOTSTRAP_TIMESTAMP_SENTINEL } from '@sync/scheduler.js';

/**
 * "Upload Local Data" (§8.2). Marks every local record in this table
 * dirty/pending_delete. Performs no network I/O and no upload of its
 * own — see this module's header.
 */
export async function resolveUploadLocalData(resolutionStore: Tier2ResolutionStore): Promise<void> {
  await resolutionStore.markAllDirtyForUpload();
}

export interface UseCloudDataResult {
  /**
   * True only if the pull (step 3) completed without stopping early
   * due to a failure. Gates step 4's purge and the caller's
   * `resolveTierTwoReview` call, per §8.2 step 5: "If the pull fails
   * partway, nothing is purged and no local content has been lost."
   */
  success: boolean;
  pull: PullOperationResult;
}

/**
 * "Use Cloud Data" (§8.2), steps 1-4. Step 5 (a failed attempt simply
 * retries) is satisfied structurally: this function's only permanent,
 * hard-to-reverse side effect (the purge) is gated on `success`, and
 * step 1 never leaves a record worse off than "eligible to be
 * re-pulled" — a failed attempt can always be repeated by calling this
 * function again.
 */
export async function resolveUseCloudData(
  resolutionStore: Tier2ResolutionStore,
  pullStore: PullRecordStore,
  pullTransport: PullTransport,
): Promise<UseCloudDataResult> {
  // Step 1 — every local record: synced, baseUpdatedAt/deletedAt null,
  // failure/backoff cleared, conflictResolutionLog emptied. Content
  // untouched. None of these records can produce a Tier 1 conflict
  // during the pull that follows, since none of them are dirty/syncing.
  await resolutionStore.resetAllMetadataForCloudRefresh();

  // Step 2 — one of INV-3's two sanctioned backward cursor resets.
  await pullStore.advanceCursor({ updatedAt: null, id: null });

  // Step 3 — a full pull for this table, via the existing Pull Manager
  // (see this module's header for why this bypasses the Scheduler).
  const lastServerObservedAt = await pullStore.getLastServerObservedAt();
  const nowServerTimestamp = lastServerObservedAt ?? PULL_BOOTSTRAP_TIMESTAMP_SENTINEL;
  const pull = await runPullOperation(pullStore, pullTransport, nowServerTimestamp);
  const success = !pull.stoppedEarlyDueToFailure;

  // Steps 4-5.
  if (success) {
    await resolutionStore.purgeOrphanedSyncedRecords();
  }

  return { success, pull };
}
