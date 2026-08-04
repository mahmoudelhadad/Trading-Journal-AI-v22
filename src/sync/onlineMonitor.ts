// Online Monitor — SYNC_ARCHITECTURE_SPEC.md §5.2, §10, §11.
//
// Combines two independent connectivity signals:
//   1. The browser's own online/offline events (navigator.onLine).
//   2. Observed network-layer failures reported by callers (the Push/
//      Pull Managers, once built) — including a malformed/non-JSON
//      HTTP 200 response, which §10 requires be "treated identically
//      to a network-layer failure for retry/backoff purposes," never
//      an unhandled exception, "regardless of what navigator.onLine
//      claims" (§5.2).
//
// Deliberately has no notion of leader/follower, and no dependency on
// any other part of src/sync/ — every tab may run its own Online
// Monitor; only the leader's Sync Engine (Phase 4f/5) decides what to
// do with the signal.

type ConnectivityListener = (isOnline: boolean) => void;

let recentNetworkFailure = false;
let browserListenersAttached = false;
const listeners = new Set<ConnectivityListener>();

function currentIsOnline(): boolean {
  const browserSaysOnline = typeof navigator === 'undefined' ? true : navigator.onLine;
  return browserSaysOnline && !recentNetworkFailure;
}

function notifyListeners(): void {
  const online = currentIsOnline();
  listeners.forEach((listener) => listener(online));
}

/** Current best-effort determination of connectivity. */
export function isLikelyOnline(): boolean {
  return currentIsOnline();
}

/**
 * Record an observed network-layer failure — a failed fetch, or a
 * malformed/non-JSON HTTP 200 body (§10). Overrides navigator.onLine
 * until either a genuine browser `online` event fires or
 * reportNetworkSuccess() is called.
 */
export function reportNetworkFailure(): void {
  if (recentNetworkFailure) return;
  recentNetworkFailure = true;
  notifyListeners();
}

/** Record an observed successful network response, clearing the failure override. */
export function reportNetworkSuccess(): void {
  if (!recentNetworkFailure) return;
  recentNetworkFailure = false;
  notifyListeners();
}

/**
 * Subscribe to connectivity changes (browser events, or
 * reportNetworkFailure/reportNetworkSuccess flipping the combined
 * determination). Returns an unsubscribe function.
 */
export function onConnectivityChange(listener: ConnectivityListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function handleBrowserOnline(): void {
  // A genuine browser online event is authoritative — clears any
  // stale failure override even if reportNetworkSuccess() hasn't
  // fired yet for some in-flight request.
  recentNetworkFailure = false;
  notifyListeners();
}

function handleBrowserOffline(): void {
  notifyListeners();
}

/**
 * Attach the browser online/offline listeners. Idempotent within a
 * tab — calling this more than once (e.g. a hot-reload) never
 * registers duplicate listeners.
 */
export function startOnlineMonitor(): void {
  if (browserListenersAttached || typeof window === 'undefined') return;
  browserListenersAttached = true;
  window.addEventListener('online', handleBrowserOnline);
  window.addEventListener('offline', handleBrowserOffline);
}

/** Detach the browser online/offline listeners (test/teardown use). */
export function stopOnlineMonitor(): void {
  if (!browserListenersAttached || typeof window === 'undefined') return;
  browserListenersAttached = false;
  window.removeEventListener('online', handleBrowserOnline);
  window.removeEventListener('offline', handleBrowserOffline);
}

/**
 * Classifies a request outcome as a network-layer failure per §10's
 * malformed-200 rule: an HTTP-OK response that fails to parse as the
 * expected structure is a network-layer failure, exactly like a
 * non-OK response — never an unhandled exception.
 */
export function isNetworkLayerFailure(outcome: { httpOk: boolean; parseOk: boolean }): boolean {
  return !outcome.httpOk || !outcome.parseOk;
}
