-- Migration: token watchlist (user-tracked tokens from the tokens table)
-- Run this in the Supabase SQL editor for existing projects.
-- Fresh installs get this table from ../schema.sql.

create table if not exists public.watchlist_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contract text not null,
  name text not null,
  symbol text not null,
  chain text not null default 'solana' check (chain in ('solana', 'robinhood')),
  created_at timestamptz not null default now(),
  unique (user_id, contract, chain)
);

create index if not exists watchlist_tokens_user_chain_idx
  on public.watchlist_tokens (user_id, chain);

alter table public.watchlist_tokens enable row level security;

drop policy if exists "Users can view own token watchlist" on public.watchlist_tokens;
create policy "Users can view own token watchlist"
  on public.watchlist_tokens for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own token watchlist" on public.watchlist_tokens;
create policy "Users can insert own token watchlist"
  on public.watchlist_tokens for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own token watchlist" on public.watchlist_tokens;
create policy "Users can delete own token watchlist"
  on public.watchlist_tokens for delete
  using (auth.uid() = user_id);
