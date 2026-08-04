// Cross-Tab Coordinator — SYNC_ARCHITECTURE_SPEC.md §5.2, §5.3, §5.4.
//
// SCOPE (per this phase's explicit boundary): leader election, lock
// acquisition/release, and the three cross-tab notifications the
// specification defines (§5.3) — a "dirty data available" ping, the
// Tier 2 review dialog's open/resolved state, and a generic sync
// status broadcast. This module owns none of: deciding when a sync
// cycle runs, performing push or pull, evaluating conflicts, or
// modifying application records. It answers exactly one question
// ("am I the leader right now?") and relays exactly three kinds of
// opaque cross-tab messages — it does not interpret their content or
// decide when to send them beyond what's described below; that
// remains the Scheduler's job (Phase 4f).
//
// DEPENDENCY-INJECTION BOUNDARY: Web Locks and BroadcastChannel are
// each behind a small provider interface (`LockProvider`,
// `BroadcastChannelProvider`) so this module is testable without a
// real multi-tab browser context. `start()` defaults to the real
// browser implementations but accepts fakes.
//
// NO SILENT FALLBACK: §5.3 explicitly rejects a manually-maintained
// "leader flag" record precisely because it would reintroduce
// heartbeat/expiry ambiguity Web Locks avoids by construction. If
// `navigator.locks` or `BroadcastChannel` is unavailable in the
// runtime environment, the real provider implementations throw
// immediately rather than silently degrading to some other
// leader-election or messaging strategy. This is a deliberate,
// disclosed constraint, not an oversight — see the implementation
// report for the environments this affects.
//
// WEB LOCKS' EXECUTION MODEL (why this module isn't a simple
// acquire()/release() pair): `navigator.locks.request(name, callback)`
// holds the lock for exactly as long as `callback`'s returned promise
// is pending, releasing it automatically when that promise settles —
// it is not an imperative acquire/release API. This module holds
// leadership by handing Web Locks a promise it controls the lifetime
// of (resolved only by `stop()`, or implicitly abandoned when the tab
// closes/crashes, which is what gives the browser's own cleanup —
// rather than any heartbeat this module would otherwise need to
// invent — the ability to release the lock for us).
//
// DEFERRED (not implemented this phase, flagged for the report):
// distinguishing "became leader immediately" from "became leader via
// hand-off" (§14's telemetry note) is not implemented — it would
// require an additional non-blocking availability probe before the
// real acquisition request, adding surface area for a label that
// doesn't affect leadership correctness itself and is only consumed
// by telemetry (an explicitly later phase). `onBecameLeader` fires
// with no reason argument.

// ─── Lock provider abstraction ───────────────────────────────────

/**
 * Requests the named exclusive lock. `holdWhile` is invoked once the
 * lock is actually held (this tab is now leader) and must return a
 * promise the CALLER controls the lifetime of — the lock is held for
 * exactly as long as that promise is pending. Resolves once the lock
 * has been fully released (i.e., once `holdWhile`'s promise settles).
 */
export interface LockProvider {
  request(lockName: string, holdWhile: () => Promise<void>): Promise<void>;
}

export const webLocksProvider: LockProvider = {
  request(lockName, holdWhile) {
    if (typeof navigator === 'undefined' || !('locks' in navigator) || !navigator.locks) {
      throw new Error(
        'Cross-Tab Coordinator: the Web Locks API is not available in this environment. ' +
          'Per SYNC_ARCHITECTURE_SPEC.md §5.3, leader election is intentionally Web-Locks-only ' +
          '(no localStorage-flag fallback) — this is a disclosed constraint, not a bug.',
      );
    }
    return navigator.locks.request<void>(lockName, { mode: 'exclusive' }, holdWhile);
  },
};

// ─── Broadcast channel abstraction ───────────────────────────────

export interface BroadcastPort {
  postMessage(message: unknown): void;
  /** Never receives this same port's own posted messages — matches real BroadcastChannel semantics. Returns an unsubscribe function. */
  onMessage(handler: (message: unknown) => void): () => void;
  close(): void;
}

export interface BroadcastChannelProvider {
  open(channelName: string): BroadcastPort;
}

export const webBroadcastChannelProvider: BroadcastChannelProvider = {
  open(channelName) {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error(
        'Cross-Tab Coordinator: the BroadcastChannel API is not available in this environment. ' +
          'This is a disclosed constraint, not a bug — see this module\'s header.',
      );
    }
    const channel = new BroadcastChannel(channelName);
    const handlers = new Set<(message: unknown) => void>();
    channel.onmessage = (event: MessageEvent) => {
      handlers.forEach((handler) => handler(event.data));
    };
    return {
      postMessage: (message) => channel.postMessage(message),
      onMessage: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      close: () => channel.close(),
    };
  },
};

// ─── Message types (§5.3's three cross-tab notifications) ────────

interface DirtyPingMessage {
  type: 'dirty_ping';
  table?: string;
}

export interface Tier2State {
  status: 'needs_review' | 'resolved';
  table?: string;
}

interface Tier2StateMessage extends Tier2State {
  type: 'tier2_state';
}

interface SyncStatusMessage {
  type: 'sync_status';
  /** Opaque — this module never interprets the content, only relays it. The Scheduler defines its own shape (§6.2's idle/syncing/in_sync/... states, or anything else). */
  status: unknown;
}

type CoordinatorMessage = DirtyPingMessage | Tier2StateMessage | SyncStatusMessage;

