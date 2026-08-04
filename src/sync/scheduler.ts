// Scheduler — SYNC_ARCHITECTURE_SPEC.md §5.2, §6.1, §6.2, §6.3, §8.2, INV-2.
//
// Built incrementally across Phase 4f's three checkpoints. THIS FILE
// now contains Phase 4f-i (Scheduler Core) AND Phase 4f-ii (Scheduler
// Policy):
//   4f-i:
//     - a single push -> pull cycle, per table, in the fixed table order,
//     - INV-2 serialization (one cycle at a time; a full-cycle trigger
//       arriving mid-cycle sets a single "run again" flag; an
//       immediate-push trigger arriving mid-cycle is dropped),
//     - leader gating via an injected `isLeader()` check only.
//   4f-ii:
//     - startup reconciliation (§6.1) — runs once, before this
//       Scheduler Core instance's first cycle,
//     - Tier 2 rule 1-4 aggregation (§8.2) — pausing push/pull for
//       affected tables until explicitly resolved,
//     - session-state management (§6.2: idle -> syncing ->
//       {in_sync|needs_structural_review|error_retrying} -> idle),
//     - broadcasting session status and Tier 2 state via injected
//       functions matching crossTabCoordinator's shape.
//
// 4f-iii adds cross-cycle ambiguous-failure tracking (§10) to THIS
// file (Scheduler-owned state, per the Phase 4c/4f-i agreement — see
// the dedicated section below). The five §6.3 triggers and §5.4
// singleton discipline are NOT in this file — they live in the new
// src/sync/syncEngine.ts, the "top-level entry point" this file's own
// comments have referred to since Phase 4f-i, which is the one place
// real browser timers/listeners and the real Cross-Tab
// Coordinator/Online Monitor get wired together.
//
// RESPONSIBILITY BOUNDARY: this module orchestrates the already-built
// Push Manager, Pull Manager, and Conflict Detector's Tier 2 rule
// functions, plus injected leader/broadcast hooks — it does not
// perform push/pull logic itself, evaluate conflicts itself (it only
// calls the already-approved pure rule functions), mutate business
// records directly, own browser events, own retry timing, own online
// detection, or invent cross-tab messaging policy (it calls the
// injected broadcast functions; whether/how those actually reach
// other tabs is Cross-Tab Coordinator's concern, not this module's).
// `createSchedulerCore` remains a plain factory (not module-level
// singleton state) — §5.4's singleton discipline still applies to
// whatever the eventual top-level entry point is (Phase 4f-iii).
//
// NEW STORAGE DEPENDENCIES THIS PHASE: neither `PushRecordStore` nor
// `PullRecordStore` (both already approved, Phases 4c/4d) expose "find
// every record in `syncing` state" or "does this table have any record
// with `baseUpdatedAt = null`" — because those were never Push/Pull
// Manager's concern. Rather than extend either approved interface,
// this phase introduces two small, additional, table-scoped
// interfaces (`ReconciliationStore`, `Tier2AdmissionStore`) for
// exactly these two queries, following the same pattern already used
// for `PushRecordStore`/`PullRecordStore` themselves.
//
// TABLE ORDER / PER-TABLE PUSH-THEN-PULL ORDERING / BOOTSTRAPPING
// nowServerTimestamp: unchanged from Phase 4f-i — see below. The
// bootstrapping fallback's safety condition ("this module does not
// yet perform Tier 2 admission gating") is now CLOSED by this phase:
// rule 1 admission is checked before a table's pull ever runs, so a
// table with pre-existing `baseUpdatedAt = null` records is routed to
// Tier 2 review instead of ever reaching Pull Manager with a
// possibly-inaccurate `nowServerTimestamp`. The sentinel itself is
// unchanged (still needed for a genuinely first-ever pull with no
// local records and nothing to conflict with) but the one scenario
// where its inaccuracy could have mattered no longer reaches it.
//
// TABLE ORDER: the specification never states an explicit processing
// order in one sentence, but every place all four tables are
// enumerated together (§1's system diagram, §4's schema table, §13
// Step 3's stamping pass) lists them in the same order: trades,
// accounts, lists, settings. This module treats that as the
// authoritative fixed order.
//
// PUSH-THEN-PULL ORDERING, PER TABLE: applied per table (push A, pull
// A, then push B, pull B, ...), not as two global phases — see the
// Phase 4f-i report for the full reasoning; unchanged this phase.
//
// ── Design decisions made this phase (documented up front, not
// silently decided — see the implementation report for the full
// reasoning behind each) ──
//
// 1. STARTUP RECONCILIATION TRIGGER: §5.3 ties reconciliation to
//    "becoming leader," which is a Cross-Tab-Coordinator/browser-Lock
//    event — explicitly out of scope this phase ("no browser events").
//    This module instead runs reconciliation exactly once, before
//    THIS SchedulerCore INSTANCE's first cycle, regardless of what
//    triggered that first `requestCycle()` call. This is a reasonable
//    proxy for "becoming leader" because, per §5.3, "only the leader
//    instantiates the rest of this component list" — in real usage
//    (once Phase 4f-iii wires everything together) a SchedulerCore is
//    only ever created for a tab that already is leader, so its first
//    cycle IS that tab's first cycle as leader.
//
// 2. [POLICY DECISION — TIER 2 RULE EVALUATION TIMING. This is a
//    TIMING POLICY this module adopted, not literal specification
//    text: §8.2 states THAT push/pull must pause for an affected
//    table, never precisely WHEN within a cycle each rule must be
//    checked.]
//      - Rules 1 ("first sync") and 3 ("expired retention window")
//        are evaluated BEFORE that table's push/pull runs, each cycle
//        — therefore they PREVENT push/pull for that table in the
//        SAME cycle they are detected in.
//      - Rule 2 ("conflict volume") cannot be evaluated until every
//        table has completed this cycle — it is a global count across
//        all four tables' pulls — so it can only ever take effect
//        starting the NEXT cycle; it never retroactively undoes what
//        the current cycle already applied.
//      - Rule 4 ("repeated conflict") is detected per-record inside
//        Pull Manager already (`escalate_tier2`); this module only
//        notices a table's `escalatedCount > 0` after that table's own
//        pull and marks it — same next-cycle timing as rule 2, since
//        it is discovered mid/after that table's own processing, not
//        before it.
//
// 3. A TABLE STAYS MARKED UNTIL EXPLICITLY RESOLVED: once any rule
//    marks a table, it is skipped on every subsequent cycle until
//    `resolveTierTwoReview(table)` is called — this module does not
//    attempt to silently "un-escalate" a table by re-deriving rules
//    1/3 as no-longer-true, since §8.2 frames resolution as an
//    explicit user action (Upload Local Data / Use Cloud Data), not
//    something that happens by the condition merely becoming false.
//
// 4. `resolveTierTwoReview` IS MECHANICAL ONLY: it clears the pause
//    flag and broadcasts `resolved` — it does not implement "Upload
//    Local Data" or "Use Cloud Data" (§8.2's actual resolution
//    actions). Those involve marking records dirty / resetting
//    cursors and are out of this phase's four-item scope; a later
//    phase is expected to call `resolveTierTwoReview` only after
//    having actually performed one of those two actions.
//
// 5. [POLICY DECISION — SESSION-STATE PRIORITY. This is a policy for
//    REPRESENTING one session state when table-level results differ —
//    it is not a rule derived directly from the specification.] The
//    §6.2 diagram presents `in_sync` / `needs_structural_review` /
//    `error_retrying` as one cycle's single outcome, but different
//    tables can independently hit different conditions in the same
//    cycle (e.g. one table needs review while another's pull failed).
//    This module resolves that down to one broadcastable value using a
//    fixed priority order:
//
//        needs_structural_review > error_retrying > in_sync
//
//    (`needs_structural_review` wins if ANY table is currently marked,
//    from this cycle or an earlier one; `error_retrying` wins if any
//    table had an unexpected error or a Pull Manager page-level
//    failure this cycle; otherwise `in_sync`.) This priority order
//    does NOT change which tables are actually paused or skipped —
//    `tablesNeedingReview` governs that independently of it.
//
// 6. `error_retrying` DEFINITION: triggered only by a table's
//    unexpected exception (`error !== null`) or Pull Manager's
//    `stoppedEarlyDueToFailure`. Deliberately NOT triggered by
//    ordinary per-record push failures (`push.failedCount > 0`) —
//    §11 attributes those to "the pending-changes indicator," a
//    separate, per-record UI signal (out of scope entirely this
//    phase), not the cycle-level session state. Per-record retry is
//    normal, expected, self-healing behavior, not a session-level
//    error condition.
//
// 7. [POLICY DECISION — BROADCAST CADENCE, deliberately departing from
//    a literal reading of §6.2's diagram.] `syncing` is broadcast when
//    a cycle starts. `in_sync` and `error_retrying` are TRANSIENT
//    outcomes — each describes what just happened, with nothing
//    ongoing left to report — so both are broadcast and then
//    IMMEDIATELY followed by an `idle` broadcast, matching §6.2's
//    diagram literally for these two. `needs_structural_review` is
//    PERSISTENT — §8.2: "push and pull are paused... until resolved"
//    — so it is broadcast and DELIBERATELY NOT followed by `idle`.
//    This intentionally diverges from the diagram's literal "all three
//    outcomes loop back to idle" reading: sending `idle` right after
//    `needs_structural_review` would signal that the system has
//    returned to normal while one or more tables are still paused —
//    a misleading "all clear" this module avoids sending.
//
// 8. [PHASE 4f-iii — CROSS-CYCLE AMBIGUOUS-FAILURE TRACKING (§10).
//    DEVIATION FROM LITERAL SPEC TEXT, DISCLOSED — see the
//    implementation report.] §10: "A batch... that fails via timeout
//    or any other non-definitive signal is retried, with backoff, as
//    systemic up to a threshold of N consecutive ambiguous failures
//    for the same batch composition... On the (N+1)th consecutive
//    ambiguous failure, the batch is treated as if a per-row rejection
//    had been identified and bisection begins."
//
//    THE CONSTRAINT: this tracking must live entirely in the
//    Scheduler, and Push Manager may not be modified (both explicit
//    requirements for this phase). `PushCycleResult` — Push Manager's
//    only output — carries `{succeededCount, purgedCount, failedCount,
//    newestServerTimestamp}` and nothing else; it does not, and cannot
//    without a Push Manager change, tell the caller WHICH classification
//    (systemic / per_row / ambiguous) a failure was. That classification
//    lives entirely inside `pushChunk`'s private control flow (Phase
//    4c) and was never designed to leave it.
//
//    THE CONSEQUENCE: this module cannot literally count "N consecutive
//    AMBIGUOUS failures for the same batch composition," because it
//    cannot observe which failures were ambiguous. What it CAN observe,
//    using only already-approved surface (`PushRecordStore.getPendingRecords()`
//    and `runPushCycle`'s existing, already-approved `config` override
//    parameter — no Push Manager code changes), is: did THIS TABLE's
//    entire pending queue make ANY progress this cycle (did at least
//    one record leave the pending queue, succeeded or purged)?
//
//    THE IMPLEMENTATION: if a table's pending queue makes zero progress
//    for more than `config.ambiguousFailureEscalationCount` consecutive
//    cycles, this module halves that table's EFFECTIVE push batch size
//    (floor, minimum 1) for subsequent cycles — passed to `runPushCycle`
//    via a config override, exactly like any other caller-supplied
//    config. The streak resets to zero, and the batch size resets to
//    `config.pushBatchSize`, the moment any progress is observed again.
//    Over successive stuck cycles this converges toward isolating a
//    persistently-failing record into its own batch — the same
//    end goal as §10's bisection ("a batch containing one pathologically
//    slow/malformed record cannot trap every other, healthy record in
//    it"), reached by shrinking the table's batch size across cycles
//    instead of literally halving one specific in-memory batch within
//    a single call.
//
//    THE DISCLOSED DEVIATION: because this signal is "zero progress,"
//    not "ambiguous failures specifically," it cannot distinguish an
//    ambiguous cause from a SYSTEMIC one (an auth error, a 5xx) — both
//    produce identical zero-progress cycles from this module's vantage
//    point. §10 is explicit that systemic failures must trigger
//    "whole-batch backoff-and-retry" and never bisect. This
//    implementation's batch-size reduction WILL still engage for a
//    persistently systemic failure (e.g. a sustained auth outage),
//    which is a genuine, disclosed departure from that specific
//    sentence — an unavoidable consequence of the "no Push Manager
//    changes" constraint, not an oversight. Reducing batch size during
//    a systemic outage is wasteful (more requests, no more likely to
//    succeed) but not unsafe — no data is lost or corrupted, backoff
//    still governs retry timing per record, and the batch size fully
//    recovers the instant the outage clears and any record succeeds.
//
//    NON-PERSISTENCE: this tracking is in-memory only, per
//    `SchedulerCore` instance — not a new durable record-model field
//    (the record model is frozen), not written to `sync_cursors` or
//    anywhere else. A page reload loses it and starts fresh at full
//    batch size; if the same pathological record is still present, the
//    same degradation recurs over subsequent cycles within the new
//    session.
//
//    SCOPE: applies only to full-cycle pushes (via `processTable`),
//    not to `requestImmediatePush`'s fast path, which keeps its
//    already-approved, untouched behavior (§10's language is about
//    "consecutive... across cycles," which the fast path — explicitly
//    not a cycle — falls outside of).

