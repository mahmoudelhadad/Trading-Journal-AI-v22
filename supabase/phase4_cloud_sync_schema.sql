-- ============================================================
-- Phase 4 — Cloud Database schema (Trades, Accounts, Lists,
-- Settings, sync_meta), per the approved hybrid relational/JSONB
-- design and the follow-up schema refinements.
--
-- Paste this entire file into the Supabase SQL Editor and run it
-- once against your project. Safe to re-run (every statement uses
-- IF NOT EXISTS / OR REPLACE / DROP POLICY IF EXISTS guards).
-- ============================================================

create extension if not exists pgcrypto;

-- ─── trades ──────────────────────────────────────────────────
-- Hybrid schema: typed columns for every currently-known RawTrade
-- field (analytics-critical + descriptive), plus a small `extra`
-- jsonb bucket for the long-tail legacy fields (beSL/afSL/sl1-3/
-- tm1-6). Computed fields (r_multiple, pl, ...) are order-
-- independent only — `_capital`/`_rPct` are deliberately NOT
-- persisted here (see Phase 3 plan) since they depend on the full
-- ordered trade history of an account and would need invalidation
-- on every insert/edit/delete elsewhere in that account.
create table if not exists public.trades (
  -- identity ------------------------------------------------------
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  tid             bigint not null,
  account_id      text not null,          -- weak reference, no FK (see note below)

  -- core analytics fields -------------------------------------------
  date            date,
  symbol          text,
  market          text check (market in ('forex','futures')),
  direction       text check (direction in ('Long','Short')),
  entry_price     numeric,
  exit_price      numeric,
  stop_loss       numeric,
  target          numeric,
  position_size   numeric,
  commission      numeric,
  session         text,
  entry_setup     text,
  setup_type      text,
  personal_rating smallint,
  plan_followed   boolean,

  -- descriptive/secondary fields --------------------------------------
  broker          text,
  account         text,
  daily_setup     text,
  liquidity       text,
  intraday_setup  text,
  intraday_tf     text,
  day_swing       text,
  emotions        text,
  entry_time      time,
  exit_time       time,
  link_to_chart   text,
  notes           text,
  error           text,

  -- computed, order-independent analytics fields (client-computed
  -- via the frozen calculations/tradeCalc.ts, persisted for
  -- server-side querying) ----------------------------------------
  r_multiple      numeric,
  planned_r       numeric,
  pl              numeric,
  net_pl          numeric,
  risk_value      numeric,
  points          numeric,
  outcome         text,
  duration_mins   integer,
  is_futures      boolean,

  -- escape hatch for long-tail legacy fields + future additions ---
  extra           jsonb not null default '{}',

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (user_id, tid)
);

-- account_id is deliberately plain text, not a foreign key to
-- accounts(id): locally, deleting an account never cascades to its
-- trades (useAccounts.ts's deleteAccount only filters the accounts
-- array). A hard FK with cascade would introduce delete behavior
-- that doesn't exist in the app today.

create index if not exists trades_user_id_idx      on public.trades (user_id);
create index if not exists trades_user_date_idx    on public.trades (user_id, date);
create index if not exists trades_user_symbol_idx  on public.trades (user_id, symbol);
create index if not exists trades_user_account_idx on public.trades (user_id, account_id);

-- ─── accounts ────────────────────────────────────────────────
create table if not exists public.accounts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  local_id    text not null,
  name        text not null,
  capital     numeric not null,
  color       text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, local_id)
);

create index if not exists accounts_user_id_idx on public.accounts (user_id);