function isCoordinatorMessage(value: unknown): value is CoordinatorMessage {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

// ─── Module state (one coordinator per tab — see §5.4) ───────────

const DEFAULT_LOCK_NAME = 'trading-journal-ai:sync-leadership';
const DEFAULT_CHANNEL_NAME = 'trading-journal-ai:sync-coordination';

let started = false;
let leader = false;
let releaseLeadership: (() => void) | null = null;
let port: BroadcastPort | null = null;
let onDirtyPingHandlers = new Set<(table: string | undefined) => void>();
let onTier2StateHandlers = new Set<(state: Tier2State) => void>();
let onSyncStatusHandlers = new Set<(status: unknown) => void>();

export interface StartOptions {
  lockProvider?: LockProvider;
  broadcastChannelProvider?: BroadcastChannelProvider;
  lockName?: string;
  channelName?: string;
  /** Invoked once this tab actually becomes leader (lock acquired). Never invoked more than once per `start()` call — leadership, once acquired, is held for the tab's lifetime (§5.3). */
  onBecameLeader?: () => void;
}

/**
 * Begins leader-election and cross-tab message relay for this tab.
 * Idempotent (§5.4): calling this a second time in the same tab
 * (hot-reload, unexpected remount) is a no-op — it does not attempt a
 * second lock acquisition or open a second BroadcastChannel. This is
 * a duplicate-work-prevention guarantee, not merely a convenience.
 */
export function start(options: StartOptions = {}): void {
  if (started) return;
  started = true;

  const lockProvider = options.lockProvider ?? webLocksProvider;
  const broadcastChannelProvider = options.broadcastChannelProvider ?? webBroadcastChannelProvider;
  const lockName = options.lockName ?? DEFAULT_LOCK_NAME;
  const channelName = options.channelName ?? DEFAULT_CHANNEL_NAME;

  port = broadcastChannelProvider.open(channelName);
  port.onMessage((raw) => {
    if (!isCoordinatorMessage(raw)) return;
    if (raw.type === 'dirty_ping') onDirtyPingHandlers.forEach((h) => h(raw.table));
    else if (raw.type === 'tier2_state') onTier2StateHandlers.forEach((h) => h({ status: raw.status, table: raw.table }));
    else if (raw.type === 'sync_status') onSyncStatusHandlers.forEach((h) => h(raw.status));
  });

  // Fire-and-forget: the returned promise only settles once
  // leadership is released (stop(), or the browser's own cleanup on
  // tab close/crash) — this function must not await it.
  void lockProvider.request(lockName, () => {
    return new Promise<void>((resolve) => {
      releaseLeadership = resolve;
      leader = true;
      options.onBecameLeader?.();
    });
  });
}

/**
 * Releases this tab's leadership claim (if held) and tears down
 * cross-tab message relay. Idempotent — safe to call whether or not
 * `start()` was ever called, and safe to call more than once. Used by
 * the sign-out sequence (§3.5 step 3: "the Cross-Tab Coordinator
 * releases this tab's leadership claim... and cancels all pending
 * timers/listeners belonging to the sync runtime").
 */
export function stop(): void {
  if (releaseLeadership) {
    releaseLeadership();
    releaseLeadership = null;
  }
  leader = false;
  if (port) {
    port.close();
    port = null;
  }
  onDirtyPingHandlers = new Set();
  onTier2StateHandlers = new Set();
  onSyncStatusHandlers = new Set();
  started = false;
}

/** True if this tab currently holds sync leadership. */
export function isLeader(): boolean {
  return leader;
}

// ─── Dirty-ping (any tab -> leader) ───────────────────────────────

/**
 * §5.3: "On a local mutation, a follower broadcasts a lightweight
 * 'dirty data available' ping via BroadcastChannel so the leader can
 * opportunistically run an immediate push cycle." Callable by any
 * tab — this module does not gate who may call it; a leader tab
 * pinging itself is simply unnecessary, not harmful, and this module
 * has no reason to police that.
 */
export function broadcastDirtyPing(table?: string): void {
  port?.postMessage({ type: 'dirty_ping', table } satisfies DirtyPingMessage);
}

export function onDirtyPing(handler: (table: string | undefined) => void): () => void {
  onDirtyPingHandlers.add(handler);
  return () => onDirtyPingHandlers.delete(handler);
}

// ─── Tier 2 dialog state (leader -> followers) ────────────────────

/**
 * §5.3: "The leader broadcasts this state change via BroadcastChannel
 * ... When the leader's dialog is resolved, it broadcasts the
 * resolved state." Expected to be called by the leader only — only
 * the leader's Conflict Detector can ever reach
 * `needs_structural_review` (§5.3), since only the leader pulls — but
 * this is a documented caller precondition, not something this
 * module enforces at runtime: mirroring `broadcastDirtyPing`, this is
 * a pure relay with no policy of its own (deciding who "should" call
 * it is the Scheduler's concern, not this module's).
 */
export function broadcastTier2State(state: Tier2State): void {
  port?.postMessage({ type: 'tier2_state', ...state } satisfies Tier2StateMessage);
}

export function onTier2StateChange(handler: (state: Tier2State) => void): () => void {
  onTier2StateHandlers.add(handler);
  return () => onTier2StateHandlers.delete(handler);
}

// ─── Generic sync status (leader -> followers) ────────────────────

/**
 * §5.2: "Broadcasts sync status to follower tabs." Content is opaque
 * to this module by design — the Scheduler defines what "status"
 * means (§6.2's session states, or anything else) and decides when to
 * broadcast it; this module only relays. Expected to be called by the
 * leader only, for the same reason as `broadcastTier2State` — a
 * documented caller precondition, not runtime-enforced here (see that
 * function's doc for why).
 */
export function broadcastSyncStatus(status: unknown): void {
  port?.postMessage({ type: 'sync_status', status } satisfies SyncStatusMessage);
}

export function onSyncStatusChange(handler: (status: unknown) => void): () => void {
  onSyncStatusHandlers.add(handler);
  return () => onSyncStatusHandlers.delete(handler);
}