import { runPushCycle, type PushCycleResult, type PushRecordStore, type PushTransport } from '@sync/pushManager.js';
import { runPullOperation, type PullOperationResult, type PullRecordStore, type PullTransport } from '@sync/pullManager.js';
import {
  evaluateFirstSyncEscalation,
  evaluateConflictVolumeEscalation,
  evaluateRetentionWindowEscalation,
} from '@sync/conflictDetector.js';
import { getSyncConfig, type SyncConfig } from '@sync/config.js';

// ─── Table ordering ───────────────────────────────────────────────

export type SyncTableName = 'trades' | 'accounts' | 'lists' | 'settings';

export const SYNC_TABLE_ORDER: readonly SyncTableName[] = ['trades', 'accounts', 'lists', 'settings'];

/**
 * Fallback `nowServerTimestamp` fed to Pull Manager when a table's
 * `lastServerObservedAt` is `null`. See the file header's
 * BOOTSTRAPPING note — the one scenario where this value's accuracy
 * mattered (a table with pre-existing `baseUpdatedAt = null` records)
 * is now intercepted by Tier 2 rule 1 admission checking before this
 * is ever used for such a table.
 */
export const PULL_BOOTSTRAP_TIMESTAMP_SENTINEL = '1970-01-01T00:00:00.000Z';

