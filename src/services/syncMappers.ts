/**
 * services/syncMappers.ts
 *
 * Phase 5b — pure, dependency-free translation between the local
 * record model (opaque `content: Record<string, unknown>`, per
 * PushableRecord/PulledRow in src/sync/pushManager.ts,pullManager.ts)
 * and the physical Supabase schema (supabase/phase4_cloud_sync_schema.sql
 * + supabase/migrations/20260801000000_sync_tombstones_and_cursor_indexes.sql).
 *
 * Deliberately isolated from services/syncTransport.ts: this file does
 * no I/O and imports no Supabase client — every export here is a pure
 * content<->row transform, independently testable without a network
 * or a database, per the explicit instruction that mapping logic stay
 * separate from the transport's communication responsibility.
 *
 * SCOPE:
 *   - trades: the DB schema predates this sync architecture (a
 *     "hybrid relational/JSONB design" built for the retired
 *     services/cloudSync.ts) and uses snake_case dedicated columns for
 *     most fields plus an `extra` jsonb bucket for the long-tail ones
 *     (beSL/afSL/sl1-3/tm1-6) — exactly as that column's own schema
 *     comment describes. Computed analytics columns (r_multiple,
 *     planned_r, pl, net_pl, risk_value, points, outcome,
 *     duration_mins, is_futures) are never written — outside the
 *     synchronization contract per the approved decision.
 *   - accounts: one field rename, `content.id` (business identifier)
 *     -> `local_id`. The DB `id` column is the cloud primary key
 *     (syncId), populated separately by the transport, never from
 *     content (record.ts's "Record identity" note).
 *   - lists/settings: a single `data jsonb` column — wrap/unwrap only.
 */

import type { RawTradeContent } from '@apptypes/trade.js';

// ─── Shared scalar coercion helpers ──────────────────────────────────
// The local record model represents every trade field as a string
// (including numeric/date/time/boolean-shaped ones) — createEmptyTrade()
// defaults every field to ''. The DB schema uses real Postgres types
// for the analytics-critical fields, none of which accept '' as a
// valid value (numeric/date/time reject it outright; market/direction
// reject it via a CHECK constraint). '' is therefore mapped to `null`
// for every typed column — always a safe, nullable target — rather
// than letting an unset field break the push for a reason having
// nothing to do with sync correctness.

const emptyToNull = (v: string): string | null => (v === '' ? null : v);

