// Sync Engine — SYNC_ARCHITECTURE_SPEC.md §5.4, §6.3.
//
// The "top-level entry point" scheduler.ts's own header has referred
// to since Phase 4f-i: the one module that imports the REAL Cross-Tab
// Coordinator and Online Monitor directly (not by injection — its job
// IS to be the concrete wiring point), creates one `SchedulerCore`
// instance, and wires the five §6.3 triggers to it using real browser
// timers/listeners. Everything else in src/sync/ stays free of
// browser globals and real-module imports; this file is deliberately
// the only place that isn't.
//
// SCOPE — exactly the three items agreed for this phase:
//   1. The five §6.3 triggers (app start, `online` event, periodic
//      timer, immediate-push-after-mutation including a follower's
//      dirty-ping, `visibilitychange`).
//   2. (Cross-cycle ambiguous-failure tracking lives in scheduler.ts,
//      per the Phase 4c/4f-i agreement that the Scheduler alone holds
//      that state — nothing to wire here beyond what already happens
//      inside every `requestCycle()` call.)
//   3. §5.4 singleton initialization discipline: `startSyncEngine`/
//      `stopSyncEngine` are fully idempotent — a second `startSyncEngine`
//      call in the same tab is a no-op; no duplicate timer, listener,
//      Web Lock request, or BroadcastChannel is ever created.
//
// NOT in scope: this module does not gate on authentication ("app
// start, after auth resolves" — §6.3) — it has no concept of auth at
// all. It is the caller's responsibility (Phase 5's hook/AuthContext
// integration) to call `startSyncEngine()` only once auth has
// resolved, and `stopSyncEngine()` on sign-out. This module also does
// not wire itself into any React hook — `notifyLocalMutation` is
// exposed as the integration point a later phase's hooks are expected
// to call, but nothing here reaches into hook code.
//
// DESIGN DECISIONS (documented up front, not silently decided):
//
// 1. THE PERIODIC TIMER, `online` LISTENER, AND `visibilitychange`
//    LISTENER ARE CREATED IN EVERY TAB, NOT ONLY THE LEADER. §6.3
//    labels the periodic trigger "leader tab, online" and the
//    visibility trigger "leader tab" — but Cross-Tab Coordinator
//    (§5.3) establishes that leadership, once acquired, is PERMANENT
//    for a tab's lifetime, with no "lost leadership" event to detect a
//    transition back to follower. Since every one of these triggers
//    ultimately calls `scheduler.requestCycle()` (or, for the `online`
//    trigger, gates its own extra work on `isLeader()` explicitly —
//    see decision 2), and `requestCycle()` already no-ops for a
//    non-leader tab, creating these listeners unconditionally in every
//    tab is simpler than trying to dynamically start/stop them around
//    a leadership transition that structurally cannot happen mid-tab-
//    lifetime. A follower tab's timer/listeners are harmless no-ops.
//
// 2. THE `online` TRIGGER'S BACKOFF-CLEARING STEP IS EXPLICITLY
//    LEADER-GATED, SEPARATELY FROM `requestCycle()`. §6.3: "Clears
//    per-record backoff state first... for every record in the
//    pending queue — then runs the full push->pull cycle." Clearing
//    backoff means writing directly to each table's `PushRecordStore`
//    — this bypasses `requestCycle()` entirely (it happens BEFORE that
//    call), so it needs its own `isLeader()` check; without it, a
//    follower tab would attempt to write to local storage it has no
//    business touching per §5.3 ("followers never run push, pull,
//    reconciliation, or cursor-advancing logic").
//
// 3. THE PERIODIC TIMER SKIPS FIRING WHEN `isLikelyOnline()` IS FALSE.
//    §6.3 parenthetically qualifies this trigger as "(leader tab,
//    online)." This is read as a firing precondition, not just
//    descriptive context: skipping a known-offline attempt avoids a
//    wasted network call Push/Pull Manager would just backoff-fail
//    anyway. This is the only trigger with this extra check — the
//    others (`online` event itself, `visibilitychange`, app start,
//    immediate push) all fire unconditionally, matching their own
//    §6.3 rows, which carry no such qualifier.