// ─── Session state (§6.2) ─────────────────────────────────────────

export type SessionState = 'idle' | 'syncing' | 'in_sync' | 'needs_structural_review' | 'error_retrying';

// ─── Tier 2 (§8.2) ─────────────────────────────────────────────────

export type TierTwoRule = 1 | 2 | 3 | 4;

export interface TierTwoEscalation {
  table: SyncTableName;
  rule: TierTwoRule;
}

/**
 * Storage dependency, injected, scoped to one table, for §8.2 rule 1's
 * admission check: "the local database already contains one or more
 * records for that table with `baseUpdatedAt = null`." Separate from
 * `PullRecordStore` because that already-approved interface has no
 * reason to expose a query over every local record, only the pull
 * cursor and per-syncId lookups.
 */
export interface Tier2AdmissionStore {
  hasRecordsWithNullBaseUpdatedAt(): Promise<boolean>;
}

// ─── Startup reconciliation (§6.1) ────────────────────────────────

export interface ReconciliationRecord {
  syncId: string;
  deletedAt: string | null;
}

/**
 * Storage dependency, injected, scoped to one table, for §6.1's
 * startup reconciliation sweep. Separate from `PushRecordStore`
 * because `syncing` is explicitly excluded from the pending-queue
 * definition (§3.2) that `PushRecordStore.getPendingRecords()` is
 * contracted to return — reconciliation needs the opposite query.
 */
