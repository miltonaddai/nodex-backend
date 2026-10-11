-- Migration: allow BNB Chain ('bsc') wherever a chain is stored.
-- Run this in the Supabase SQL editor for existing projects.
-- Fresh installs get these constraints from ../schema.sql.

alter table public.profiles drop constraint if exists profiles_default_chain_check;
alter table public.profiles
  add constraint profiles_default_chain_check check (default_chain in ('solana', 'robinhood', 'bsc'));

alter table public.watchlist_wallets drop constraint if exists watchlist_wallets_chain_check;
alter table public.watchlist_wallets
  add constraint watchlist_wallets_chain_check check (chain in ('solana', 'robinhood', 'bsc'));

alter table public.watchlist_tokens drop constraint if exists watchlist_tokens_chain_check;
alter table public.watchlist_tokens
  add constraint watchlist_tokens_chain_check check (chain in ('solana', 'robinhood', 'bsc'));