import {
  start as coordinatorStart,
  stop as coordinatorStop,
  isLeader,
  broadcastDirtyPing,
  onDirtyPing,
  broadcastTier2State,
  broadcastSyncStatus,
  type LockProvider,
  type BroadcastChannelProvider,
} from '@sync/crossTabCoordinator.js';
import { startOnlineMonitor, stopOnlineMonitor, isLikelyOnline, onConnectivityChange } from '@sync/onlineMonitor.js';
import { bypassBackoffForOnlineTrigger } from '@sync/backoff.js';
import {
  createSchedulerCore,
  SYNC_TABLE_ORDER,
  type SchedulerCore,
  type TableSyncDependencyMap,
  type ReconciliationStore,
  type Tier2AdmissionStore,
  type SyncTableName,
} from '@sync/scheduler.js';
import { getSyncConfig } from '@sync/config.js';

export interface SyncEngineDependencies {
  tables: TableSyncDependencyMap;
  reconciliationStores: Record<SyncTableName, ReconciliationStore>;
  tier2AdmissionStores: Record<SyncTableName, Tier2AdmissionStore>;
  /** Passed through to Cross-Tab Coordinator's start() — for tests. Defaults to the real Web Locks/BroadcastChannel implementations. */
  lockProvider?: LockProvider;
  broadcastChannelProvider?: BroadcastChannelProvider;
}

let started = false;
let scheduler: SchedulerCore | null = null;
let engineDeps: SyncEngineDependencies | null = null;
let periodicTimerId: ReturnType<typeof setInterval> | null = null;
let unsubscribeConnectivity: (() => void) | null = null;
let unsubscribeVisibility: (() => void) | null = null;
let unsubscribeDirtyPing: (() => void) | null = null;

// ─── Coordination layer (Phase 6g) ───────────────────────────────────
//
// WHY THIS EXISTS: §13 Step 6 sub-step 0 requires the storage cutover to
// be "leader-only... elected by **the same Web Lock** that governs
// ongoing sync." Until Phase 6g, leader election lived exclusively
// inside `startSyncEngine()`, which is itself gated behind the Step 5
// rollout flag — so the cutover could only ever run if cloud sync was
// also enabled. That coupling was an artifact of our Phase 5d wiring,
// NOT a specification requirement: the spec's only feature-flag
// recommendation is scoped to Step 5, and §15.8 assigns Step 6 a
// different mitigation entirely.
//
// `startLeaderElection()` below breaks that coupling while preserving
// the spec's actual constraint — there is still exactly ONE
// `coordinatorStart()` call, against exactly ONE lock name, no matter
// how many subsystems ask for leadership. This also makes §5.4's
// "must not create... a second Web Lock acquisition attempt" a
// structural guarantee rather than an incidental one.
//
// ORDERING IS LOAD-BEARING: callbacks fire in registration order, and
// each is awaited before the next. The cutover registers first (see
// contexts/AuthContext.tsx), so it completes before the Sync Engine's
// first push/pull cycle — which is required, since the engine must not
// read local data until the resolver's backend decision is final.

let coordinatorStarted = false;
let leadershipGranted = false;

// A Set, not an array (audit Issue B): registration is idempotent by
// callback REFERENCE — registering the same function twice never
// executes it twice. A JS Set preserves insertion order on iteration, so
// registration ordering is retained for free. NOTE FOR CALLERS: dedupe
// is by reference, so a caller that wants idempotency must pass a stable
// module-scope function, not an inline arrow (which is a new reference
// on every call). contexts/AuthContext.tsx does exactly that.
const leaderCallbacks = new Set<() => void | Promise<void>>();

