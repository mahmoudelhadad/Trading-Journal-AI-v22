-- ============================================================
-- Sync Architecture — server schema additions.
-- Ref: SYNC_ARCHITECTURE_SPEC.md §4 (Server Data Model Additions),
--      §13 Step 1.
--
-- Purely additive: no existing column, table, RLS policy, or
-- constraint from phase4_cloud_sync_schema.sql is removed, renamed,
-- or narrowed. This file is intentionally separate from and does not
-- modify phase4_cloud_sync_schema.sql. Nothing in the application
-- reads or writes the columns/indexes added here yet — they exist
-- ahead of the code that will use them (§13 Step 1: "purely
-- additive; nothing reads or writes these columns yet").
--
-- Safe to re-run: every statement is guarded (IF NOT EXISTS, or the
-- drop-then-add pattern already used elsewhere in this repo for
-- constraints that lack native IF NOT EXISTS support).
-- ============================================================

-- ─── trades: tombstone column ───────────────────────────────
-- §4: nullable timestamp; §9 governs its lifecycle. RLS deliberately
-- does not filter on this column (§4) — that remains an
-- application-query concern.
alter table public.trades
  add column if not exists deleted_at timestamptz;

-- ─── accounts: tombstone column ─────────────────────────────
alter table public.accounts
  add column if not exists deleted_at timestamptz;

-- ─── lists / settings: `id` column ──────────────────────────
-- §3.2 requires every record — collection row or singleton — to
-- carry a client-generated `id` that serves as the tie-breaker half
-- of the compound cursor (§7.2, INV-5). `trades` and `accounts`
-- already have this as their primary key; `lists` and `settings`
-- are keyed on `user_id` alone (correct — they are singleton-per-
-- user rows) and therefore have no `id` column yet. Adding it here
-- is required for the §4 `(user_id, updated_at, id)` index on these
-- two tables to be meaningful, and is additive: `user_id` remains
-- the primary key, unchanged.
--
-- Added nullable first so existing rows are not rejected, backfilled
-- for any pre-existing row, then tightened to NOT NULL + DEFAULT +
-- UNIQUE — safe to re-run since the backfill only touches NULLs and
-- the constraint/default statements are idempotent on their own.
alter table public.lists
  add column if not exists id uuid;

update public.lists set id = gen_random_uuid() where id is null;

alter table public.lists
  alter column id set default gen_random_uuid();

alter table public.lists
  alter column id set not null;

alter table public.lists
  drop constraint if exists lists_id_key;

alter table public.lists
  add constraint lists_id_key unique (id);

alter table public.settings
  add column if not exists id uuid;

update public.settings set id = gen_random_uuid() where id is null;

alter table public.settings
  alter column id set default gen_random_uuid();

alter table public.settings
  alter column id set not null;

alter table public.settings
  drop constraint if exists settings_id_key;

alter table public.settings
  add constraint settings_id_key unique (id);

-- ─── compound-cursor indexes ─────────────────────────────────
-- §4, §7.2: required for keyset pagination — ORDER BY (updated_at,
-- id) with WHERE (updated_at, id) > (:cursorUpdatedAt, :cursorId),
-- evaluated as a row/tuple comparison.
create index if not exists trades_user_updated_id_idx
  on public.trades (user_id, updated_at, id);

create index if not exists accounts_user_updated_id_idx
  on public.accounts (user_id, updated_at, id);

create index if not exists lists_user_updated_id_idx
  on public.lists (user_id, updated_at, id);

create index if not exists settings_user_updated_id_idx
  on public.settings (user_id, updated_at, id);

-- ─── RLS — deliberately untouched ────────────────────────────
-- No policy changes in this file. auth.uid() = user_id remains the
-- only access boundary on all four tables, and (per §4) it does not
-- and must not filter on deleted_at — tombstone visibility is an
-- application-query concern, not a row-security concern.