-- ─── lists ───────────────────────────────────────────────────
-- Singleton per user. Genuinely flexible/config data (dropdown
-- option lists) — correctly JSONB, not a design compromise.
create table if not exists public.lists (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ─── settings ────────────────────────────────────────────────
-- Singleton per user. Same reasoning as lists.
create table if not exists public.settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ─── sync_meta ───────────────────────────────────────────────
-- Explicit state machine (migration-robustness fix, post-Phase-4
-- review) making the one-time LocalStorage -> cloud migration
-- resumable and race-safe, instead of inferring "already migrated?"
-- from whether the other tables happen to be non-empty (that was the
-- original bug: a partially-uploaded migration looked identical to
-- "a different device already finished", so a retry abandoned the
-- rest of the upload).
--
--   decision: 'claimed' -> 'upload' | 'adopt_cloud' | 'empty'
--     Set exactly once via an atomic first-INSERT-wins claim, and (if
--     'claimed') finalized via a compare-and-swap UPDATE — see
--     services/cloudSync.ts's claimOrReadDecision()/finalizeDecision().
--   accounts_synced_at / trades_synced_at / lists_synced_at /
--   settings_synced_at: per-category resolution timestamps, so a
--     retried/interrupted upload resumes exactly what's missing
--     instead of re-deciding the whole migration from scratch.
--   migrated_at: only ever set once every applicable category above
--     is resolved — never inferred from cloud table contents.
--
-- Uses CREATE TABLE IF NOT EXISTS for a fresh install, plus explicit
-- ALTER TABLE statements so this file is ALSO safe to re-run against
-- a database that already has the older sync_meta shape (migrated_at
-- / migration_source only) from an earlier run of this same file.
create table if not exists public.sync_meta (
  user_id uuid primary key references auth.users(id) on delete cascade
);

alter table public.sync_meta add column if not exists decision            text;
alter table public.sync_meta add column if not exists accounts_synced_at  timestamptz;
alter table public.sync_meta add column if not exists trades_synced_at    timestamptz;
alter table public.sync_meta add column if not exists lists_synced_at     timestamptz;
alter table public.sync_meta add column if not exists settings_synced_at  timestamptz;
alter table public.sync_meta add column if not exists migrated_at         timestamptz;
alter table public.sync_meta add column if not exists last_synced_at      timestamptz;
alter table public.sync_meta add column if not exists updated_at          timestamptz not null default now();

-- Superseded by `decision` (which already distinguishes 'uploaded' vs
-- 'cloud_preexisting' vs 'empty' via 'upload'/'adopt_cloud'/'empty') —
-- drop if present from an earlier run of this file.
alter table public.sync_meta drop column if exists migration_source;

-- (Re)apply the decision domain constraint idempotently.
alter table public.sync_meta drop constraint if exists sync_meta_decision_check;
alter table public.sync_meta add constraint sync_meta_decision_check
  check (decision in ('claimed','upload','adopt_cloud','empty'));

-- ─── updated_at auto-touch trigger ──────────────────────────
-- Standard Postgres/Supabase pattern. Without this, updated_at
-- correctness depends on every future write path remembering to
-- set it manually.
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trades_set_updated_at on public.trades;
create trigger trades_set_updated_at
  before update on public.trades
  for each row execute function public.set_updated_at();

drop trigger if exists accounts_set_updated_at on public.accounts;
create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function public.set_updated_at();

drop trigger if exists lists_set_updated_at on public.lists;
create trigger lists_set_updated_at
  before update on public.lists
  for each row execute function public.set_updated_at();

drop trigger if exists settings_set_updated_at on public.settings;
create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

drop trigger if exists sync_meta_set_updated_at on public.sync_meta;
create trigger sync_meta_set_updated_at
  before update on public.sync_meta
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security — every authenticated user may only access
-- rows where user_id = auth.uid(). This is the ONLY real access
-- boundary once real data is behind it (the Supabase anon key is
-- already public, shipped client-side since Phase 2).
-- ============================================================

alter table public.trades    enable row level security;
alter table public.accounts  enable row level security;
alter table public.lists     enable row level security;
alter table public.settings  enable row level security;
alter table public.sync_meta enable row level security;

-- trades
drop policy if exists "select own trades" on public.trades;
create policy "select own trades" on public.trades
  for select using (auth.uid() = user_id);

drop policy if exists "insert own trades" on public.trades;
create policy "insert own trades" on public.trades
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own trades" on public.trades;
create policy "update own trades" on public.trades
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own trades" on public.trades;
create policy "delete own trades" on public.trades
  for delete using (auth.uid() = user_id);

-- accounts
drop policy if exists "select own accounts" on public.accounts;
create policy "select own accounts" on public.accounts
  for select using (auth.uid() = user_id);

drop policy if exists "insert own accounts" on public.accounts;
create policy "insert own accounts" on public.accounts
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own accounts" on public.accounts;
create policy "update own accounts" on public.accounts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own accounts" on public.accounts;
create policy "delete own accounts" on public.accounts
  for delete using (auth.uid() = user_id);

-- lists
drop policy if exists "select own lists" on public.lists;
create policy "select own lists" on public.lists
  for select using (auth.uid() = user_id);

drop policy if exists "insert own lists" on public.lists;
create policy "insert own lists" on public.lists
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own lists" on public.lists;
create policy "update own lists" on public.lists
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own lists" on public.lists;
create policy "delete own lists" on public.lists
  for delete using (auth.uid() = user_id);

-- settings
drop policy if exists "select own settings" on public.settings;
create policy "select own settings" on public.settings
  for select using (auth.uid() = user_id);

drop policy if exists "insert own settings" on public.settings;
create policy "insert own settings" on public.settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own settings" on public.settings;
create policy "update own settings" on public.settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own settings" on public.settings;
create policy "delete own settings" on public.settings
  for delete using (auth.uid() = user_id);

-- sync_meta
drop policy if exists "select own sync_meta" on public.sync_meta;
create policy "select own sync_meta" on public.sync_meta
  for select using (auth.uid() = user_id);

drop policy if exists "insert own sync_meta" on public.sync_meta;
create policy "insert own sync_meta" on public.sync_meta
  for insert with check (auth.uid() = user_id);

drop policy if exists "update own sync_meta" on public.sync_meta;
create policy "update own sync_meta" on public.sync_meta
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "delete own sync_meta" on public.sync_meta;
create policy "delete own sync_meta" on public.sync_meta
  for delete using (auth.uid() = user_id);