// Every callback is appended to ONE serialized promise chain, so each
// runs exactly once and strictly in registration order — whether it was
// registered before leadership was granted (queued, dispatched below) or
// after (appended to the chain directly, in `startLeaderElection`).
// Without the late-registration path, a subsystem that registers after
// the lock has already been won — which is the common case when the
// browser grants it synchronously — would simply never run.
let dispatchChain: Promise<void> = Promise.resolve();

// Cancellation epoch (audit Issue A). `stopLeaderElection()` resetting
// `dispatchChain` only replaces this module's REFERENCE — the chain that
// was already built keeps running to completion on its own, so a queued
// callback would still fire after leadership had been released. Each
// enqueue captures the epoch it was queued under and re-checks it at the
// moment it would run; `stopLeaderElection` bumps the epoch, so every
// still-queued callback becomes a no-op. This is a plain counter, not a
// new synchronization primitive: no lock, no abort controller, no
// additional coordinator.
//
// RESIDUAL, DISCLOSED: a callback that is ALREADY EXECUTING when
// `stopLeaderElection()` is called cannot be interrupted — aborting
// mid-flight work would require the abort mechanism §3.5 step 1
// describes, which does not exist in this codebase (MIGRATION_NOTES.md
// AN-015 item 3) and which this phase is explicitly forbidden from
// introducing. For the cutover specifically this is benign: its only
// durable write is the completion marker, which is written solely after
// a successful copy+verify, and §3.5 step 5 keeps the local database
// intact across sign-out regardless.
let dispatchEpoch = 0;

// FAILURE ISOLATION (Phase 6g-2 prerequisite — audit Issue #3): each
// callback is wrapped so a rejection can neither poison the shared chain
// nor escape as an unhandled rejection. Without this, one failing
// callback would leave `dispatchChain` permanently rejected, and every
// LATER callback would be skipped by promise short-circuiting — so a
// failed cutover would silently prevent the Sync Engine's first cycle
// from ever running, defeating the ordering guarantee this chain exists
// to provide.
//
// WHY console.error AND NOT `reportLocalPersistenceFailure`: a leader
// callback failing is not a local-persistence failure. Routing it into
// §3.4's blocking notice would tell a user "your device storage is
// full" for what may be an unrelated sync error, and would contradict
// §13 Step 6 sub-step 5's design that a failed cutover is
// non-destructive and simply retries on the next load — not something
// that should block the UI. This is a diagnostic only; the callback's
// own owner remains responsible for any user-facing handling.
function enqueueLeaderCallback(callback: () => void | Promise<void>): void {
  const queuedEpoch = dispatchEpoch;
  dispatchChain = dispatchChain.then(async () => {
    // Leadership was released after this callback was queued — drop it.
    if (queuedEpoch !== dispatchEpoch) return;
    try {
      await callback();
    } catch (err) {
      console.error('[syncEngine] A leader callback failed. Later callbacks were not affected.', err);
    }
  });
}

function ensureCoordinatorStarted(options: {
  lockProvider?: LockProvider;
  broadcastChannelProvider?: BroadcastChannelProvider;
}): void {
  if (coordinatorStarted) return;
  coordinatorStarted = true;
  coordinatorStart({
    lockProvider: options.lockProvider,
    broadcastChannelProvider: options.broadcastChannelProvider,
    onBecameLeader: () => {
      leadershipGranted = true;
      // Snapshot: anything registered later is chained by
      // `startLeaderElection` instead, so nothing is dispatched twice.
      for (const callback of [...leaderCallbacks]) enqueueLeaderCallback(callback);
    },
  });
}

export interface LeaderElectionOptions {
  /** Invoked once this tab wins leadership. Awaited before any later-registered callback runs. */
  onBecameLeader?: () => void | Promise<void>;
  /** Passed through to Cross-Tab Coordinator's start() — for tests. */
  lockProvider?: LockProvider;
  broadcastChannelProvider?: BroadcastChannelProvider;
}

