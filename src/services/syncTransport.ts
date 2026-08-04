/**
 * services/syncTransport.ts
 *
 * Phase 5b — real Supabase-backed PushTransport/PullTransport
 * implementations (SYNC_ARCHITECTURE_SPEC.md §10, §7). Communication
 * only: every content<->row translation lives in services/syncMappers.ts,
 * per the explicit instruction to keep mapping logic isolated and
 * testable, separate from this file's job (build requests, send them,
 * classify responses).
 *
 * DEPENDENCY-INJECTION BOUNDARY: implements the frozen PushTransport/
 * PullTransport interfaces from src/sync/pushManager.ts,pullManager.ts
 * exactly as given — neither interface's method signature is touched.
 * `WirePushRow`'s shape (content/deletedAt/cloudId envelope) and
 * `PulledRow`'s shape (id/updatedAt/deletedAt/content) are both
 * consumed/produced as already defined there.
 *
 * user_id: resolved fresh per request via `supabase.auth.getUser()`
 * (server-validated, not the cached/unverified `getSession()`) — RLS
 * remains the enforced backstop regardless (§3.5's "defense in depth").
 *
 * KEYSET PAGINATION (§7.2): the compound-cursor tuple comparison
 * `(updated_at, id) > (cursorUpdatedAt, cursorId)` has no native
 * method on the supabase-js query builder. Expressed via PostgREST's
 * `.or()` filter DSL — `updated_at.gt.X OR (updated_at.eq.X AND
 * id.gt.Y)`, exactly equivalent to the tuple comparison — per the
 * approved decision: no RPC, SQL function, or schema change.
 *
 * PUSH BATCHING: a single call to `push()` can contain a mix of
 * first-ever-push rows (`cloudId !== null` — needs `id` in the INSERT
 * payload) and ordinary-update rows (`cloudId === null` — must NOT
 * include `id`, since it's excluded from the update column set, §3.2).
 * PostgREST requires a uniform column set per bulk request, so each
 * call is split into up to two upsert requests by that boolean, never
 * mixed in one payload.
 */

import { supabase } from '@services/supabaseClient.js';
import type { PushTransport, WirePushRow, PushTransportResult, PushSuccessRow } from '@sync/pushManager.js';
import type { PullTransport, PullCursor, PullTransportResult, PulledRow } from '@sync/pullManager.js';
import type { SyncTableName } from '@sync/scheduler.js';
import {
  tradeContentToRow, tradeRowToContent, TRADE_NATURAL_KEY_COLUMNS,
  accountContentToRow, accountRowToContent, ACCOUNT_NATURAL_KEY_COLUMNS,
  singletonContentToRow, singletonRowToContent, SINGLETON_NATURAL_KEY_COLUMNS,
} from './syncMappers.js';

// ─── Shared: current user, error classification ──────────────────────

async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new Error(error?.message ?? 'Not authenticated — sync requires a signed-in user.');
  }
  return data.user.id;
}

/**
 * §10 classification: "auth error, a 5xx, a confirmed network-level
 * rejection" -> systemic; "a specific record identifiably failing a
 * constraint" -> per-row; "timeout or any other non-definitive signal"
 * -> ambiguous.
 */
type FailureKind = 'systemic_failure' | 'per_row_failure' | 'ambiguous_failure';

const FAILURE_RANK: Record<FailureKind, number> = {
  ambiguous_failure: 1,
  per_row_failure: 2,
  systemic_failure: 3,
};

const PER_ROW_PG_CODES = new Set(['23505', '23514', '23502', '22P02', '23503']); // unique/check/not-null/invalid-input/fk violations
const SYSTEMIC_PG_CODES = new Set(['28000', '28P01', '42501']); // auth/permission

function classifyError(error: { code?: string; message?: string } | null, status?: number): FailureKind {
  if (status === 401 || status === 403 || (status !== undefined && status >= 500)) return 'systemic_failure';
  const code = error?.code;
  if (code && SYSTEMIC_PG_CODES.has(code)) return 'systemic_failure';
  if (code && PER_ROW_PG_CODES.has(code)) return 'per_row_failure';
  return 'ambiguous_failure';
}

