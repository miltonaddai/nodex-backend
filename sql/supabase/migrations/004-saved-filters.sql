-- Migration: saved custom filters for the Smart Wallets table, kept per account.
-- Run this in the Supabase SQL editor for existing projects.
-- Fresh installs get this table from ../schema.sql.

create table if not exists public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 32),
  -- [{ "field": "marketCap", "op": "lte", "value": 1000000 }, ...]; validated by the backend.
  rules jsonb not null,
  created_at timestamptz not null default now()
);

-- One filter per name per user; saving under an existing name replaces it.
create unique index if not exists saved_filters_user_name_idx
  on public.saved_filters (user_id, lower(name));

alter table public.saved_filters enable row level security;

drop policy if exists "Users can view own saved filters" on public.saved_filters;
create policy "Users can view own saved filters"
  on public.saved_filters for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own saved filters" on public.saved_filters;
create policy "Users can insert own saved filters"
  on public.saved_filters for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own saved filters" on public.saved_filters;
create policy "Users can delete own saved filters"
  on public.saved_filters for delete
  using (auth.uid() = user_id);