export interface ReconciliationStore {
  findSyncingRecords(): Promise<ReconciliationRecord[]>;
  revertSyncingRecord(syncId: string, syncStatus: 'dirty' | 'pending_delete'): Promise<void>;
}

/** §6.1's revert rule, reused verbatim from the same `deletedAt`-based branch already used in record.ts/conflictDetector.ts. */
export function reconciliationTargetStatus(deletedAt: string | null): 'dirty' | 'pending_delete' {
  return deletedAt !== null ? 'pending_delete' : 'dirty';
}

/** Reconciles one table; returns how many records were reverted (for observability/tests). */
export async function reconcileTable(store: ReconciliationStore): Promise<number> {
  const stuck = await store.findSyncingRecords();
  for (const record of stuck) {
    await store.revertSyncingRecord(record.syncId, reconciliationTargetStatus(record.deletedAt));
  }
  return stuck.length;
}

/** Reconciles every table, in the fixed order. Safe to call unconditionally (§6.1) — idempotent, since a table with nothing stuck in `syncing` is simply a no-op. */
export async function runStartupReconciliation(
  stores: Record<SyncTableName, ReconciliationStore>,
): Promise<Record<SyncTableName, number>> {
  const counts = {} as Record<SyncTableName, number>;
  for (const table of SYNC_TABLE_ORDER) {
    counts[table] = await reconcileTable(stores[table]);
  }
  return counts;
}