// ─── Push ──────────────────────────────────────────────────────────────

interface PushTableConfig {
  table: string;
  naturalKeyColumns: readonly string[];
  contentToRow: (content: Record<string, unknown>) => Record<string, unknown>;
  hasDeletedAtColumn: boolean;
}

function createPushTransport(config: PushTableConfig): PushTransport {
  return {
    async push(rows: WirePushRow[]): Promise<PushTransportResult> {
      if (rows.length === 0) return { kind: 'success', rows: [] };

      let userId: string;
      try {
        userId = await getCurrentUserId();
      } catch (err) {
        return { kind: 'systemic_failure', error: err instanceof Error ? err.message : String(err) };
      }

      const buildPayload = (group: WirePushRow[], includeId: boolean): Record<string, unknown>[] =>
        group.map((r) => {
          const dbRow = config.contentToRow(r.content);
          dbRow.user_id = userId;
          if (config.hasDeletedAtColumn) dbRow.deleted_at = r.deletedAt;
          if (includeId) dbRow.id = r.cloudId;
          return dbRow;
        });

      const groups: Array<{ rows: WirePushRow[]; includeId: boolean }> = [
        { rows: rows.filter((r) => r.cloudId !== null), includeId: true },
        { rows: rows.filter((r) => r.cloudId === null), includeId: false },
      ];

      const successRows: PushSuccessRow[] = [];
      let worstFailure: FailureKind | null = null;
      let failureError = '';

      const recordFailure = (kind: FailureKind, message: string) => {
        if (worstFailure === null || FAILURE_RANK[kind] > FAILURE_RANK[worstFailure]) {
          worstFailure = kind;
        }
        failureError = failureError ? `${failureError}; ${message}` : message;
      };

      for (const group of groups) {
        if (group.rows.length === 0) continue;
        const payload = buildPayload(group.rows, group.includeId);

        try {
          const { data, error, status } = await supabase
            .from(config.table)
            .upsert(payload, { onConflict: config.naturalKeyColumns.join(',') })
            .select('id, updated_at');

          if (error) {
            recordFailure(classifyError(error, status), error.message ?? 'Unknown Postgres error');
            continue;
          }
          for (const row of (data ?? []) as Record<string, unknown>[]) {
            const id = row.id;
            const updatedAt = row.updated_at;
            if (typeof id === 'string' && typeof updatedAt === 'string') {
              successRows.push({ syncId: id, updatedAt });
            }
          }
        } catch (err) {
          // Defensive: §10 requires a conforming transport to never
          // throw uncleanly — treat an unexpected exception (network
          // drop, malformed response) as ambiguous, not systemic or
          // per-row, since there is no clean signal here.
          recordFailure('ambiguous_failure', err instanceof Error ? err.message : String(err));
        }
      }

      if (worstFailure !== null) {
        return { kind: worstFailure, error: failureError };
      }
      if (successRows.length === 0) {
        // §10: "a push whose response does not carry [updated_at]
        // values cannot satisfy INV-1 and is treated as an ambiguous
        // failure rather than a success."
        return { kind: 'ambiguous_failure', error: 'Upsert returned no rows.' };
      }
      return { kind: 'success', rows: successRows };
    },
  };
}

// ─── Pull ──────────────────────────────────────────────────────────────

interface PullTableConfig {
  table: string;
  hasDeletedAtColumn: boolean;
  rowToContent: (row: Record<string, unknown>) => Record<string, unknown>;
}

