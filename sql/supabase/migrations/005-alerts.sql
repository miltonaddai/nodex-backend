-- Migration: alerts. Each alert is a set of conditions on the Smart Wallets data, watched in the
-- background on the chosen chains. Separate from saved filters, which only shape the table.
-- Run this in the Supabase SQL editor for existing projects.
-- Fresh installs get this table from ../schema.sql.

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- [{ "field": "marketCap", "op": "lte", "value": 1000000 }, ...]; validated by the backend.
  rules jsonb not null,
  chains text[] not null default '{solana,robinhood,bsc}',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists alerts_user_idx on public.alerts (user_id);

alter table public.alerts enable row level security;

drop policy if exists "Users can view own alerts" on public.alerts;
create policy "Users can view own alerts"
  on public.alerts for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own alerts" on public.alerts;
create policy "Users can insert own alerts"
  on public.alerts for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own alerts" on public.alerts;
create policy "Users can update own alerts"
  on public.alerts for update
  using (auth.uid() = user_id);

drop policy if exists "Users can delete own alerts" on public.alerts;
create policy "Users can delete own alerts"
  on public.alerts for delete
  using (auth.uid() = user_id);

-- If you ran an earlier version of 004-saved-filters.sql that put alerts on saved filters, those
-- columns are no longer used and can be dropped:
-- alter table public.saved_filters drop column if exists alert, drop column if exists alert_chains;
