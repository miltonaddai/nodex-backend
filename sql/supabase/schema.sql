-- Supabase (PostgreSQL) schema for NodeX user data
-- Final schema: includes every change in migrations/.
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query)
--
-- Safe to run on a fresh or an existing project, and safe to rerun: every statement is
-- create-if-missing, add-if-missing, or drop-and-recreate.

-- ---------------------------------------------------------------------------
-- Profiles (one row per auth user)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  default_chain text not null default 'solana' check (default_chain in ('solana', 'robinhood', 'bsc')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles (id) on delete cascade,
  plan text not null default 'starter' check (plan in ('starter', 'pro')),
  status text not null default 'canceled' check (status in ('active', 'canceled', 'past_due', 'trialing')),
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Projects created before Stripe support lack these columns.
alter table public.subscriptions
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

create unique index if not exists subscriptions_stripe_customer_id_idx
  on public.subscriptions (stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists subscriptions_stripe_subscription_id_idx
  on public.subscriptions (stripe_subscription_id)
  where stripe_subscription_id is not null;

-- ---------------------------------------------------------------------------
-- Watchlist wallets (user-tracked addresses)
-- ---------------------------------------------------------------------------
create table if not exists public.watchlist_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  address text not null,
  chain text not null default 'solana' check (chain in ('solana', 'robinhood', 'bsc')),
  created_at timestamptz not null default now(),
  unique (user_id, address, chain)
);

create index if not exists watchlist_wallets_user_chain_idx
  on public.watchlist_wallets (user_id, chain);

-- ---------------------------------------------------------------------------
-- Watchlist tokens (user-tracked tokens from the tokens table)
-- ---------------------------------------------------------------------------
create table if not exists public.watchlist_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  contract text not null,
  name text not null,
  symbol text not null,
  chain text not null default 'solana' check (chain in ('solana', 'robinhood', 'bsc')),
  created_at timestamptz not null default now(),
  unique (user_id, contract, chain)
);

create index if not exists watchlist_tokens_user_chain_idx
  on public.watchlist_tokens (user_id, chain);

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Auto-create profile + starter subscription when a user signs up
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  insert into public.subscriptions (user_id, plan, status)
  values (new.id, 'starter', 'canceled')
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Saved custom filters (Smart Wallets table)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Alerts (background watches on the Smart Wallets data)
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  -- [{ "field": "marketCap", "op": "lte", "value": 1000000 }, ...]; validated by the backend.
  rules jsonb not null,
  chains text[] not null default '{solana,robinhood,bsc}',
  enabled boolean not null default true,
  -- Send this alert to Telegram (when a chat is linked).
  telegram boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists alerts_user_idx on public.alerts (user_id);

-- ---------------------------------------------------------------------------
-- Telegram alerts
-- ---------------------------------------------------------------------------
-- A user's linked Telegram chat. One per user.
create table if not exists public.telegram_links (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  chat_id bigint not null unique,
  username text,
  -- Send the built-in early-signal alert to Telegram.
  early_signals boolean not null default true,
  linked_at timestamptz not null default now()
);

-- Single-use codes behind the "Connect Telegram" link. They expire after a few minutes.
create table if not exists public.telegram_link_codes (
  code text primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null
);

-- Which tokens each alert has already announced, so each is sent once. contract '*' marks an
-- alert and chain as started: its first run records what already matches without sending it.
create table if not exists public.alert_deliveries (
  user_id uuid not null references public.profiles (id) on delete cascade,
  alert_key text not null, -- 'early' or the alert's id
  chain text not null,
  contract text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, alert_key, chain, contract)
);

alter table public.profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.watchlist_wallets enable row level security;
alter table public.watchlist_tokens enable row level security;
alter table public.saved_filters enable row level security;
alter table public.alerts enable row level security;
alter table public.telegram_links enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.alert_deliveries enable row level security;

drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

drop policy if exists "Users can view own subscription" on public.subscriptions;
create policy "Users can view own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can view own watchlist" on public.watchlist_wallets;
create policy "Users can view own watchlist"
  on public.watchlist_wallets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own watchlist" on public.watchlist_wallets;
create policy "Users can insert own watchlist"
  on public.watchlist_wallets for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own watchlist" on public.watchlist_wallets;
create policy "Users can delete own watchlist"
  on public.watchlist_wallets for delete
  using (auth.uid() = user_id);

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

drop policy if exists "Users can view own telegram link" on public.telegram_links;
create policy "Users can view own telegram link"
  on public.telegram_links for select
  using (auth.uid() = user_id);

-- Service role (backend) bypasses RLS. Authenticated users read their own rows via policies above.