// ─── Cycle types ───────────────────────────────────────────────────

export interface TableSyncDependencies {
  pushStore: PushRecordStore;
  pushTransport: PushTransport;
  pullStore: PullRecordStore;
  pullTransport: PullTransport;
}

export type TableSyncDependencyMap = Record<SyncTableName, TableSyncDependencies>;

// ─── Ambiguous-failure cross-cycle tracking (§10) ────────────────
// See design decision 8 in the file header for the full reasoning,
// the constraint that produced this design, and the disclosed
// deviation it entails.

export interface AmbiguousFailureTrackingState {
  /** Consecutive full cycles in which this table's pending queue made zero progress (nothing succeeded or was purged). */
  consecutiveNoProgressCycles: number;
  /** The push batch size currently in effect for this table (starts at, and resets to, `config.pushBatchSize`). */
  effectivePushBatchSize: number;
}

/** How a table's push step is actually run — the extension point ambiguous-failure tracking hooks into. Defaults to plain `runPushCycle`, unchanged from Phase 4f-i/ii. */
export type PushRunner = (table: SyncTableName, deps: TableSyncDependencies, now: string) => Promise<PushCycleResult>;

const defaultPushRunner: PushRunner = (_table, deps, now) => runPushCycle(deps.pushStore, deps.pushTransport, now);

export interface CycleTableResult {
  table: SyncTableName;
  push: PushCycleResult | null;
  pull: PullOperationResult | null;
  /** Set only if push or pull threw unexpectedly — neither Push nor Pull Manager normally throws for network-level issues, this is a defensive catch. */
  error: string | null;
  /** True if this table's push/pull were both skipped this cycle because it is currently marked as needing Tier 2 review (§6.2). */
  skippedForReview: boolean;
}

export type UnexpectedTableErrorHandler = (
  table: SyncTableName,
  err: unknown,
  partial: { push: PushCycleResult | null; pull: PullOperationResult | null },
) => Omit<CycleTableResult, 'skippedForReview'>;

/**
 * Default unexpected-error policy: record the error message, and
 * preserve whichever of `push`/`pull` already completed before the
 * exception. Exported so a custom `UnexpectedTableErrorHandler` can
 * delegate to it instead of reimplementing it.
 */
export function defaultUnexpectedTableErrorHandler(
  table: SyncTableName,
  err: unknown,
  partial: { push: PushCycleResult | null; pull: PullOperationResult | null },
): Omit<CycleTableResult, 'skippedForReview'> {
  return { table, push: partial.push, pull: partial.pull, error: err instanceof Error ? err.message : String(err) };
}

export interface CycleResult {
  tables: CycleTableResult[];
  sessionState: SessionState;
  tablesNeedingReview: TierTwoEscalation[];
}