const toNumberOrNull = (v: string): number | null => {
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toIntOrNull = (v: string): number | null => {
  if (v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

const yesNoToBoolOrNull = (v: string): boolean | null => {
  if (v === 'Yes') return true;
  if (v === 'No') return false;
  return null;
};

const nullToEmptyString = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

const boolToYesNo = (v: unknown): string => (v === true ? 'Yes' : v === false ? 'No' : '');

/** Postgres `time` columns commonly round-trip as "HH:MM:SS" — the app's own fields use "HH:MM". Cosmetic only (not sync-critical, same category as the computed columns), normalized for consistency. */
const normalizeTimeString = (v: unknown): string => {
  const s = nullToEmptyString(v);
  return /^\d{2}:\d{2}:\d{2}$/.test(s) ? s.slice(0, 5) : s;
};

// ─── Trades ───────────────────────────────────────────────────────────

const EXTRA = 'extra' as const;
const EXTRA_JSON = 'extra_json' as const;

const OPTIONAL_EXTRA_FIELDS: ReadonlySet<string> = new Set([
  'sourceInstrument', 'sourcePlatform', 'sourceAccountId',
]);

/**
 * Every `RawTradeContent` field's destination: either a dedicated
 * `trades` column name, or the sentinel `EXTRA` for the long-tail
 * fields stored in the `extra` jsonb bucket. `satisfies Record<keyof
 * RawTradeContent, string>` (no `Partial`) makes this a COMPILE-TIME
 * completeness guard — if a field is ever added to or removed from
 * `RawTradeContent` (types/trade.ts) without updating this map,
 * `tsc` fails here rather than silently dropping that field on the
 * next push/pull.
 */
const TRADE_FIELD_MAP = {
  _tid:           'tid',
  market:         'market',
  symbol:         'symbol',
  date:           'date',
  broker:         'broker',
  account:        'account',
  accountId:      'account_id',
  dailySetup:     'daily_setup',
  liquidity:      'liquidity',
  entrySetup:     'entry_setup',
  intraDaySetup:  'intraday_setup',
  intraDayTF:     'intraday_tf',
  session:        'session',
  daySwing:       'day_swing',
  linkToChart:    'link_to_chart',
  positionSize:   'position_size',
  direction:      'direction',
  entryTime:      'entry_time',
  exitTime:       'exit_time',
  entryPrice:     'entry_price',
  stopLoss:       'stop_loss',
  target:         'target',
  exitPrice:      'exit_price',
  commission:     'commission',
  setupType:      'setup_type',
  personalRating: 'personal_rating',
  planFollowed:   'plan_followed',
  emotions:       'emotions',
  error:          'error',
  notes:          'notes',
  beSL: EXTRA, afSL: EXTRA, sl1: EXTRA, sl2: EXTRA, sl3: EXTRA,
  tm1: EXTRA, tm2: EXTRA, tm3: EXTRA, tm4: EXTRA, tm5: EXTRA, tm6: EXTRA,
  legs: EXTRA_JSON,
  sourceInstrument: EXTRA,
  sourcePlatform: EXTRA,
  sourceAccountId: EXTRA,
} as const satisfies Record<keyof RawTradeContent, string>;

/** Fields needing string->numeric coercion (the rest, aside from the special cases below, pass through as plain text — valid for a `text` column even when empty). */
const TRADE_NUMERIC_FIELDS: ReadonlySet<string> = new Set([
  'entryPrice', 'exitPrice', 'stopLoss', 'target', 'positionSize', 'commission',
]);

/** Fields whose target column is nullable-but-typed (date/time, or CHECK-constrained text) — '' must become `null`, not be sent as literal empty text. */
const TRADE_NULLABLE_TYPED_FIELDS: ReadonlySet<string> = new Set([
  'market', 'direction', 'date', 'entryTime', 'exitTime',
]);

/**
 * Local `content` (RawTradeContent-shaped, all-strings) -> a DB-ready
 * row for the `trades` table (minus `user_id`/`deleted_at`/`id` — the
 * transport injects those, since they're identity/tombstone concerns,
 * not business content).
 */
export function tradeContentToRow(content: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};

  for (const [field, column] of Object.entries(TRADE_FIELD_MAP)) {
    if (column === EXTRA_JSON) {
      if (Object.prototype.hasOwnProperty.call(content, field)) {
        extra[field] = JSON.stringify(content[field]);
      }
      continue;
    }
    if (column === EXTRA) {
      if (OPTIONAL_EXTRA_FIELDS.has(field) && !Object.prototype.hasOwnProperty.call(content, field)) continue;
      extra[field] = String(content[field] ?? '');
      continue;
    }
    if (field === '_tid') {
      // Math.trunc: services/importService.ts's convertRow() assigns
      // `_tid = Date.now() + Math.random()` for imported trades (a
      // pre-existing, preserved-verbatim quirk — see MIGRATION_NOTES.md)
      // producing a non-integer value; the DB column is `bigint`,
      // which cannot store a fraction. Truncation is stable/idempotent
      // per trade (the same trade always truncates to the same value),
      // so it never affects upsert correctness — `_tid`/`tid` are only
      // ever used as the natural-key match target, never for content
      // identity (that's `syncId`, per record.ts).
      row[column] = Math.trunc(Number(content[field] ?? 0));
      continue;
    }
    const value = String(content[field] ?? '');
    if (TRADE_NULLABLE_TYPED_FIELDS.has(field)) {
      row[column] = emptyToNull(value);
    } else if (TRADE_NUMERIC_FIELDS.has(field)) {
      row[column] = toNumberOrNull(value);
    } else if (field === 'personalRating') {
      row[column] = toIntOrNull(value);
    } else if (field === 'planFollowed') {
      row[column] = yesNoToBoolOrNull(value);
    } else {
      row[column] = value;
    }
  }

  row.extra = extra;
  return row;
}

/** DB `trades` row -> local `content` (RawTradeContent-shaped). Inverse of `tradeContentToRow`. */
export function tradeRowToContent(row: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const extra = (row.extra && typeof row.extra === 'object' ? row.extra : {}) as Record<string, unknown>;

  for (const [field, column] of Object.entries(TRADE_FIELD_MAP)) {
    if (column === EXTRA_JSON) {
      if (Object.prototype.hasOwnProperty.call(extra, field) && typeof extra[field] === 'string') {
        try {
          content[field] = JSON.parse(extra[field]);
        } catch {
          // Malformed JSON is omitted so it cannot corrupt the local content shape.
        }
      }
      continue;
    }
    if (column === EXTRA) {
      if (OPTIONAL_EXTRA_FIELDS.has(field) && !Object.prototype.hasOwnProperty.call(extra, field)) continue;
      content[field] = nullToEmptyString(extra[field]);
      continue;
    }
    if (field === '_tid') {
      content[field] = Number(row[column] ?? 0);
      continue;
    }
    const value = row[column];
    if (field === 'planFollowed') {
      content[field] = boolToYesNo(value);
    } else if (field === 'entryTime' || field === 'exitTime') {
      content[field] = normalizeTimeString(value);
    } else {
      content[field] = nullToEmptyString(value);
    }
  }

  return content;
}

/** The `trades` table's natural-key column (§10 — `(user_id, tid)`), for the transport's upsert `onConflict` target. */
export const TRADE_NATURAL_KEY_COLUMNS = ['user_id', 'tid'] as const;

// ─── Accounts ─────────────────────────────────────────────────────────

/**
 * `content.id` (business identifier, AccountContent) -> `local_id`
 * (DB column). Never `id` — the DB `id` column is the cloud primary
 * key (syncId), populated separately by the transport only on insert
 * (§3.2, record.ts's "Record identity" note).
 */
export function accountContentToRow(content: Record<string, unknown>): Record<string, unknown> {
  return {
    local_id: String(content.id ?? ''),
    name:     String(content.name ?? ''),
    capital:  Number(content.capital ?? 0),
    color:    String(content.color ?? ''),
  };
}

/** DB `accounts` row -> local `content` (AccountContent-shaped). */
export function accountRowToContent(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id:      nullToEmptyString(row.local_id),
    name:    nullToEmptyString(row.name),
    capital: typeof row.capital === 'number' ? row.capital : Number(row.capital ?? 0),
    color:   nullToEmptyString(row.color),
  };
}

/** The `accounts` table's natural-key column (§10 — `(user_id, local_id)`). */
export const ACCOUNT_NATURAL_KEY_COLUMNS = ['user_id', 'local_id'] as const;

// ─── Lists / Settings (singletons) ────────────────────────────────────
// Both tables are a single `data jsonb` column (§4) — content is
// already the whole business object, so no field-by-field mapping is
// needed, only the wrap/unwrap. Both are keyed by `user_id` alone
// (§9.1 — singleton per user); there is no separate natural key.

export function singletonContentToRow(content: Record<string, unknown>): Record<string, unknown> {
  return { data: content };
}

export function singletonRowToContent(row: Record<string, unknown>): Record<string, unknown> {
  return (row.data && typeof row.data === 'object' ? row.data : {}) as Record<string, unknown>;
}

export const SINGLETON_NATURAL_KEY_COLUMNS = ['user_id'] as const;