/**
 * Starts leader election, and NOTHING else.
 *
 * BINDING CONSTRAINT — this is a coordination layer only. It does not
 * create a Scheduler, a periodic timer, an Online Monitor, or any
 * `online`/`visibilitychange`/dirty-ping listener; it never calls
 * `requestCycle()`/`requestImmediatePush()`; it performs no network I/O;
 * and it does not touch `started` or `engineDeps` (the Sync Engine's own
 * state). Its entire responsibility is: register the callback, ensure
 * `coordinatorStart()` has run exactly once, return.
 *
 * Composes freely with `startSyncEngine()` in either order — both route
 * through the same idempotent guard, so the lock is acquired once and
 * both callbacks fire.
 */
export function startLeaderElection(options: LeaderElectionOptions = {}): void {
  const callback = options.onBecameLeader;
  // `has` check first (audit Issue B): re-registering an already-known
  // callback is a complete no-op, so it can neither be added twice to the
  // dispatch set nor enqueued a second time below.
  if (callback && !leaderCallbacks.has(callback)) {
    leaderCallbacks.add(callback);
    // Leadership may already have been won by the time this subsystem
    // registers (the browser can grant the lock synchronously). The
    // dispatch loop snapshots its list, so it will never revisit this
    // entry — chain it explicitly, which also keeps it ordered after
    // everything registered before it.
    if (leadershipGranted) enqueueLeaderCallback(callback);
  }
  ensureCoordinatorStarted(options);
}

/**
 * Tears down the coordination layer: releases this tab's leadership
 * claim, closes the BroadcastChannel, and clears every registered
 * leader callback.
 *
 * Deliberately separate from `stopSyncEngine()` rather than folded into
 * it, so that neither function's existing semantics change: a caller
 * that only ever started leader election can stop it without implying
 * the Sync Engine was ever running, and `stopSyncEngine()`'s own
 * early-return-when-not-started behavior is preserved exactly.
 */
export function stopLeaderElection(): void {
  if (!coordinatorStarted) return;
  coordinatorStop();
  coordinatorStarted = false;
  leadershipGranted = false;
  leaderCallbacks.clear();
  dispatchChain = Promise.resolve();
  // Invalidates every callback queued under the previous epoch (Issue A).
  dispatchEpoch += 1;
}

/** §6.3's `online` trigger — see design decision 2. */
async function handleOnlineTrigger(): Promise<void> {
  if (!isLeader() || !scheduler || !engineDeps) return;
  for (const table of SYNC_TABLE_ORDER) {
    const store = engineDeps.tables[table].pushStore;
    const pending = await store.getPendingRecords();
    for (const record of pending) {
      await store.applyPatch(record.syncId, bypassBackoffForOnlineTrigger());
    }
  }
  scheduler.requestCycle();
}

/**
 * Starts the Sync Engine for this tab: Online Monitor, Cross-Tab
 * Coordinator, one `SchedulerCore` instance, and all five §6.3
 * triggers. Idempotent (§5.4) — a second call in the same tab is a
 * complete no-op; no duplicate timer, listener, Web Lock request, or
 * BroadcastChannel is created.
 */