export interface SchedulerCoreDependencies {
  tables: TableSyncDependencyMap;
  /** Injected, matching crossTabCoordinator.isLeader() in real usage — this module never imports that module directly. */
  isLeader: () => boolean;
  /** See `UnexpectedTableErrorHandler`. Defaults to `defaultUnexpectedTableErrorHandler`. */
  onUnexpectedTableError?: UnexpectedTableErrorHandler;
  /** Per-table, for §6.1's startup reconciliation. */
  reconciliationStores: Record<SyncTableName, ReconciliationStore>;
  /** Per-table, for §8.2 rule 1's admission check. */
  tier2AdmissionStores: Record<SyncTableName, Tier2AdmissionStore>;
  /** Injected, matching crossTabCoordinator.broadcastSyncStatus() in real usage. Defaults to a no-op — this module never imports Cross-Tab Coordinator directly. */
  broadcastSyncStatus?: (status: SessionState) => void;
  /** Injected, matching crossTabCoordinator.broadcastTier2State() in real usage. Defaults to a no-op. */
  broadcastTier2State?: (state: { status: 'needs_review' | 'resolved'; table?: string }) => void;
  /** Defaults to `getSyncConfig()`, resolved once when this Scheduler Core is created. */
  config?: SyncConfig;
}

export interface SchedulerCore {
  /**
   * Requests a full push->pull cycle across every table not currently
   * marked as needing Tier 2 review, in order. Returns `null`
   * immediately, without running anything, if this tab is not the
   * leader. If a cycle is already running, this does not start a
   * second one (INV-2) — it sets a single "run again" flag
   * (deduplicated) and returns the currently in-flight cycle's
   * promise. Runs the startup reconciliation sweep (§6.1) before this
   * is ever the first cycle this instance has run.
   */
  requestCycle(): Promise<CycleResult> | null;
  /**
   * Requests a best-effort, push-only, single-table operation (§6.3's
   * immediate-push fast path). Returns `null` immediately if this tab
   * is not the leader, if anything is already running (INV-2: dropped,
   * not queued), or if the target table is currently marked as needing
   * Tier 2 review (§6.2: push is paused for an affected table exactly
   * like pull).
   */
  requestImmediatePush(table: SyncTableName): Promise<PushCycleResult> | null;
  /** True while a full cycle or an immediate push is in flight. */
  isBusy(): boolean;
  /** The most recently reached session state (§6.2). Starts at `idle`. */
  getSessionState(): SessionState;
  /** Every table currently marked as needing Tier 2 review, and which rule triggered each. */
  getTablesNeedingReview(): TierTwoEscalation[];
  /**
   * Clears a table's Tier 2 pause, allowing it to resume normal
   * push/pull on the next cycle, and broadcasts the resolved state.
   * Purely mechanical — see design decision 4 in the file header: this
   * does NOT perform "Upload Local Data"/"Use Cloud Data" itself.
   */
  resolveTierTwoReview(table: SyncTableName): void;
  /** Current ambiguous-failure tracking state per table (§10, design decision 8) — observability/testing. */
  getAmbiguousFailureTracking(): Record<SyncTableName, AmbiguousFailureTrackingState>;
}

// ─── Core per-table push+pull (unchanged from 4f-i, minus the field the caller now attaches) ──

async function processTable(
  table: SyncTableName,
  deps: TableSyncDependencies,
  onUnexpectedTableError: UnexpectedTableErrorHandler,
  pushRunner: PushRunner = defaultPushRunner,
): Promise<Omit<CycleTableResult, 'skippedForReview'>> {
  let push: PushCycleResult | null = null;
  let pull: PullOperationResult | null = null;
  try {
    const now = new Date().toISOString();
    push = await pushRunner(table, deps, now);

    const lastServerObservedAt = await deps.pullStore.getLastServerObservedAt();
    const nowServerTimestamp = lastServerObservedAt ?? PULL_BOOTSTRAP_TIMESTAMP_SENTINEL;
    pull = await runPullOperation(deps.pullStore, deps.pullTransport, nowServerTimestamp);

    return { table, push, pull, error: null };
  } catch (err) {
    return onUnexpectedTableError(table, err, { push, pull });
  }
}

// ─── Factory ───────────────────────────────────────────────────────

