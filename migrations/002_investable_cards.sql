-- Migration 002: Investable + Cards tabs.
-- Safe to run on your existing project: it never deletes or rewrites your months.
-- Safe to run more than once.
-- Supabase → SQL Editor → New query → paste this whole file → Run.

-- 1. Income becomes optional (savings is still computed from balances;
--    expense and savings rate need income, so they show "n/a" without it).
alter table public.months alter column income drop not null;

-- 2. One settings row per user: emergency fund + card limits.
create table if not exists public.settings (
  user_id              uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  emergency_mode       text not null default 'auto' check (emergency_mode in ('auto', 'fixed')),
  emergency_multiplier numeric(4,1) not null default 3 check (emergency_multiplier > 0 and emergency_multiplier <= 24),
  emergency_fixed      numeric(12,2) check (emergency_fixed >= 0),
  reserve_cards        boolean not null default false,  -- also set aside card balances before "investable"
  card_limits          jsonb not null default '{}'::jsonb, -- {"Amex": 10000, "RBC Avion": 5000}
  updated_at           timestamptz not null default now()
);

alter table public.settings enable row level security;
drop policy if exists "Own settings only" on public.settings;
create policy "Own settings only" on public.settings
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Backfill: give every existing user a default settings row (3x expense, no limits).
insert into public.settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- 3. Earmarked buckets (labels on your cash, not separate accounts).
create table if not exists public.buckets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  target     numeric(12,2) not null check (target >= 0),
  deadline   text check (deadline ~ '^\d{4}-(0[1-9]|1[0-2])$'),  -- optional, e.g. 2026-10
  created_at timestamptz not null default now()
);

alter table public.buckets enable row level security;
drop policy if exists "Own buckets only" on public.buckets;
create policy "Own buckets only" on public.buckets
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
