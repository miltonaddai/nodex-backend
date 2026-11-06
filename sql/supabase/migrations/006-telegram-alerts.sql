-- Migration: Telegram alerts. Users link a Telegram chat to their account; after each data run the
-- worker sends their alerts (early signals and their own alerts) there.
-- Run this in the Supabase SQL editor for existing projects (after 005-alerts.sql).
-- Fresh installs get these from ../schema.sql.

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

-- Send this alert to Telegram (when a chat is linked).
alter table public.alerts add column if not exists telegram boolean not null default true;

-- Only the backend (service role) reads and writes these; users never query them directly.
alter table public.telegram_links enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.alert_deliveries enable row level security;

drop policy if exists "Users can view own telegram link" on public.telegram_links;
create policy "Users can view own telegram link"
  on public.telegram_links for select
  using (auth.uid() = user_id);
