/**
 * services/localPersistenceEvents.ts
 *
 * Phase 6g-1 — SYNC_ARCHITECTURE_SPEC.md §3.4.
 *
 * The single aggregation point for the two local-persistence failure
 * modes §3.4 requires be surfaced to the user as "a distinct, blocking
 * notice — never folded into the ordinary 'sync pending' indicator":
 *
 *   1. A local write failed (quota exhaustion, or any other local
 *      persistence failure) — reported via `reportLocalPersistenceFailure`.
 *   2. This tab's IndexedDB connection was force-closed because another
 *      tab is upgrading the schema (§3.4's mandatory version-upgrade
 *      protocol, Phase 6a/6e) — self-wired below via
 *      `onIndexedDbVersionChangeForcedClose`, since that subscription
 *      API already exists (Phase 6e, G-1) and forwarding it is this
 *      module's entire reason to exist for case 2.
 *
 * components/LocalPersistenceNotice.tsx is the sole subscriber. Built
 * and wired in full now (Phase 6g-1), per explicit decision (D): the
 * reporting/UI structure is built once, completely, rather than as a
 * generic placeholder revisited in 6g-2. What 6g-2 adds is simply more
 * callers of `reportLocalPersistenceFailure` (the cutover's own copy/
 * verify failures) — no change to this module or the notice component.
 *
 * WHY THIS STAYS A LAST-EVENT BUS, NOT A QUEUE: at most one blocking
 * notice is ever meaningful to show at a time — a second failure while
 * one is already displayed doesn't need its own dialog, it needs the
 * user to address the first. `report*` therefore overwrites the current
 * notice rather than accumulating a list.
 */

import type { IndexedDbErrorKind } from './indexedDb.js';
import { onIndexedDbVersionChangeForcedClose } from './indexedDbStores.js';

export type LocalPersistenceNotice =
  | { kind: 'save_failed'; source: string; errorKind: IndexedDbErrorKind; message: string }
  | { kind: 'connection_force_closed' };

let current: LocalPersistenceNotice | null = null;
const handlers = new Set<(notice: LocalPersistenceNotice | null) => void>();

function setCurrent(notice: LocalPersistenceNotice | null): void {
  current = notice;
  handlers.forEach((handler) => handler(current));
}

/**
 * Reports a failed local write. `source` is a short label for WHICH
 * local read/write failed (e.g. `'trades'`) — not shown verbatim in the
 * quota-exhaustion message (§3.4's guidance there is generic: free
 * device storage), but included for any other failure kind, where no
 * specific corrective action is mandated and naming the source is the
 * most useful non-silent information available.
 *
 * `err`'s `.kind` (services/indexedDbStores.ts's `IndexedDbCallError`,
 * Phase 6g-1) is read defensively — this function accepts `unknown`
 * because a rejection can, in principle, be anything, and must never
 * itself throw.
 */
export function reportLocalPersistenceFailure(source: string, err: unknown): void {
  const errorKind: IndexedDbErrorKind =
    err && typeof err === 'object' && 'kind' in err
      ? ((err as { kind: unknown }).kind as IndexedDbErrorKind)
      : 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  setCurrent({ kind: 'save_failed', source, errorKind, message });
}

/** Reports that this tab's local-database connection was force-closed (§3.4). */
export function reportConnectionForceClosed(): void {
  setCurrent({ kind: 'connection_force_closed' });
}

/** Clears the current notice. A no-op for `connection_force_closed` state's own display decision — see the component. */
export function dismissLocalPersistenceNotice(): void {
  setCurrent(null);
}

/** The current notice, or `null`. For a subscriber's initial render, before any change event has fired. */
export function getLocalPersistenceNotice(): LocalPersistenceNotice | null {
  return current;
}

export function onLocalPersistenceNoticeChange(handler: (notice: LocalPersistenceNotice | null) => void): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

// Self-wired: importing this module is sufficient to forward every
// future force-close to the notice layer, for the lifetime of the page
// (there is no corresponding "unwire," matching indexedDb.ts's own
// connection, which is likewise never reopened after a forced close).
onIndexedDbVersionChangeForcedClose(() => reportConnectionForceClosed());
