# Synchronization Architecture Specification

**Revision:** 3
**Status:** Authoritative implementation contract. Design frozen.
**Revision history:** Revision 1 underwent adversarial review (20 findings) and Revision 2 underwent an implementation-readiness audit (one internal contradiction, one absent mechanism, and a set of residual ambiguities). Every finding from both passes is resolved in the body below by direct rewrite — there are no patch notes, TODOs, or open questions anywhere in this document. The core architecture (local-first, IndexedDB, dirty records, tombstones, compound cursor, incremental sync, chunked push with bisection, Web Locks leader election, BroadcastChannel followers, two-tier conflict model, RLS, migration strategy) has been unchanged since Revision 1 and was not reopened by either revision; both passes changed only completeness and determinism, never design.
**Audience:** An implementing engineer/agent with no prior context. This document is self-contained. Where a decision point exists, this document makes the decision — an implementer should never need to choose between two valid approaches.
**Scope:** Client-side and server-schema design for local-first synchronization of Trades, Accounts, Lists, and Settings between the browser and Supabase. Does not cover UI visual design, calculations, or unrelated features (Recovery Bin, Restore Points, Import/Export remain as-is except where explicitly noted).

---

## 0. Non-Negotiable Principles

Every design decision in this document is subordinate to these four guarantees. Where a tradeoff exists between these and implementation simplicity, these win:

1. **User data must never be silently lost.**
2. **User data must never be silently reverted** (an action the user took must not un-happen without their knowledge).
3. **Local data must never be silently overwritten** by cloud data.
4. **Cloud data must never be silently overwritten** by local data.

Supporting principles that follow from the above:

