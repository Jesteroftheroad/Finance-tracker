-- Finance Tracker: the one table.
-- Paste this whole file into Supabase → SQL Editor → New query → Run.

create table if not exists public.months (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month        text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- e.g. 2026-09
  income       numeric(12,2) not null check (income >= 0),
  cards        jsonb not null default '[]'::jsonb,   -- [{"name":"Amex","balance":1234.56}, ...]
  banks        jsonb not null default '[]'::jsonb,   -- [{"name":"EQ","balance":5000}, ...]
  wealthsimple numeric(12,2) not null default 0 check (wealthsimple >= 0),
  updated_at   timestamptz not null default now(),
  unique (user_id, month)
);

-- Row Level Security: each signed-in user can only ever see / change their own rows.
alter table public.months enable row level security;

drop policy if exists "Own rows only" on public.months;
create policy "Own rows only" on public.months
  for all
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