export function startSyncEngine(deps: SyncEngineDependencies): void {
  if (started) return;
  started = true;
  engineDeps = deps;

  startOnlineMonitor();

  const config = getSyncConfig();

  // Created BEFORE coordinatorStart() is called, deliberately: a
  // LockProvider is free to grant synchronously (this module's own
  // tests use one that does), which would invoke `onBecameLeader`
  // before this function returns. If `scheduler` were still `null` at
  // that moment, the "app start" trigger below would silently no-op.
  // Correctness here must not depend on any particular LockProvider's
  // timing, real or fake.
  scheduler = createSchedulerCore({
    tables: deps.tables,
    isLeader,
    reconciliationStores: deps.reconciliationStores,
    tier2AdmissionStores: deps.tier2AdmissionStores,
    broadcastSyncStatus,
    broadcastTier2State,
    config,
  });

  // Phase 6g: routed through the shared coordination layer instead of
  // calling `coordinatorStart` directly, so the Sync Engine and the
  // §13 Step 6 cutover can each acquire leadership independently while
  // still sharing exactly one Web Lock (§13 sub-step 0, §5.4). Behavior
  // for this callback is unchanged.
  startLeaderElection({
    lockProvider: deps.lockProvider,
    broadcastChannelProvider: deps.broadcastChannelProvider,
    // §6.3 "App start" trigger: "Runs startup reconciliation (§6.1)
    // first if this tab just became leader, then the full push->pull
    // cycle." requestCycle() already runs reconciliation automatically
    // on this SchedulerCore instance's first call (§6.1, scheduler.ts
    // decision 1), so becoming leader and requesting a cycle here
    // satisfies both halves of this trigger together.
    onBecameLeader: () => {
      scheduler?.requestCycle();
    },
  });

  // §6.3 "online browser event" trigger.
  unsubscribeConnectivity = onConnectivityChange((online) => {
    if (online) void handleOnlineTrigger();
  });

  // §6.3 "Periodic timer" trigger — see design decisions 1 and 3.
  periodicTimerId = setInterval(() => {
    if (isLikelyOnline()) scheduler?.requestCycle();
  }, config.periodicSyncIntervalMs);

  // §6.3 "Tab regains visibility" trigger.
  if (typeof document !== 'undefined') {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') scheduler?.requestCycle();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    unsubscribeVisibility = () => document.removeEventListener('visibilitychange', handleVisibility);
  }

  // §6.3 "dirty data available ping from a follower" half of the
  // immediate-push trigger — see notifyLocalMutation for the other half.
  unsubscribeDirtyPing = onDirtyPing((table) => {
    if (table) scheduler?.requestImmediatePush(table as SyncTableName);
  });
}

/**
 * §6.3's immediate-push trigger, own-tab half: call this after any
 * local mutation. If this tab is the leader, pushes just that table
 * immediately. If this tab is a follower, broadcasts a dirty-ping so
 * the leader can do it instead (§5.3) — this module never pushes from
 * a follower tab itself. A no-op if the Sync Engine hasn't been
 * started. This is the integration point a later phase's hooks are
 * expected to call; nothing in this module calls it itself.
 */
export function notifyLocalMutation(table: SyncTableName): void {
  if (!scheduler) return;
  if (isLeader()) {
    scheduler.requestImmediatePush(table);
  } else {
    broadcastDirtyPing(table);
  }
}

/** The current SchedulerCore instance, or `null` if the Sync Engine hasn't been started — for tests/observability. */
export function getScheduler(): SchedulerCore | null {
  return scheduler;
}

/**
 * Stops the Sync Engine: releases leadership, closes the
 * BroadcastChannel, clears the periodic timer, and removes every
 * listener this module registered. Idempotent (§5.4) — safe to call
 * whether or not `startSyncEngine` was ever called, and safe to call
 * more than once. Matches §3.5 step 3's sign-out sequence ("the
 * Cross-Tab Coordinator releases this tab's leadership claim... and
 * cancels all pending timers/listeners belonging to the sync runtime").
 */
export function stopSyncEngine(): void {
  if (!started) return;

  stopOnlineMonitor();
  // Phase 6g: tears down the shared coordination layer (which owns the
  // `coordinatorStop()` call and the registered leader callbacks) rather
  // than stopping the Cross-Tab Coordinator directly. Same observable
  // effect as before for a caller that only ever used the Sync Engine.
  stopLeaderElection();

  if (periodicTimerId !== null) {
    clearInterval(periodicTimerId);
    periodicTimerId = null;
  }
  unsubscribeConnectivity?.();
  unsubscribeConnectivity = null;
  unsubscribeVisibility?.();
  unsubscribeVisibility = null;
  unsubscribeDirtyPing?.();
  unsubscribeDirtyPing = null;

  scheduler = null;
  engineDeps = null;
  started = false;
}