export function createSchedulerCore(deps: SchedulerCoreDependencies): SchedulerCore {
  const onUnexpectedTableError = deps.onUnexpectedTableError ?? defaultUnexpectedTableErrorHandler;
  const broadcastSyncStatus = deps.broadcastSyncStatus ?? (() => {});
  const broadcastTier2State = deps.broadcastTier2State ?? (() => {});
  const config = deps.config ?? getSyncConfig();

  let busy = false;
  let runAgainRequested = false;
  let inFlightCycle: Promise<CycleResult> | null = null;
  let hasReconciled = false;
  let sessionState: SessionState = 'idle';
  const tablesNeedingReview = new Map<SyncTableName, TierTwoEscalation>();
  const ambiguousTracking = new Map<SyncTableName, AmbiguousFailureTrackingState>();

  function getTrackingState(table: SyncTableName): AmbiguousFailureTrackingState {
    return ambiguousTracking.get(table) ?? { consecutiveNoProgressCycles: 0, effectivePushBatchSize: config.pushBatchSize };
  }

  /**
   * Wraps `runPushCycle` to observe whether a table's pending queue
   * made any progress, and adjusts that table's effective batch size
   * accordingly. See design decision 8 in the file header — this is
   * the ENTIRE cross-cycle ambiguous-failure tracking mechanism; no
   * Push Manager code is touched, only its existing `config` parameter
   * is supplied a table-specific override.
   */
  const trackedPushRunner: PushRunner = async (table, tableDeps, now) => {
    const before = await tableDeps.pushStore.getPendingRecords();
    const beforeIds = new Set(before.map((r) => r.syncId));

    const state = getTrackingState(table);
    const pushConfig: SyncConfig =
      state.effectivePushBatchSize === config.pushBatchSize ? config : { ...config, pushBatchSize: state.effectivePushBatchSize };
    const result = await runPushCycle(tableDeps.pushStore, tableDeps.pushTransport, now, pushConfig);

    if (beforeIds.size > 0) {
      const after = await tableDeps.pushStore.getPendingRecords();
      const afterIds = new Set(after.map((r) => r.syncId));
      const madeProgress = [...beforeIds].some((id) => !afterIds.has(id));

      if (madeProgress) {
        ambiguousTracking.set(table, { consecutiveNoProgressCycles: 0, effectivePushBatchSize: config.pushBatchSize });
      } else {
        const nextStreak = state.consecutiveNoProgressCycles + 1;
        ambiguousTracking.set(
          table,
          nextStreak > config.ambiguousFailureEscalationCount
            ? { consecutiveNoProgressCycles: 0, effectivePushBatchSize: Math.max(1, Math.floor(state.effectivePushBatchSize / 2)) }
            : { consecutiveNoProgressCycles: nextStreak, effectivePushBatchSize: state.effectivePushBatchSize },
        );
      }
    }

    return result;
  };

  function getAmbiguousFailureTracking(): Record<SyncTableName, AmbiguousFailureTrackingState> {
    const result = {} as Record<SyncTableName, AmbiguousFailureTrackingState>;
    for (const table of SYNC_TABLE_ORDER) result[table] = getTrackingState(table);
    return result;
  }

  function setSessionState(next: SessionState): void {
    sessionState = next;
    broadcastSyncStatus(next);
  }

  function markNeedingReview(table: SyncTableName, rule: TierTwoRule): void {
    if (tablesNeedingReview.has(table)) return; // already marked — first rule to fire wins, kept stable
    tablesNeedingReview.set(table, { table, rule });
    broadcastTier2State({ status: 'needs_review', table });
  }

  function resolveTierTwoReview(table: SyncTableName): void {
    if (!tablesNeedingReview.has(table)) return;
    tablesNeedingReview.delete(table);
    broadcastTier2State({ status: 'resolved', table });
  }

  function deriveSessionState(tables: CycleTableResult[]): SessionState {
    if (tablesNeedingReview.size > 0) return 'needs_structural_review';
    const hasFailure = tables.some((t) => t.error !== null || (t.pull?.stoppedEarlyDueToFailure ?? false));
    return hasFailure ? 'error_retrying' : 'in_sync';
  }

  async function runOneCycle(): Promise<CycleResult> {
    if (!hasReconciled) {
      await runStartupReconciliation(deps.reconciliationStores);
      hasReconciled = true;
    }

    setSessionState('syncing');

    const tables: CycleTableResult[] = [];
    let globalConflictCount = 0;
    const contributingTables = new Set<SyncTableName>();

    for (const table of SYNC_TABLE_ORDER) {
      if (tablesNeedingReview.has(table)) {
        tables.push({ table, push: null, pull: null, error: null, skippedForReview: true });
        continue;
      }

      const tableDeps = deps.tables[table];
      const cursor = await tableDeps.pullStore.getCursor();
      const cursorInitialized = cursor.updatedAt !== null;
      const hasNullBaseRecords = await deps.tier2AdmissionStores[table].hasRecordsWithNullBaseUpdatedAt();
      const rule1Fires = evaluateFirstSyncEscalation({ cursorInitialized, hasRecordsWithNullBaseUpdatedAt: hasNullBaseRecords });

      const lastServerObservedAt = await tableDeps.pullStore.getLastServerObservedAt();
      const retentionStatus = evaluateRetentionWindowEscalation(lastServerObservedAt, cursor.updatedAt, config);
      const rule3Fires = retentionStatus === 'expired';

      if (rule1Fires || rule3Fires) {
        markNeedingReview(table, rule1Fires ? 1 : 3);
        tables.push({ table, push: null, pull: null, error: null, skippedForReview: true });
        continue;
      }

      const result = await processTable(table, tableDeps, onUnexpectedTableError, trackedPushRunner);
      tables.push({ ...result, skippedForReview: false });

      if (result.pull) {
        globalConflictCount += result.pull.conflictTally.total;
        if (result.pull.conflictTally.total > 0) contributingTables.add(table);
        if (result.pull.escalatedCount > 0) markNeedingReview(table, 4);
      }
    }

    // Rule 2: global, evaluated once per cycle, after every table's
    // pull — escalation affects the NEXT cycle's gating, not this
    // cycle's already-applied results (see design decision 2).
    if (evaluateConflictVolumeEscalation(globalConflictCount, config)) {
      for (const table of contributingTables) markNeedingReview(table, 2);
    }

    const outcome = deriveSessionState(tables);
    setSessionState(outcome);
    if (outcome !== 'needs_structural_review') {
      // §6.2: in_sync/error_retrying loop back to idle; a structural
      // review pause does not (see design decision 7).
      setSessionState('idle');
    }

    return { tables, sessionState: outcome, tablesNeedingReview: [...tablesNeedingReview.values()] };
  }

  async function runCycleLoop(): Promise<CycleResult> {
    busy = true;
    try {
      let result = await runOneCycle();
      while (runAgainRequested) {
        runAgainRequested = false;
        result = await runOneCycle();
      }
      return result;
    } finally {
      busy = false;
      inFlightCycle = null;
    }
  }

  function requestCycle(): Promise<CycleResult> | null {
    if (!deps.isLeader()) return null;
    if (busy) {
      runAgainRequested = true;
      return inFlightCycle;
    }
    inFlightCycle = runCycleLoop();
    return inFlightCycle;
  }

  function requestImmediatePush(table: SyncTableName): Promise<PushCycleResult> | null {
    if (!deps.isLeader()) return null;
    if (busy) return null;
    if (tablesNeedingReview.has(table)) return null; // §6.2: push is paused for an affected table

    busy = true;
    const promise = runPushCycle(deps.tables[table].pushStore, deps.tables[table].pushTransport, new Date().toISOString()).finally(() => {
      busy = false;
    });
    return promise;
  }

  function isBusy(): boolean {
    return busy;
  }

  function getSessionState(): SessionState {
    return sessionState;
  }

  function getTablesNeedingReview(): TierTwoEscalation[] {
    return [...tablesNeedingReview.values()];
  }

  return {
    requestCycle,
    requestImmediatePush,
    isBusy,
    getSessionState,
    getTablesNeedingReview,
    resolveTierTwoReview,
    getAmbiguousFailureTracking,
  };
}