- The local database is the **only** thing the UI ever reads. It is always immediately, synchronously (from the UI's perspective) consistent with the user's own actions.
- The cloud database is **eventually consistent** with local. No UI operation ever blocks on network I/O.
- Every network operation the sync engine performs must be **idempotent** and **safely retryable** from a cold start (page refresh, browser restart, days later, a different tab).
- Silence is only acceptable when it is **provably safe** (no divergence). Anything else is surfaced to the user, even if resolved automatically.
- **No ambiguity is left for the implementer to resolve.** Every decision point in this document has exactly one specified answer.

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         UI Layer (React)                          │
│  Pages / components. Hooks (useTrades, useAccounts, useLists,     │
│  useSettings) read and write the LOCAL DATABASE ONLY.             │
│  Hooks never call Supabase, never import network code.            │
└──────────────────────────────┬────────────────────────────────────┘
                                │ read / write (local, synchronous
                                │ from the UI's perspective)
┌──────────────────────────────▼────────────────────────────────────┐
│              Local Database (IndexedDB, namespaced by user_id)     │
│  Stores: trades, accounts, lists, settings, sync_cursors,          │
│  migration_state (§3.5, §13)                                       │
│  Every business record carries sync metadata (§3.2).               │
│  Shared, readable/writable by every tab of this origin.            │
└──────────────────────────────┬────────────────────────────────────┘
                                │ observed / driven by
┌──────────────────────────────▼────────────────────────────────────┐
│                     Sync Engine (§5) — LEADER TAB ONLY              │
│  Cross-Tab Coordinator · Scheduler · Push Manager · Pull Manager ·  │
│  Conflict Detector · Retry/Backoff Controller · Online Monitor      │
│  Owns 100% of network I/O. Runs in exactly one tab at a time.       │
└──────────────────────────────┬────────────────────────────────────┘
                                │ REST (PostgREST) over HTTPS
┌──────────────────────────────▼────────────────────────────────────┐
│                    Supabase (Postgres + RLS)                        │
│  trades · accounts · lists · settings                               │
│  + deleted_at (tombstones) · + (user_id, updated_at, id) index      │
│  RLS unchanged: auth.uid() = user_id on every table.                │
└─────────────────────────────────────────────────────────────────────┘
```

**Multi-tab topology** (§5.3 defines this fully):

```
┌────────────┐   BroadcastChannel   ┌────────────┐   BroadcastChannel   ┌────────────┐
│   Tab 1     │◄────────────────────►│   Tab 2     │◄────────────────────►│   Tab 3     │
│  (LEADER)   │   status / dirty-    │ (follower)  │                      │ (follower)  │
│ runs Sync   │   ping messages      │ reads local │                      │ reads local │
│ Engine      │                      │ DB directly,│                      │ DB directly,│
│             │                      │ never syncs │                      │ never syncs │
└──────┬──────┘                      └─────────────┘                      └─────────────┘
       │
       ▼
   Supabase
```

**The single most important structural change from the pre-redesign implementation:** synchronization is owned by exactly one subsystem, running in exactly one tab, at exactly one time. Hooks are pure local-database accessors. This is what makes retry, backoff, chunking, conflict handling, and cursor management exist in exactly one place instead of being duplicated or raced across tabs.

---

## 2. Terminology / Glossary

| Term | Meaning |
|---|---|
| **Record** | One addressable entity: a trade, an account, the (singleton) lists object, or the (singleton) settings object. |
| **Dirty** | A record with unsynced local changes, eligible for push. |
| **Pending queue** | The set of records where `syncStatus IN (dirty, pending_delete)` — **exactly these two values, nothing else.** `syncing` is never part of the pending queue (§3.2). |
| **Tombstone** | A soft-deleted record (`deleted_at` set) kept around so its deletion can propagate to other devices. |
| **Compound cursor** | Per-table, per-device watermark, a **tuple** `(updatedAt, id)`, not a bare timestamp (§7). |
| **Base version** | The server `updated_at` a device last confirmed for a given record — the version optimistic-concurrency comparisons are made against. |
| **Server-derived timestamp** | Any timestamp value that originated from the server (a row's `updated_at`, a cursor value derived from one) — as opposed to a value read from the device's own clock. Used wherever a comparison must be immune to local clock error (§8.2). |
| **Tier 1 conflict** | A single-record conflict, resolved automatically. |
| **Tier 2 divergence** | A structural, multi-record (or persistently-repeating single-record) situation requiring explicit user review. |
| **Leader tab** | The one tab currently running the Sync Engine (§5.3). |
| **Follower tab** | Any other open tab of the app — reads the shared local database directly, never pushes or pulls. |
| **Push** | Sending local changes to the cloud. Performed **only** by the Push Manager (§10) — no other code path exists. |
| **Pull** | Retrieving cloud changes since the local cursor. |

---

## 3. Local Data Model

### 3.1 Entity classification

Two different record shapes exist, and they must be treated differently:

- **Collections** (many independently addressable rows): **Trades**, **Accounts**. Each row is its own record with its own sync state.
- **Singletons** (exactly one row per user): **Lists**, **Settings**. There is no per-item dirty-tracking inside the lists object or the settings object — the whole object is one record with one sync state, because it is always read and written as a whole.

Do not attempt to decompose Lists into per-list or per-item records. That would be unjustified complexity with no corresponding requirement.

### 3.2 Required sync metadata (every record, collection or singleton)

| Field | Type | Meaning |
|---|---|---|
| `id` | uuid | The record's cloud-side primary key, and the tie-breaker half of the compound cursor (§7.2). Client-generated at record creation (see rule below). |
| `syncStatus` | enum: `synced`, `dirty`, `pending_delete`, `syncing` | Current sync state — see §6.1 for the full transition table. |
| `localUpdatedAt` | timestamp | When this device last modified this record. **Sanity-bounded at write time** (see rule below) — used for ordering and Tier 1 comparison only, never trusted as a global authority. |
| `baseUpdatedAt` | timestamp \| null | The server `updated_at` this device last confirmed for this record. `null` means "never successfully synced." This is the optimistic-concurrency base version (§8). |
| `deletedAt` | timestamp \| null | Local tombstone marker. Non-null means the record is deleted from this device's perspective and must be filtered from every normal read path immediately, regardless of sync status. **Also disambiguates `syncing` on recovery** — see §6.1. |
| `consecutiveFailures` | integer, default 0 | Per-record push failure count, driving this record's own backoff interval (§10). Reset to 0 on this record's own push success. |
| `nextEligibleAttemptAt` | timestamp \| null | The earliest moment this record may be included in a push batch again. `null` = eligible now. Computed from `consecutiveFailures` (§10). |
| `lastError` | string \| null | The most recent push failure reason for this record, surfaced through the pending-changes indicator (§10). |
| `conflictResolutionLog` | array of server-derived timestamps | One entry per Tier 1 auto-resolution of this record (§8.1), each entry being the incoming `updated_at` that triggered it. Backs Tier 2 escalation rule 4 (§8.2). |

**Record identity — `id` is client-generated, immutable, and never used for record matching:** `id` is generated by the client at the moment a record is created (and, for records that predate sync, at the Step 3 stamping pass — §13), and is sent explicitly on the record's first insert rather than being assigned by the server. It exists for exactly one purpose: to give the compound cursor (§7.2) a deterministic total order. It is **never** the key used to match, deduplicate, or upsert a record — that remains the natural business key already established in the schema (`(user_id, tid)` for trades, `(user_id, local_id)` for accounts), exactly as §10 specifies. Because two devices could independently stamp the same pre-existing record (same natural key) with different locally-generated `id` values during migration, `id` is **excluded from the update column set of every upsert** — it is written only by the insert that first creates the cloud row, and never changed afterward. A device that pulls a record whose cloud `id` differs from its own locally-generated one adopts the cloud value; the cloud row's `id` is always authoritative.

**`conflictResolutionLog` persistence and pruning:** this field is stored with the record in IndexedDB and therefore survives refresh, crash, and browser restart — the repeated-conflict rule must not be defeated by a user who reloads frequently. Whenever an entry is appended, entries older than the repeated-conflict window (§14) are pruned from the list in the same write, bounding its growth.

**The pending queue is defined as exactly:** `syncStatus IN (dirty, pending_delete)`.

This is the only correct definition. `syncing` is **never** included — a record in `syncing` is not eligible to be picked up by any trigger; it is either actively in flight, or (after the startup reconciliation rule in §6.1) has already been converted back to `dirty`/`pending_delete` before any pickup logic ever runs. There is no query anywhere in this system that reads `syncStatus != synced` to mean "the queue" — if such a query is ever written, it is a bug.

**Local clock sanity rule:** whenever `localUpdatedAt` is set (on any local mutation), it is clamped against the most recent server-derived timestamp this device has observed this session (see §3.3's `lastServerObservedAt`). If the device clock would produce a value more than five minutes ahead of that reference, the value is clamped to the reference instead of trusted as-is. This bounds — though does not fully eliminate — the impact of a badly wrong (not just mildly skewed) device clock on Tier 1 resolution (§8.1). Before any server-derived reference exists yet this session (e.g., very first launch, still offline), no clamping is applied; the rule only engages once at least one server response has been observed.

### 3.3 Local-only bookkeeping (not synced to cloud)

A small local store, `sync_cursors`, holding one row per synced table:

| Field | Meaning |
|---|---|
| `tableName` | `trades` \| `accounts` \| `lists` \| `settings` |
| `cursorUpdatedAt` | The `updated_at` half of this table's compound cursor (§7). `null` = never synced. |
| `cursorId` | The `id` half of this table's compound cursor — the tie-breaker (§7). `null` = never synced. |
| `lastServerObservedAt` | The most recent server-derived timestamp this device has seen from **any** successful sync response, across all four tables (not just this one). Updated on every successful push or pull response that includes at least one row. Never written from the local clock. Used for: the clock sanity rule (§3.2) and the retention-window escalation check (§8.2). |
| `lastAttemptAt` | For backoff timing. |
| `consecutiveFailures` | For backoff timing (per-table batch-level; see §10 for per-record backoff, which is tracked on the record itself, not here). |

This store is **per device** and **per user** (§3.5) — never transmitted to the server, never shared across users of the same device.

### 3.4 Storage medium: IndexedDB, not LocalStorage

**Decision:** local persistence is IndexedDB (per-record rows, indexed, asynchronous), never LocalStorage, for two independent, both-sufficient reasons: LocalStorage's quota cannot hold a realistic 100k-trade history, and its whole-blob-rewrite model cannot represent per-record sync metadata without a driftable second structure.

**Tradeoff, stated honestly:** IndexedDB is asynchronous. Every place in the codebase that currently assumes a synchronous local read must change. This is sequenced deliberately in §13 to avoid a single risky rewrite.

**Schema version upgrade protocol (required, not optional):** IndexedDB requires an explicit version number, bumped whenever the local schema changes (a new field, a new object store). Every open connection, in every tab, must register a handler for the "another connection is requesting a version upgrade" event, and respond by closing its own connection (prompting that tab to reload before continuing to use the database). Without this, a future schema upgrade in one tab can hang indefinitely if any other tab holds a stale connection open to the old version — a standard, well-documented IndexedDB failure mode. This requirement applies to **every** tab (leader and followers alike), since IndexedDB connections are per-tab regardless of sync leadership.

**Quota exhaustion behavior:** if a local write fails due to quota exhaustion (or any other local persistence failure, e.g. a browser-imposed restriction), it is surfaced to the user as a **distinct, blocking notice** — never folded into the ordinary "sync pending" indicator. This is a local persistence failure, not a network/sync failure: there is, at that moment, no other copy of the data anywhere, and no amount of retrying reaches the network in time to matter. The notice must direct the user toward a corrective action (freeing device storage), not offer a "retry" that cannot succeed until they do.

### 3.5 Per-User Ownership & Session Transitions

**Chosen approach: namespace every local store by `user_id`. The local database is never wholesale-cleared on sign-out.**

Every record in every store (`trades`, `accounts`, `lists`, `settings`, `sync_cursors`) carries the currently-authenticated user's `user_id` as part of its key, and every query the app issues is scoped to the **currently signed-in** `user_id`. This is chosen over wholesale-clearing on sign-out for a specific reason: clearing would force a full Tier 2 reconciliation every time the same person signs out and back in on the same device (e.g., temporarily handing the laptop to someone else) — needlessly discarding a perfectly valid local cache and creating friction that has no correctness benefit. Namespacing avoids this while still fully isolating different users on a shared device.

**Sign-out sequence (exact order):**
1. **Abort all in-flight network requests** belonging to the sync runtime, and mark the sign-out as begun. Any response that nevertheless arrives after this point — whether from an abort that lost the race, or from a request the browser had already completed — is **discarded without effect**: it must not update any record's `syncStatus`, `baseUpdatedAt`, cursor, or any other durable state. A push whose response is discarded this way is not lost: its record is reverted per step 2 and re-pushed idempotently on the next sign-in, exactly like any other interrupted push.
2. Revert every record left in `syncing` state by the aborted requests, applying the identical startup-reconciliation rule from §6.1 (`deletedAt` set → `pending_delete`, otherwise → `dirty`). Sign-out never leaves a record stranded in `syncing`.
3. Stop the Sync Engine: the Cross-Tab Coordinator (§5.3) releases this tab's leadership claim (if held) and cancels all pending timers/listeners belonging to the sync runtime.
4. Reset in-memory sync runtime state — nothing durable is touched beyond step 2's reversion.
5. The local database itself is **not** cleared or modified. It remains present, namespaced under the signing-out user's `user_id`, dormant until that user signs back in.

**Sign-in sequence:** the app operates exclusively on the newly-signed-in user's namespaced slice. If this device has never seen that `user_id` before, that slice is empty — `sync_cursors` has no rows, so the first sync for this user on this device naturally satisfies the "first sync" Tier 2 escalation rule (§8.2, rule 1) without any special-cased logic. If this device has seen that `user_id` before (the common re-sign-in case), the existing namespaced data and cursors are used exactly as they were left — no forced reconciliation.

**Defense in depth:** RLS (`auth.uid() = user_id`, unchanged, §4) independently guarantees that even if a namespacing bug ever caused a stale record from a previous local user to be pushed under a new session's token, the server would reject it — the record's own stored `user_id` cannot match a different signed-in user's `auth.uid()`. Namespacing prevents the confusing stuck-record symptom that would otherwise result from relying on RLS alone as the only safeguard; RLS remains the correctness backstop regardless.

### 3.6 Global Invariants

These hold at all times, across every subsystem. They are stated once here and relied upon throughout the rest of this document; an implementation that violates any of them is incorrect regardless of how any individual section reads.

| # | Invariant |
|---|---|
| **INV-1** | **Every successful push updates `baseUpdatedAt`.** On any push that the server confirms — ordinary edit, tombstone, or Tier 2-driven reconciliation alike — the record's `baseUpdatedAt` is set to the server `updated_at` returned for that row, in the same local write that sets `syncStatus`. No push path may leave `baseUpdatedAt` stale, since that would manufacture a spurious Tier 1 conflict against this device's own already-applied change on the next pull. The one sanctioned place `baseUpdatedAt` is deliberately set backward to `null` is step 1 of the "Use Cloud Data" resolution (§8.2), where it serves as a transient refresh marker on records that are simultaneously set `synced` and therefore cannot produce a Tier 1 conflict at all (§8.1); that reset is cleared by the full pull which immediately follows it. |
| **INV-2** | **At most one push→pull cycle executes in the leader at a time.** The Scheduler serializes cycles: if any trigger (§6.3) fires while a cycle is already running, it does not start a second one. A full-cycle trigger arriving during a running cycle sets a "run again when this finishes" flag, honored exactly once no matter how many such triggers arrive; an immediate-push fast-path trigger arriving during a running cycle is dropped, because the running cycle's push phase will pick up that record anyway if it has not already passed it. |
| **INV-3** | **Cursors advance monotonically forward.** A table's persisted `(cursorUpdatedAt, cursorId)` may only ever move forward in the `(updated_at, id)` ordering during automated operation. The sole sanctioned exception is a deliberate reset to `(null, null)`, which occurs in exactly two places in this design: the operator-initiated recovery reset (§7.4) and the "Use Cloud Data" resolution (§8.2). No other code path may move a cursor backward. |
| **INV-4** | **The local clock is never used for a server-authoritative comparison.** Any comparison that determines sync correctness — retention-window staleness (§8.2), Tier 1 ordering inputs (§8.1) — uses server-derived timestamps only (§2). The device clock is used solely for `localUpdatedAt`/`deletedAt`, both of which are sanity-bounded (§3.2), and for local backoff timers, where an inaccurate clock costs latency but cannot cause incorrect data resolution. |
| **INV-5** | **The `id` of a cloud row never changes after insert** (§3.2). Cursor stability depends on this: a mutated `id` would reorder a row relative to cursors already advanced past it. |

---

## 4. Server Data Model Additions

Additive only. No existing column, table, or RLS policy is removed or narrowed.

| Table | Addition | Purpose |
|---|---|---|
| `trades` | `deleted_at` (nullable timestamp) | Tombstone. |
| `trades` | Index on `(user_id, updated_at, id)` | Required for compound-cursor keyset pagination (§7) — `id` is the tie-breaker for rows sharing an `updated_at` value, which happens routinely for same-transaction batch writes. |
| `accounts` | `deleted_at` (nullable timestamp) | Tombstone. |
| `accounts` | Index on `(user_id, updated_at, id)` | Same as above. |
| `lists` | Index on `(user_id, updated_at, id)` | Same as above. (No `deleted_at` — singletons are never deleted, only reset, §9.1.) |
| `settings` | Index on `(user_id, updated_at, id)` | Same as above. |

**RLS is unchanged**: `auth.uid() = user_id` on select/insert/update/delete. **RLS does not filter on `deleted_at`** — tombstone visibility is an application-query concern (the sync engine's pull must see tombstones to propagate deletes), never a row-security concern. Any future query against these tables for *display* purposes must add its own `deleted_at IS NULL` filter; sync queries deliberately must not.

**`sync_meta` (old table):** retired as a migration decision state machine (§13). May be repurposed later as a thin, optional, non-load-bearing observability table; nothing in this design depends on it.

---

## 5. Sync Engine

### 5.1 Ownership boundary

| Owns network I/O and retry logic | Owns local read/write, UI state |
|---|---|
| Sync Engine (§5.2–5.4), active in exactly one tab at a time | Hooks (`useTrades`, `useAccounts`, `useLists`, `useSettings`), active in every tab |

Hooks, on a mutation, do exactly two things: (1) write the change to the local database with `syncStatus` set to `dirty`/`pending_delete` and `localUpdatedAt: now()` (sanity-bounded per §3.2), (2) return — the UI updates immediately from the local write. Hooks never construct a network request, never import a Supabase client, never handle a network error, and never check whether they are running in a leader or follower tab — that distinction is entirely internal to the Sync Engine.

### 5.2 Internal components

| Component | Responsibility |
|---|---|
| **Cross-Tab Coordinator** | Elects the leader tab; only the leader instantiates the rest of this component list. Broadcasts sync status to follower tabs. (Full spec: §5.3.) |
| **Scheduler** | Decides *when* a sync cycle runs (§6.3 triggers). Leader-only. |
| **Push Manager** | Finds pending-queue records, chunks them, sends them, interprets success/failure, updates `syncStatus`. The **only** code path in the system that sends record data to Supabase (§10). Leader-only. |
| **Pull Manager** | Per table, queries using the compound cursor (§7), hands results to the Conflict Detector, advances the cursor only after successful local application. Leader-only. |
| **Conflict Detector** | For each incoming pulled record, determines: apply directly, Tier 1 auto-resolve, or escalate to Tier 2. Re-evaluated fresh per record at apply time (§7, §8.1). Leader-only. |
| **Retry/Backoff Controller** | Tracks consecutive failures **per record** (never globally — §10), computes next-eligible-attempt time, exponential with a cap, resets on that specific record's success. Leader-only. |
| **Online Monitor** | Listens for `online`/`offline` browser events *and* treats any network-layer failure — including a malformed/non-JSON HTTP 200 response (§10) — as a possible offline signal regardless of what `navigator.onLine` claims. Leader-only. |

### 5.3 Cross-Tab Coordination

**Mechanism: the Web Locks API**, not a manually-maintained "leader flag" record. Web Locks is chosen specifically because the browser automatically releases a held lock when the holding tab closes or crashes — a manual flag-in-storage approach would require its own heartbeat-and-expiry logic to detect a dead leader, reintroducing exactly the kind of ambiguity this design is trying to eliminate.

**Leader election:** on startup, every tab attempts to acquire an exclusive Web Lock named for sync leadership. Exactly one tab succeeds immediately; that tab is the leader for as long as it remains open. Every other (or later-opened) tab's acquisition attempt queues, and the browser grants it automatically, in its own arbitration order, the moment the current leader's tab closes (releasing the lock). The app does not need to implement its own ordering — the browser's queuing is sufficient and correct.

**On becoming leader (whether at initial load or via later hand-off):** the newly-leading tab must run the startup reconciliation sweep (§6.1) before its first push/pull cycle — it cannot assume the previous leader (if any) exited cleanly.

**Follower behavior:**
- Followers **never** run push, pull, reconciliation, or cursor-advancing logic.
- Followers **do** read the shared local database directly for their own UI (trades list, dashboards, pending-count indicator) — IndexedDB itself is shared storage, readable by any tab.
- Followers **do** accept ordinary user mutations (editing a trade in a follower tab is fully supported) — that mutation is a plain local write (`syncStatus: dirty`), exactly as in the leader. Only the *network-driving* half of sync is leader-exclusive, not ordinary local writes.
- On a local mutation, a follower broadcasts a lightweight "dirty data available" ping via `BroadcastChannel` so the leader can opportunistically run an immediate push cycle rather than waiting for its next periodic tick — preserving the fast, snappy feel of the immediate-push trigger (§6.3) even when the mutating tab isn't the one doing the network work.

**Tier 2 dialog ownership:** only the leader's Conflict Detector can reach `needs_structural_review` (since only the leader pulls). The leader broadcasts this state change via `BroadcastChannel`. Follower tabs, on receiving it, show a lightweight, non-interactive "sync paused pending review in another tab" indicator — **never their own independent review dialog.** This is what prevents duplicate, uncoordinated Tier 2 dialogs across tabs. When the leader's dialog is resolved, it broadcasts the resolved state, and followers clear their indicator.

**Cursor ownership:** `sync_cursors` is written **only** by the leader. Followers may read it (for display/debug purposes) but must never write to it.

**Migration ownership:** the Step 6 storage cutover (§13) is likewise **leader-only** — a follower tab never performs the LocalStorage→IndexedDB copy. Followers wait on the completion marker (§13 Step 6) before reading business data from IndexedDB, and continue reading LocalStorage until it appears. This closes the otherwise-open case of several tabs, all loading a newly-deployed version simultaneously, racing the same one-time copy: the cutover's crash-safety protocol is designed for sequential restart, not for concurrent writers interleaving within it.

### 5.4 Singleton Initialization Discipline

Sync Engine initialization (the leader-side logic in §5.2) must be idempotent within a tab: if initialization is invoked a second time in the same tab (e.g., a development hot-reload, or an unexpected remount), it is a no-op if already initialized — it must not create a second set of timers, a second set of `online`/`offline` listeners, or a second Web Lock acquisition attempt. This is a direct extension of the leader-election guarantee: leadership is per-tab, and a tab accidentally running two independent copies of its own Sync Engine defeats that guarantee just as surely as a second tab would.

---

## 6. Sync State Machine

### 6.1 Per-record states

```
                 ┌───────────┐
   user edits    │           │  push attempt begins
  ┌─────────────►│   dirty   ├──────────────┐
  │  new record   │           │              │
  │               └─────▲─────┘              ▼
  │                     │              ┌───────────┐
  │        push fails,  │              │  syncing  │
  │        OR startup   └──────────────┤           │
  │        reconciliation              └─────┬─────┘
  │        (see below)                       │ push succeeds
  │                                          ▼
  │                                    ┌───────────┐
  │        incoming pull (no local     │  synced   │
  │        conflict) updates in place  │           │
  └───────────────────────────────────►└─────┬─────┘
                                              │ user deletes
                                              ▼
                                       ┌───────────────┐
                       push succeeds   │ pending_delete│
              ┌────────────────────── │               │◄── push attempt
              │                       └───────┬───────┘     begins
              ▼                               │              (→ syncing)
     (purged locally —                 push fails, OR
      see §9 lifecycle)                startup reconciliation
                                                │
                                                ▼
                                        stays pending_delete,
                                        retried per backoff
```

Full transition table:

| From | Event | To |
|---|---|---|
| — | User creates a record | `dirty` |
| `synced` | User edits | `dirty` |
| `synced` | User deletes | `pending_delete` |
| `pending_delete` | Recovery Bin restores the record before its delete has been pushed (§9.3) | `dirty`, `deletedAt` cleared to `null` |
| `dirty` / `pending_delete` | Push attempt begins (leader only) | `syncing` |
| `syncing` | Push succeeds (ordinary edit) | `synced`, **`baseUpdatedAt` set to the server-returned `updated_at`** (INV-1), `consecutiveFailures` reset to 0 |
| `syncing` | Push succeeds (tombstone) | Record purged from the local database entirely (§9.2) |
| `syncing` | Push fails (a definitive failure response) | back to `dirty` / `pending_delete` (retry-eligible, backoff advanced per §10) |
| `syncing` | **App/tab restarts, or sign-out occurs, while this record was in flight** | **Reconciliation (below, and §3.5 step 2) — never left in `syncing`.** |
| `synced` | Incoming pull, no conflict | `synced` (content updated in place, `baseUpdatedAt` set to the incoming `updated_at`) |
| `synced` | Incoming pull is a tombstone | Record purged from the local database entirely (§9.2a) — never passes through `pending_delete` |
| `dirty` / `syncing` | Incoming pull, Tier 1 conflict, **incoming wins** (§8.1) | `synced`, content replaced by the incoming version, `baseUpdatedAt` set to the incoming `updated_at` |
| `dirty` / `syncing` | Incoming pull, Tier 1 conflict, **local wins** (§8.1) | **`dirty`** — local content kept, `baseUpdatedAt` set to the incoming `updated_at` so the next push targets the correct base. The record remains in the pending queue and is pushed on the next cycle. |
| `dirty` / `syncing` | Incoming pull is a tombstone, but this device has an unsynced local edit | Tier 1 conflict, resolved by the same two rows above: incoming (the tombstone) winning purges the record; local winning keeps the record `dirty`, and its next push clears the cloud tombstone (§9.2) |

**Startup reconciliation (mandatory, runs once, before the newly-leading tab's first push/pull cycle — §5.3):** every record found in `syncing` state is deterministically reverted:
- If `deletedAt` is set → revert to `pending_delete`.
- Otherwise → revert to `dirty`.

This is always safe to do unconditionally, without knowing whether the previous in-flight request actually succeeded or failed server-side, because every push is idempotent (§10) — a redundant retry of an already-succeeded push is a harmless no-op. A record must never be found in `syncing` state by any logic *other than* this startup reconciliation step and the leader's own in-flight push — there is no third path that reads or acts on a `syncing` record, and in particular, `syncing` is excluded from the pending-queue definition (§3.2), so it is never independently picked up by a live push cycle while genuinely in flight.

### 6.2 Per-session states

```
idle → syncing → { in_sync | needs_structural_review | error_retrying } → idle
```

- `in_sync`: push and pull both completed cleanly this cycle.
- `needs_structural_review`: escalated to Tier 2 (§8.2). **Both push and pull are paused for the affected table(s)/record** until the user resolves it via the review dialog (leader-owned, broadcast to followers per §5.3). Pausing push as well as pull is required, not incidental: if push continued during an unresolved escalation, this device would upload its divergent local data to the cloud without consent — silently performing the "Upload Local Data" resolution the user has not chosen, in violation of Principle 4. Tables not implicated in the escalation continue to push and pull normally.
- `error_retrying`: a cycle failed (network/server); backoff scheduled, will retry automatically. Never a dead end.

Cycles are serialized per INV-2 (§3.6): a trigger arriving while a cycle is in progress never starts a concurrent second cycle.

### 6.3 Triggers

**Every trigger below initiates the identical full cycle, in the identical fixed order: push first, then pull. This ordering is uniform across every trigger type — there is no trigger for which the order is reversed or unspecified.**

| Trigger | Notes |
|---|---|
| App start, after auth resolves, in the leader tab | Runs startup reconciliation (§6.1) first if this tab just became leader, then the full push→pull cycle. |
| `online` browser event | **Clears per-record backoff state first** — `consecutiveFailures` reset to 0 and `nextEligibleAttemptAt` to `null` for every record in the pending queue — then runs the full push→pull cycle, so every pending record is immediately eligible. This is the one sanctioned bypass of per-record backoff. It is correct because backoff accumulated while the device was disconnected reflects the connectivity loss that just ended, not any property of the records themselves; carrying it forward would delay a reconnect by up to the backoff ceiling for no diagnostic benefit. A record that genuinely fails for its own reasons simply fails again on this attempt and resumes accumulating backoff from zero. No other trigger bypasses backoff. |
| Periodic timer (suggested: every 2–5 minutes, leader tab, online) | Full push→pull cycle. Covers missed/ambiguous online-state transitions. |
| Immediately after a local mutation (leader tab), or a "dirty data available" ping from a follower (§5.3) | Best-effort push of just the affected record(s) — fast path. Failure is not special-cased; the record simply stays in the pending queue for the next full cycle. Does not itself trigger a pull. |
| Tab regains visibility (`visibilitychange`), leader tab | Full push→pull cycle. Covers a laptop waking from sleep with a stale connection state. |

---

## 7. Pull Strategy

**Incremental only, per table, using a compound cursor `(updatedAt, id)` — never a bare timestamp.**

### 7.1 Why a bare timestamp cursor is unsafe

Postgres's `now()` returns the same value for every statement within one transaction. Any batch push (§10 — chunks of up to several hundred records, sent as one request/transaction) writes many rows sharing the exact same `updated_at`. A cursor compared with strict `>` on that value alone, once advanced past *any* row at that timestamp, permanently excludes every other row sharing it — `updated_at > cursor` is false for a row whose `updated_at` equals the cursor. This is not a rare race; it happens on every paginated pull that cuts through a same-transaction batch, which is routine, not exceptional.

### 7.2 Compound cursor definition

- **Ordering:** every pull query is `ORDER BY updated_at ASC, id ASC` — `id` (the row's own cloud-side primary key, already unique) is the deterministic tie-breaker for equal `updated_at` values. It carries no meaning beyond providing a total order; any two rows, even sharing an `updated_at`, are always distinguishable and orderable by `id`. `id` is client-generated at record creation and immutable thereafter (§3.2, INV-5); it is never the key used to match or upsert a record, which remains the natural business key (§10).
- **Comparison:** `WHERE (updated_at, id) > (:cursorUpdatedAt, :cursorId)` — evaluated as a row/tuple comparison (native Postgres support for this), not as two independent column comparisons. If the local cursor is unset (`cursorUpdatedAt`/`cursorId` both `null` — never synced), no filter is applied at all; the query returns everything for that table.
- **Pagination:** each page requests a bounded number of rows (same order of magnitude as the push batch size, §10) in the ordering above. The last row returned in a page becomes the provisional next-page cursor for the *remainder of this pull cycle*.
- **Advancing the persisted cursor:** the durable `sync_cursors` row for a table is updated to a new `(cursorUpdatedAt, cursorId)` value **only after every record in the current page has been successfully applied to the local database.** A page that is only partially applied (e.g., the app crashes mid-page) leaves the persisted cursor at its previous value; the entire page is safely re-fetched and re-applied on the next attempt (re-application of an already-applied, non-conflicting record is a harmless no-op — see §7.3). Cursor advancement is strictly forward-only per INV-3 (§3.6); the only backward movement permitted anywhere in this design is a deliberate reset to `(null, null)`, in the two places INV-3 enumerates.
- **`lastServerObservedAt` update:** alongside cursor advancement, `lastServerObservedAt` (§3.3) is updated to the newest `updated_at` seen in the page, if newer than the current value — this happens for every table's successful pull, not just the one being advanced, since it is a cross-table clock reference, not a per-table sync position.

### 7.3 Conflict detection is evaluated fresh, per record, at apply time

Conflict detection (§8.1) is never precomputed or cached once per pull cycle or once per page. It is re-evaluated at the exact moment each individual record is about to be applied, using the local database's state *at that instant*. This holds across page boundaries within one multi-page pull: if a local mutation happens between page 1 and page 2 being applied, page 2's conflict checks reflect that new local state, not a snapshot taken when the pull began. An implementation that snapshots "which records are locally dirty" once at the start of a pull, for performance, reintroduces exactly the blind-overwrite failure this architecture exists to prevent — this is not an optional optimization, it is a correctness requirement.

### 7.4 Why per-table cursors, not one global cursor

1. **Independent failure isolation.** If the trades pull succeeds but the accounts pull fails mid-cycle, a global cursor forces an unsafe choice between silently skipping the failed table's delta or unnecessarily re-pulling a table that already succeeded. Per-table cursors let each table's progress advance exactly as far as it has actually, successfully gotten.
2. **Independent recoverability.** A corrupted or stuck cursor for one table can be reset — forcing only that table through Tier 2 reconciliation — without touching the other three.
3. **Independent pacing (future-facing).** Leaves room for pulling rarely-changing tables less frequently without restructuring anything.

### 7.5 Cursor storage location

Cursors live **locally, per device, per user** (§3.3, §3.5) — never shared or written server-side. A shared server-side cursor would let one device's sync progress incorrectly represent another device's.

---

## 8. Conflict Resolution

### 8.1 Tier 1 — automatic, per-record, optimistic concurrency

**Exactly when a conflict exists:** during a pull, an incoming record conflicts with the local copy **if and only if**:
- The local record's `syncStatus` is `dirty` or `syncing` (this device has an unsynced or in-flight change to it), **and**
- The incoming record's `updated_at` differs from the local record's `baseUpdatedAt`.

If `syncStatus` is `dirty` but the incoming `updated_at` **equals** `baseUpdatedAt`, there is no conflict — the cloud hasn't moved since this device last saw it.

**Resolution algorithm** (compare `localUpdatedAt` vs. incoming `updated_at`; `localUpdatedAt` is the sanity-bounded value per §3.2, mitigating but not eliminating client-clock risk). These two outcomes correspond exactly to the two Tier 1 rows in §6.1's transition table:
- **Incoming is newer** → apply it locally (overwrite content), set `baseUpdatedAt` to the incoming value, and set `syncStatus = synced`. The record leaves the pending queue; this device's superseded local edit is not pushed.
- **Local is newer** → keep local content, advance `baseUpdatedAt` to the incoming value (so the next push targets the correct base), and **leave `syncStatus = dirty`**. The record stays in the pending queue and is pushed on the next cycle. It must not be marked `synced` here: that would remove a genuine, unsynced local edit from the pending queue permanently, silently discarding the user's change in violation of Principle 1.

**Notification (batched, not per-record):** every Tier 1 resolution within the same sync cycle is collected and surfaced as **one aggregated, dismissible notice** ("3 trades were updated on another device") rather than one notice per record. This satisfies the non-silent requirement (Principle 4) without producing notification fatigue during a burst of routine, individually-correct resolutions.

**Repeated-conflict escalation:** every Tier 1 resolution appends the incoming `updated_at` that triggered it to that record's `conflictResolutionLog` (§3.2), pruning entries older than the window in the same write. If the resulting list holds more than a small threshold (default 3, configurable — §14) of entries within a bounded rolling window (default 24 hours, configurable), that specific record is escalated to Tier 2 review instead of continuing to auto-resolve. Both the entries and the window boundary are server-derived timestamps, never local-clock reads (INV-4), and the log is persisted with the record so the rule cannot be defeated by a user who refreshes between conflicts. A record that keeps flip-flopping between two devices is a pattern the user should see directly, not something the system keeps silently arbitrating indefinitely — this is Tier 2 escalation rule 4 (§8.2). The log is cleared when the resulting Tier 2 review is resolved.

**Honest, remaining limitation:** the clock sanity rule (§3.2) bounds but does not eliminate the risk of an incorrect Tier 1 resolution from a skewed client clock. Fully eliminating it would require a server round-trip on every keystroke, disproportionate for this product. The batched notification plus the repeated-conflict escalation together ensure this is always visible and, if it recurs, escalated to a human — never silently compounding forever, which was the deeper concern with the unbounded version of this risk.

### 8.2 Tier 2 — manual review (existing `SyncConflictReview` dialog)

A sync session escalates from Tier 1 to Tier 2 (`needs_structural_review`) when **any** of the following holds:

1. **First sync**: a table's cursor has never been initialized on this device (§3.5's namespacing makes this precise per user, not just per device), *and* the local database already contains one or more records for that table with `baseUpdatedAt = null`.
2. **Conflict volume**: a single pull cycle produces more than a threshold (default 10, configurable — §14) of Tier 1-eligible conflicts. This count is **global across all four tables**, not per table — the threshold exists to detect that *this device as a whole* has structurally diverged, and divergence spread across several tables is exactly as structural as divergence concentrated in one. The count is also **accumulated across every page of every table's pull within the cycle, and never evaluated per page** — evaluating per page would let a large divergence (say, 50 conflicts spread over five pages of ten) slip through Tier 1 entirely while no single page ever crossed the threshold, silently defeating the rule for precisely the case it was written to catch. The counter is initialized to zero at the start of each cycle and is not carried across cycles.
3. **Expired retention window**: see the server-derived staleness check below.
4. **Repeated single-record conflict**: per §8.1's repeated-conflict escalation.

**Retention-window check — server-derived time only, never the local clock:** the comparison is `lastServerObservedAt (§3.3) − this table's cursorUpdatedAt > retention window`. Both sides of this comparison are server-derived values (the newest `updated_at` this device has observed from any successful response, and this table's own cursor timestamp) — `Date.now()` or any other local-clock read is never used in this specific check. If no server-derived reference has been observed yet this session (e.g., the device has been offline since before this session started, so no successful sync has happened yet to populate `lastServerObservedAt`), the check is deferred — the table's staleness is treated as unknown, not as "definitely fine," until at least one successful sync response is received. This fails safe toward *more* scrutiny, never less.

**Affected scope.** Escalation applies to a determinate set of tables: for rules 1 and 3, the single table that triggered it; for rule 4, the table owning the escalating record; for rule 2, **every table that contributed at least one conflict to the cycle's global count.** Push and pull both pause for exactly those tables (§6.2) and continue normally for all others.

**When escalated:** pause push and pull for the affected tables, surface the review dialog, resume normal incremental sync once resolved. Only the leader tab shows this dialog; followers show a passive indicator (§5.3). The dialog offers exactly four actions, each fully specified below, of which exactly **two are resolving** — "Upload Local Data" and "Use Cloud Data". "Download Local Backup" and "Cancel" are explicitly non-resolving. Until one of the two resolving actions completes, the escalation remains unresolved and re-triggers on the next cycle; completing either one lifts the push/pull pause for the affected tables.

**Tier 2's "Upload Local Data" action — single upload path (binding invariant):** this action performs **no network I/O of its own** and contains **no upload implementation of its own.** It marks the relevant divergent local records `dirty` (or `pending_delete`, where applicable) and returns — the existing Push Manager (§10) picks them up on its next cycle (which may be triggered immediately for responsiveness, using the exact same immediate-push path any other mutation uses). There is exactly one code path in this entire system that constructs and sends an upload request to Supabase: the Push Manager's chunked batch upsert. No component, including any Tier 2 action, may bypass it. This guarantees Tier 2's bulk reconciliation automatically inherits chunking, bisection, and per-record backoff — it cannot regress into an unchunked bulk call, because no such call exists anywhere to regress into.

**Tier 2's "Use Cloud Data" action — exact semantics.** This action discards this device's divergent local state for the affected tables in favour of the cloud's. It is ordered so that nothing local is destroyed until the cloud replacement has actually arrived and been applied:

1. For every local record in each affected table: set `syncStatus = synced`, `baseUpdatedAt = null`, `deletedAt = null`, `consecutiveFailures = 0`, `nextEligibleAttemptAt = null`, and empty `conflictResolutionLog`. Record content is left untouched at this stage. Because every record is now `synced`, none of them can produce a Tier 1 conflict during the pull that follows.
2. Reset each affected table's cursor to `(null, null)` — one of the two sanctioned backward cursor movements (INV-3).
3. Run a full pull for those tables. With a null cursor the pull returns every cloud row, and with every local record marked `synced` each one applies in place unconditionally, setting `baseUpdatedAt` to a real server value as it goes.
4. **Only after a table's pull has completed fully and successfully**, purge every record in that table still holding `baseUpdatedAt = null` **and** `syncStatus = synced` — precisely the records that exist locally but not in the cloud. The `syncStatus = synced` half of that condition matters: a record the user created locally *during* the pull is `dirty`, and is therefore correctly kept rather than purged.
5. If the pull fails partway, nothing is purged and no local content has been lost; the records remain marked and the cursor remains null, so the whole operation simply retries on the next cycle.

**Tier 2's "Download Local Backup" action** is non-destructive and changes no record metadata, no cursor, and no session state. It reuses the existing backup/export service unchanged, and leaves the dialog open — it is a safety step taken *before* choosing a resolving action, not a resolution itself.

**Tier 2's "Cancel" action — exact semantics.** Cancel changes nothing: no record's sync metadata, no cursor, no `conflictResolutionLog`, no durable escalation state. Session state returns to `idle`, and push and pull remain paused for the affected tables (§6.2). Because nothing was persisted to mark the escalation resolved, the identical escalation re-triggers on the next cycle. This is deliberate: Cancel means "not now," and the only way to leave the paused state is an explicit resolving choice. The app remains fully usable on local data throughout, and local mutations continue to be recorded as `dirty` — they simply are not pushed for the affected tables until the user resolves the review.

**Design note:** the old bespoke migration state machine (`sync_meta.decision`) is not needed as a separate mechanism. "First sync" is simply escalation rule 1 — the same code path handles it as any other structural divergence.

---

## 9. Deletes

### 9.1 Scope

Tombstones apply to **Trades and Accounts only.** Lists and Settings are singleton-per-user rows; never deleted, only updated or reset. No tombstone concept applies to them.

### 9.2 Lifecycle

1. **User deletes** a trade/account. Locally: `deletedAt = now()` (sanity-bounded per §3.2), `syncStatus = pending_delete`. Immediately filtered from every read path — feels instant.
2. **Never-synced record** (`baseUpdatedAt` is `null`): nothing to tombstone remotely — purge locally immediately, no network call.
3. **Push Manager** picks up `pending_delete` records in its normal sweep, sends a tombstone update (`deleted_at` set) through the **same single upload path** as any other push (§8.2, §10) — there is no separate delete-push mechanism. Every push payload, for live and deleted records alike, carries `deleted_at` **explicitly** (`null` for a live record). This is what allows a restored record's ordinary push to clear an existing cloud tombstone; if `deleted_at` were merely omitted for live records, an upsert of a restored record would leave the cloud row tombstoned and the restore would never propagate.
4. **On push success**: the local record is purged entirely.
5. **On push failure**: stays `pending_delete`, retried per the normal per-record backoff cycle (§10) — no special-casing.
6. **Cloud-side retention**: tombstoned rows are kept for a bounded window — recommended 90 days. Deliberately longer than, and independent of, the existing local Recovery Bin's 30-day retention: the Bin's window is a user-facing undo decision; the tombstone's window is a sync-correctness requirement, and they are allowed to differ.
7. **Cleanup**: rows older than the retention window are permanently purged, via a scheduled Postgres job (`pg_cron`, if available) or an application-triggered opportunistic cleanup as a fallback.

### 9.2a Receiving a tombstone via pull

The lifecycle above describes the device that *originated* a delete. A device that *receives* one, as an incoming pulled row with `deleted_at` set, behaves differently and deterministically:

- **Local record is `synced` (no unsynced local change):** the local record is **purged from the local database immediately**, in the same write that applies the page. It does **not** transition to `pending_delete` — that state means "this device originated a delete that still needs pushing," which is precisely not the case here. This device has nothing to push; the cloud is already authoritative for that row, and keeping a local tombstone would serve no purpose and would leave a record that §9.2's purge-on-push-success rule (which is keyed to push, not pull) would never clean up.
- **Local record is `dirty` or `syncing` (this device has an unsynced local edit):** this is an ordinary Tier 1 conflict, resolved by §8.1's standard comparison, not a special case. If the incoming tombstone wins, the record is purged as above. If the local edit wins, the record stays `dirty` with its `baseUpdatedAt` advanced, and its next push clears the cloud tombstone via the explicit `deleted_at: null` in the payload (§9.2 step 3) — a delete on one device losing to a concurrent, later edit on another is a legitimate Tier 1 outcome, surfaced by the same batched notification as any other.
- **No local record exists:** the tombstone is ignored; nothing is created locally in order to immediately delete it.

### 9.3 Interaction with Recovery Bin

Deliberately kept separate. The Recovery Bin continues to operate exactly as today — local, user-facing, independent of sync. The sync tombstone is invisible plumbing underneath it. Both can fire on the same delete action without either depending on the other. Unification is a possible future phase, not assumed or required here.

**Restoring a record from the Recovery Bin — sync-metadata semantics.** The Bin's own UI and retention logic are out of scope here, but the sync-metadata effect of a restore is this document's concern regardless of which feature triggers it. Two cases, both deterministic:

- **The record still exists locally as `pending_delete`** (deleted, but its tombstone has not yet been pushed): clear `deletedAt` to `null` and set `syncStatus = dirty` with a fresh `localUpdatedAt`. The pending tombstone push is thereby cancelled before it ever happens — the record simply returns to the pending queue as an ordinary edit. `baseUpdatedAt` is left untouched, since the cloud row was never modified.
- **The record was already purged locally** (its tombstone push succeeded before the restore): the restore re-creates it as a local record with `syncStatus = dirty`, `deletedAt = null`, and `baseUpdatedAt = null`, reusing its original `id` and natural business key. Its next push upserts on that natural key and, because the payload always carries an explicit `deleted_at: null` (§9.2 step 3), clears the cloud tombstone and brings the record back on every device.

---

## 10. Push Strategy

**Idempotency:** every push is an upsert keyed on the existing natural identity already established in the schema. Any retry — partial or full — is safe to repeat without risk of duplication.

**Single upload path:** the Push Manager is the only code in the system that sends record data to Supabase (§8.2). Every category of write — ordinary edits, deletes (as tombstone upserts), Tier 2 bulk reconciliation, the one-time migration's initial catch-up upload — goes through it.

**Batch sizing:** pending-queue records are chunked into bounded batches (suggested starting point: 200–500 records per request, tuned empirically to stay comfortably under request payload limits). Batch size is bounded, never unbounded, in every code path, with no exception.

**On push success:** the record's `baseUpdatedAt` is set to the server-returned `updated_at` for that row, `syncStatus` becomes `synced` (or the record is purged, for a tombstone), and `consecutiveFailures`/`nextEligibleAttemptAt`/`lastError` are cleared. Setting `baseUpdatedAt` here is mandatory, not incidental — INV-1 (§3.6). The push request must therefore be issued so that the server returns the written rows' `updated_at` values, not a bare acknowledgement; a push whose response does not carry them cannot satisfy INV-1 and is treated as an ambiguous failure (below) rather than a success.

**Backoff — tracked per record, never globally:** each record's own `consecutiveFailures` and `nextEligibleAttemptAt` are durable fields on the record itself (§3.2), so backoff survives refresh, crash, and browser restart exactly as the rest of a record's sync metadata does. Batch assembly excludes any record whose `nextEligibleAttemptAt` is still in the future. A success on one record must never reset another, unrelated record's backoff state. (After bisection, below, backoff is tracked per the resulting isolated record/sub-batch, not per the original batch.) Backoff is exponential, capped (suggested: 2s → 4s → 8s → … → 60s ceiling), reset to the initial interval only for the specific record/batch that just succeeded. The `online` trigger (§6.3) is the single sanctioned bypass of these timers.

**Partial failure handling:**
- **Systemic failures** (a clean, definitive response affecting the whole batch identically — an auth error, a 5xx, a confirmed network-level rejection) trigger whole-batch backoff-and-retry.
- **Per-row failures** (a specific record identifiably failing a constraint) trigger **bisection**: split the failing batch in half, retry each half independently, continuing to bisect down to individual-record granularity until the bad record(s) are isolated.
- **Ambiguous/timeout failures are never permanently classified as systemic.** A batch (or sub-batch, post-bisection) that fails via timeout or any other non-definitive signal is retried, with backoff, as systemic **up to a threshold of N consecutive ambiguous failures for the same batch composition (default N = 3, configurable — §14).** On the (N+1)th consecutive ambiguous failure, the batch is treated as if a per-row rejection had been identified and bisection begins — even without a clean signal pointing to a specific row. This guarantees a batch containing one pathologically slow/malformed record cannot trap every other, healthy record in it behind an endless string of whole-batch timeouts.
- A record that still fails repeatedly even after isolation to itself remains `dirty` (no new top-level `syncStatus` value is introduced) but is flagged with its retry count and last error, surfaced through the pending-changes indicator.

**Malformed HTTP 200 handling:** a response that returns HTTP 200 but fails to parse as the expected structure (e.g., a captive-portal login page returned instead of JSON) is treated identically to a network-layer failure for retry/backoff purposes. It must never be allowed to throw an unhandled exception that aborts a sync cycle uncleanly — it is caught, classified as an ambiguous failure (subject to the same-timeout-escalation rule above), and retried.

---

## 11. Offline & Failure Behavior

| Scenario | Behavior |
|---|---|
| **Fully offline** (no network) | Detected via `online`/`offline` events and/or failed fetch attempts. All network I/O pauses (leader tab only attempts it in the first place). Reads/writes continue locally without interruption. A passive "offline" indicator is shown. |
| **Server unavailable** (network fine, Supabase down or returning 5xx) | Treated identically to offline for retry purposes. |
| **Captive portal / malformed response** (network "looks" online, responses aren't valid) | Classified as an ambiguous failure (§10) — never an unhandled exception, never permanently "systemic." |
| **Authentication expired mid-sync** | Requests fail with an auth error; sync pauses, relies on the existing Supabase auto-refresh mechanism, resumes automatically once restored. If refresh genuinely fails, the user returns to the login screen (existing `AuthGate` behavior) — local data remains fully present and namespaced (§3.5) for when they sign back in. |
| **Repeated retry failures beyond the backoff cap** | The record/batch stays retry-eligible indefinitely at the capped interval — never abandoned. The pending-changes indicator escalates visually without ever discarding anything. |
| **Refresh or crash while dirty/pending_delete records exist** | No special handling required — durable, survives automatically, resumed by the next cycle. |
| **Refresh or crash while a record was `syncing`** | Resolved deterministically by the mandatory startup reconciliation (§6.1) the next time this tab (or another) becomes leader. |
| **Two or more tabs open** | Exactly one leader runs the engine (§5.3); followers reflect its state, never run their own. |
| **Sign-out with pending local changes** | Changes remain durable in the namespaced local database (§3.5); nothing is lost or synced away; resumes on next sign-in as the same user. |

---

## 12. Scalability Strategy (100,000+ trades)

| Concern | Approach |
|---|---|
| **Local storage capacity** | IndexedDB removes the LocalStorage quota ceiling (§3.4). |
| **Local query performance** | IndexedDB's indexed lookups replace full in-memory array scans for anything scoped that way. |
| **List rendering** | The already-built-but-unwired `VirtualizedList` primitive is wired into the Raw trade table — necessary, not optional, at this scale. |
| **Network cost per session** | Incremental delta sync (§7) keeps ongoing sync cost proportional to *changes*, not total history size. |
| **Bulk transfer** (a device returning after a long gap) | Both push and pull are chunked/paginated (§7, §10) — never one unbounded request. |
| **Server query performance** | New `(user_id, updated_at, id)` indexes (§4) make delta queries efficient; existing `(user_id, date)` / `(user_id, symbol)` / `(user_id, account_id)` indexes are retained. |
| **In-memory calculation cost** | Explicitly out of scope — `calculations/` remains frozen and still expects a full in-memory trade array. IndexedDB removes the storage ceiling; it does not by itself solve full-history-recompute cost. Flagged as a distinct, later concern. |

---

## 13. Migration Plan (from the pre-redesign implementation)

Each step is independently deployable and preserves all existing user data.

### Step 1 — Server schema additions
Add `deleted_at` and the `(user_id, updated_at, id)` index to all four tables. Purely additive; nothing reads or writes these columns yet.

### Step 2 — Retire the old sync code paths
Remove the old per-hook cloud write-through calls and the old migration-decision machinery. Returns the app to pure local-only operation — a fully correct, supported state. Cross-device sync is offline until Step 5, by design.

### Step 3 — Introduce local sync metadata on the current storage medium (LocalStorage), before touching IndexedDB

Add the full §3.2 metadata field set to existing local records via a one-time stamping pass: every existing record receives a freshly generated `id`, `syncStatus: dirty`, `baseUpdatedAt: null`, `deletedAt: null`, `consecutiveFailures: 0`, `nextEligibleAttemptAt: null`, `lastError: null`, and an empty `conflictResolutionLog`, with `localUpdatedAt` set to the moment of stamping. This correctly represents "this device's entire existing history is being introduced to sync for the first time" and will correctly route through Tier 2 review (escalation rule 1) once sync is turned back on in Step 5.

**Restart safety.** Unlike the Step 6 cutover, this pass is **resumable in place** and needs no completion marker, because it is idempotent at the granularity of a single record: a record that already carries `syncStatus` is skipped, a record that does not is stamped. An interruption at any point therefore leaves a mixture of stamped and unstamped records that the next run simply completes — no state is ambiguous, nothing is double-stamped, and no record can be stamped twice with two different `id` values. This is a deliberate difference from Step 6, which restarts wholesale precisely because its intermediate state (a partially-copied IndexedDB) is *not* self-describing in this way. The pass writes only additive fields and never alters existing business content, so it is also safe to run against a store another tab is concurrently reading.

### Step 4 — Build the sync engine
Build the Cross-Tab Coordinator, Scheduler, Push Manager, Pull Manager, Conflict Detector, and Retry/Backoff Controller (§5) as a new, self-contained module operating against the Step 3 data model (still LocalStorage-backed). Build and validate in isolation before wiring into the app.

### Step 5 — Wire the sync engine into the app
Connect the Scheduler to app startup/triggers (§6.3). Update the four hooks to only read/write local storage and mark records dirty (§5.1). Every existing device's first cycle under the new engine naturally routes through Tier 2 — an explicit, reviewed reconciliation, exactly once, with full user consent.

**Recommended rollout control:** gate Step 5 behind a feature flag, small cohort first. Rollback returns affected users to Step 2's local-only mode — never destructive.

### Step 6 — Migrate local storage from LocalStorage to IndexedDB, crash-safely

This cutover must be atomic from the app's perspective. It is specified precisely as follows:

0. **Ownership and sequencing.** The cutover is **leader-only** (§5.3) — exactly one tab performs it, elected by the same Web Lock that governs ongoing sync; follower tabs wait on the completion marker (step 4) and keep reading LocalStorage until it appears. It runs **only once an authenticated `user_id` is available**, because every record it writes must land in that user's namespace (§3.5); if no user is signed in, the cutover is deferred until sign-in completes rather than being performed against an unknown namespace.
1. **A dedicated `migration_state` local record** (separate from business data) tracks the cutover's own progress — not to be confused with the Step 3 per-record `dirty` stamping, which is business-data state.
2. **Copy phase:** read every existing LocalStorage record and write it into IndexedDB, in the Step 3 shape (sync metadata included), for every store (`trades`, `accounts`, `lists`, `settings`, `sync_cursors`). LocalStorage is only ever *read* during this phase, never modified or cleared.
3. **Verification phase:** after the copy completes, read the copied records back out of IndexedDB and confirm the record count (per store) matches the LocalStorage source exactly.
4. **Completion marker:** only after verification passes, write a single completion flag into `migration_state`. This is the last write of the entire cutover.
5. **Restart behavior:** on every app load, before trusting IndexedDB for any business-data read or write, check for the completion marker.
   - **Marker present:** IndexedDB is authoritative. Proceed normally.
   - **Marker absent:** the previous cutover attempt (if any) is treated as incomplete, regardless of how far it got. **Do not attempt to resume a partial copy.** Instead, discard whatever partial IndexedDB business data exists (safe — it was never marked authoritative) and restart the entire copy phase from LocalStorage, which remains untouched and correct throughout. This is deliberately simpler and safer than incremental resume logic, because this is a one-time, bounded-size operation where full-restart cost is acceptable, unlike the ongoing incremental pull (§7), where full-restart cost is not.
6. **Post-cutover:** LocalStorage data is *not* cleared immediately — retained for a window as a rollback safety net, even though IndexedDB is authoritative from the completion marker onward.

### Step 7 — Wire `VirtualizedList` into the Raw trade table
Independent of everything else — a rendering-scalability concern, not a sync-correctness one. Can happen at any point.

---

## 14. Operational Configuration & Telemetry

**Configurable thresholds — not hardcoded client constants.** The following values are directly load-bearing for data-safety behavior (they determine what silently auto-resolves versus what requires human review) and must be sourced from a configuration layer the operating team can change without a full client release cycle (e.g., server-supplied config fetched at startup, or a remote-config mechanism), not compiled into client code:

| Parameter | Default | Governs |
|---|---|---|
| Tombstone retention window | 90 days | §8.2 escalation rule 3, §9.2 |
| Tier 2 conflict-volume threshold | 10 | §8.2 escalation rule 2 |
| Repeated-conflict threshold / window | 3 / 24h | §8.1, §8.2 escalation rule 4 |
| Timeout-escalation-to-bisection count (N) | 3 | §10 |
| Push batch size | 200–500 | §10 |
| Backoff initial interval / cap | 2s / 60s | §10 |
| Periodic sync interval | 2–5 min | §6.3 |
| Local clock sanity tolerance | 5 min | §3.2 |

A hardcoded default is acceptable as a fallback (e.g., if the config fetch itself fails while offline), but the values above must not be *only* reachable by shipping a new client version.

**Telemetry hooks — required observability for the operating team**, distinct from the user-facing pending-count indicator:
- Sync cycle start/end/outcome (per leader-tab session).
- Per-batch push outcome, with error classification (systemic / per-row / ambiguous-escalated-to-bisection).
- Every Tier 2 escalation, tagged with which rule (1–4) triggered it.
- Records that have exceeded the retry-count-worth-flagging threshold (§10).
- Quota-exhaustion events (§3.4).
- Leader-election events (which tab became leader, and why — initial load vs. hand-off).

This must be wired into an application-level telemetry/error-reporting integration point so systemic problems (e.g., "N users have records stuck beyond threshold") are detectable proactively, not only through user support tickets.

---

## 15. Risk Register

### 15.1 Local Storage / IndexedDB

| | |
|---|---|
| **Risks** | Asynchronous API ripple through the hooks layer; quota exhaustion; browser-specific quirks; schema-upgrade hangs across tabs. |
| **Mitigations (specified)** | Centralized local-data-access module; explicit `versionchange` handling in every tab (§3.4); quota failures surfaced as a distinct blocking notice, never conflated with sync-pending (§3.4). |
| **Residual risk** | Genuinely low once the above are implemented as specified — no open gap remains at the specification level. |

### 15.2 Sync Engine — Push

| | |
|---|---|
| **Risks** | Partial batch failure; ambiguous/timeout misclassification; double-push across tabs. |
| **Mitigations (specified)** | Bisection with a mandatory timeout-escalation fallback (§10); per-record backoff (§10); leader-exclusive pushing eliminates cross-tab double-push entirely (§5.3). |
| **Residual risk** | Low. |

### 15.3 Sync Engine — Pull

| | |
|---|---|
| **Risks** | Non-unique timestamp cursor silently skipping rows; cursor advancing past a partially-applied page. |
| **Mitigations (specified)** | Compound `(updatedAt, id)` cursor with keyset pagination (§7) closes the tie-breaker gap entirely; cursor advancement gated on full, successful page application, never partial (§7.2). |
| **Residual risk** | Low — this was the most severe finding in the prior review and is now fully closed by the compound-cursor redefinition. |

### 15.4 Conflict Resolution (Tier 1)

| | |
|---|---|
| **Risks** | Client clock skew causing an incorrect automatic resolution; a persistently-wrong clock compounding across many future comparisons. |
| **Mitigations (specified)** | Clock sanity clamping (§3.2); batched, non-silent notification (§8.1); repeated-conflict escalation to Tier 2 after a threshold, bounding how long a bad resolution can keep recurring undetected (§8.1, §8.2 rule 4). |
| **Residual risk** | Medium — a moderately (not wildly) skewed clock within the sanity tolerance can still occasionally win incorrectly. This is an accepted, disclosed tradeoff, not a solved problem; the mitigations bound its severity and duration rather than eliminate the possibility outright. |

### 15.5 Tombstones / Deletes

| | |
|---|---|
| **Risks** | Retention window relied on a client clock, allowing a slow-clocked device to wrongly skip Tier 2 review and see a deletion "come back." |
| **Mitigations (specified)** | Retention-window check now uses only server-derived timestamps (`lastServerObservedAt` vs. cursor), never the local clock, and fails safe (defers, doesn't assume "fine") when no server reference exists yet this session (§8.2). |
| **Residual risk** | Low. |

### 15.6 Cross-Tab Concurrency

| | |
|---|---|
| **Risks** | Multiple tabs independently pushing/pulling the same records; duplicate Tier 2 dialogs. |
| **Mitigations (specified)** | Web Locks-based leader election, follower tabs never run network sync logic, Tier 2 dialog ownership is leader-exclusive with broadcast status to followers (§5.3). |
| **Residual risk** | Low. This was previously an entirely unaddressed subsystem; it is now first-class. |

### 15.7 Cloud Schema / RLS

| | |
|---|---|
| **Risks** | A future feature querying `trades`/`accounts` directly without excluding tombstones. |
| **Mitigations (specified)** | Documented standing contract (§4): RLS deliberately does not filter `deleted_at`; any display query must add its own filter. |
| **Residual risk** | Low severity even if hit — a display bug, not a data-integrity bug. |

### 15.8 Migration Process Itself

| | |
|---|---|
| **Risks** | Turning the new engine on (Step 5) affects every existing user's first sync at once; an interrupted Step 6 storage cutover. |
| **Mitigations (specified)** | Feature-flagged, staged rollout for Step 5; explicit completion-marker/verify/restart-from-scratch protocol for Step 6 (§13), making that cutover crash-safe. |
| **Residual risk** | Low for Step 6 (fully specified now). Step 5's blast radius is inherently broad by nature (every user's first sync under a new system) — mitigated, not eliminated, by staged rollout. |

### 15.9 Per-User Local Database Ownership

| | |
|---|---|
| **Risks** | Data confusion between two different users on a shared device. |
| **Mitigations (specified)** | Namespacing every local store by `user_id` (§3.5), with RLS as an independent, redundant backstop against any cross-account server-side write even if namespacing were ever violated by a bug. |
| **Residual risk** | Low. |

---

## 16. Explicit Non-Goals

- **No CRDTs / operational transforms.** One user editing independent, whole-record-replaceable entities across their own devices — not multiple concurrent writers editing a shared mutable structure. State-based sync with timestamp comparison is sufficient.
- **No event sourcing.** The actual problem (unreliable delivery of mutations) is solved by the dirty-flag/outbox pattern without restructuring the data model into an event log, which would ripple into the frozen `calculations/` layer for no corresponding benefit.
- **No version vectors.** A server-authoritative `updated_at` plus the Tier 1 comparison is sufficient for this product's actual conflict rate and threat model.
- **No true compare-and-swap / RPC-based conditional writes on push.** Conflicts are detected after the fact on the next pull, not prevented at write time — justified because a genuinely simultaneous edit to the same record from two devices is rare enough, for a single-user product, that the added server-side complexity isn't worth it.

These were evaluated under adversarial review specifically for gaps that might justify reintroducing one of them, and none did — every finding in the prior review was closed with a bounded, well-understood mechanism (a compound cursor, a startup reconciliation rule, leader election, timeout-escalation bisection), not by reaching for heavier machinery.

---

*End of specification — Revision 3.*