function createPullTransport(config: PullTableConfig): PullTransport {
  return {
    async fetchPage(cursor: PullCursor, pageSize: number): Promise<PullTransportResult> {
      let userId: string;
      try {
        userId = await getCurrentUserId();
      } catch (err) {
        return { kind: 'failure', error: err instanceof Error ? err.message : String(err) };
      }

      try {
        let query = supabase
          .from(config.table)
          .select('*')
          .eq('user_id', userId)
          .order('updated_at', { ascending: true })
          .order('id', { ascending: true })
          .limit(pageSize);

        // §7.2 compound-cursor tuple comparison, via PostgREST's `.or()`
        // filter DSL — see file header. Unfiltered when the cursor is
        // unset (never synced), matching "no filter is applied at all."
        if (cursor.updatedAt !== null && cursor.id !== null) {
          query = query.or(
            `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`,
          );
        }

        const { data, error } = await query;
        if (error) {
          return { kind: 'failure', error: error.message };
        }

        const rows = (data ?? []) as Record<string, unknown>[];
        const pulledRows: PulledRow[] = rows.map((row) => ({
          id: String(row.id),
          updatedAt: String(row.updated_at),
          deletedAt: config.hasDeletedAtColumn ? ((row.deleted_at as string | null | undefined) ?? null) : null,
          content: config.rowToContent(row),
        }));

        return {
          kind: 'success',
          page: { rows: pulledRows, isLastPage: pulledRows.length < pageSize },
        };
      } catch (err) {
        // Defensive: malformed/non-JSON response or a network-layer
        // exception — never thrown uncaught (§10, applies to any
        // network operation per §11).
        return { kind: 'failure', error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ─── Per-table concrete transports ────────────────────────────────────

export function createTradesPushTransport(): PushTransport {
  return createPushTransport({
    table: 'trades',
    naturalKeyColumns: TRADE_NATURAL_KEY_COLUMNS,
    contentToRow: tradeContentToRow,
    hasDeletedAtColumn: true,
  });
}

export function createTradesPullTransport(): PullTransport {
  return createPullTransport({ table: 'trades', hasDeletedAtColumn: true, rowToContent: tradeRowToContent });
}

export function createAccountsPushTransport(): PushTransport {
  return createPushTransport({
    table: 'accounts',
    naturalKeyColumns: ACCOUNT_NATURAL_KEY_COLUMNS,
    contentToRow: accountContentToRow,
    hasDeletedAtColumn: true,
  });
}

export function createAccountsPullTransport(): PullTransport {
  return createPullTransport({ table: 'accounts', hasDeletedAtColumn: true, rowToContent: accountRowToContent });
}

export function createListsPushTransport(): PushTransport {
  return createPushTransport({
    table: 'lists',
    naturalKeyColumns: SINGLETON_NATURAL_KEY_COLUMNS,
    contentToRow: singletonContentToRow,
    hasDeletedAtColumn: false, // §9.1 — no deleted_at column on this table; stripped, never sent
  });
}

export function createListsPullTransport(): PullTransport {
  return createPullTransport({ table: 'lists', hasDeletedAtColumn: false, rowToContent: singletonRowToContent });
}

export function createSettingsPushTransport(): PushTransport {
  return createPushTransport({
    table: 'settings',
    naturalKeyColumns: SINGLETON_NATURAL_KEY_COLUMNS,
    contentToRow: singletonContentToRow,
    hasDeletedAtColumn: false,
  });
}

export function createSettingsPullTransport(): PullTransport {
  return createPullTransport({ table: 'settings', hasDeletedAtColumn: false, rowToContent: singletonRowToContent });
}

/** All four tables' transports, bundled for Phase 5d's `SyncEngineDependencies` assembly. */
export function createAllTransports(): Record<SyncTableName, { pushTransport: PushTransport; pullTransport: PullTransport }> {
  return {
    trades:   { pushTransport: createTradesPushTransport(),   pullTransport: createTradesPullTransport() },
    accounts: { pushTransport: createAccountsPushTransport(), pullTransport: createAccountsPullTransport() },
    lists:    { pushTransport: createListsPushTransport(),    pullTransport: createListsPullTransport() },
    settings: { pushTransport: createSettingsPushTransport(), pullTransport: createSettingsPullTransport() },
  };
}
