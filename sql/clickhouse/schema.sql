-- ClickHouse schema for NodeX blockchain analytics
-- This baseline includes every change through migrations/012-token-images.sql.
-- Run against your ClickHouse instance (NOT Supabase -- see ../supabase/schema.sql for user data)

CREATE DATABASE IF NOT EXISTS nodex;

-- Wallet analytics aggregated by chain and time period
CREATE TABLE IF NOT EXISTS nodex.wallet_analytics (
    address String,
    chain LowCardinality(String),
    period_days UInt16,
    balance Float64,
    total_profit Float64,
    win_rate Float32,
    trades UInt32,
    volume Float64,
    tokens_held UInt32,
    last_active String,
    smart_score Float32 DEFAULT 0,
    young_token_trades UInt32 DEFAULT 0,
    young_token_wins UInt32 DEFAULT 0,
    median_roi_pct Float32 DEFAULT 0,
    avg_entry_delay_minutes Float32 DEFAULT 0,
    realized_profit Float64 DEFAULT 0,
    unrealized_profit Float64 DEFAULT 0,
    concentration_pct Float32 DEFAULT 0,
    risk_flags Array(String) DEFAULT [],
    reputation_score Float32 DEFAULT 0,
    closed_positions UInt32 DEFAULT 0,
    reputation_sample UInt32 DEFAULT 0,
    qualified_tokens UInt32 DEFAULT 0,
    qualified_wins UInt32 DEFAULT 0,
    qualified_profit_usd Float64 DEFAULT 0,
    qualified_win_rate Float32 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, period_days, address);

-- Token analytics by chain and time period
CREATE TABLE IF NOT EXISTS nodex.token_analytics (
    contract String,
    chain LowCardinality(String),
    period_days UInt16,
    name String,
    symbol String,
    image_url String DEFAULT '',
    price Float64,
    market_cap Float64,
    change_pct Float32,
    volume Float64,
    liquidity Float64,
    holders UInt32,
    launched_at DateTime DEFAULT toDateTime(0),
    age_days UInt16 DEFAULT 0,
    alpha_score Float32 DEFAULT 0,
    smart_wallet_buyers UInt32 DEFAULT 0,
    smart_money_net_flow Float64 DEFAULT 0,
    buy_acceleration Float32 DEFAULT 0,
    qualified_wallet_buyers UInt32 DEFAULT 0,
    fresh_wallet_buyers UInt32 DEFAULT 0,
    fresh_wallet_share Float32 DEFAULT 0,
    evidence_tier LowCardinality(String) DEFAULT 'unverified',
    real_buyers UInt32 DEFAULT 0,
    independent_buyers UInt32 DEFAULT 0,
    net_inflow_usd Float64 DEFAULT 0,
    retention_rate Float32 DEFAULT 0,
    demand_persistence Float32 DEFAULT 0,
    sniper_share Float32 DEFAULT 0,
    top_buyer_share Float32 DEFAULT 0,
    wash_ratio Float32 DEFAULT 0,
    safety_failed UInt8 DEFAULT 0,
    reputation_weighted_inflow Float64 DEFAULT 0,
    trade_count UInt32 DEFAULT 0,
    distinct_traders UInt32 DEFAULT 0,
    wealthy_holders UInt32 DEFAULT 0,
    median_holder_wealth_usd Float64 DEFAULT 0,
    enriched_holders UInt32 DEFAULT 0,
    backfill_complete UInt8 DEFAULT 0,
    mcap_per_buyer Float64 DEFAULT 0,
    churn Float32 DEFAULT 0,
    unique_wallet_24h UInt32 DEFAULT 0,
    buy_sell_ratio Float32 DEFAULT 0,
    churn_qualified UInt8 DEFAULT 0,
    risk_flags Array(String) DEFAULT [],
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, period_days, contract);

-- Recently listed token metadata. The latest row per mint is retained.
CREATE TABLE IF NOT EXISTS nodex.token_launches (
    contract String,
    chain LowCardinality(String),
    name String,
    symbol String,
    image_url String DEFAULT '',
    launched_at DateTime,
    price Float64,
    market_cap Float64,
    volume_24h Float64,
    liquidity Float64,
    holders UInt32,
    price_change_24h Float32,
    unique_wallet_24h UInt32 DEFAULT 0,
    trade_24h_count UInt32 DEFAULT 0,
    buy_24h UInt32 DEFAULT 0,
    sell_24h UInt32 DEFAULT 0,
    fdv Float64 DEFAULT 0,
    churn Float32 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, contract);

-- Normalized Helius swaps. Signature and event index make retries idempotent.
CREATE TABLE IF NOT EXISTS nodex.wallet_token_trades (
    chain LowCardinality(String),
    contract String,
    wallet_address String,
    signature String,
    event_index UInt16,
    side Enum8('buy' = 1, 'sell' = 2),
    token_amount Float64,
    quote_amount Float64,
    quote_symbol LowCardinality(String),
    quote_usd Float64,
    block_time DateTime,
    minutes_after_launch UInt32,
    suspicious UInt8 DEFAULT 0,
    wash_suspected UInt8 DEFAULT 0,
    ingested_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (chain, contract, signature, event_index)
TTL block_time + INTERVAL 90 DAY DELETE;

-- Per-wallet outcomes on young tokens, materialized by the worker.
CREATE TABLE IF NOT EXISTS nodex.wallet_token_performance (
    chain LowCardinality(String),
    period_days UInt16,
    wallet_address String,
    contract String,
    launched_at DateTime,
    first_buy_at DateTime,
    last_trade_at DateTime,
    entry_delay_minutes UInt32,
    buy_usd Float64,
    sell_usd Float64,
    bought_amount Float64,
    sold_amount Float64,
    remaining_amount Float64,
    realized_pnl Float64,
    unrealized_pnl Float64,
    roi_pct Float32,
    trade_count UInt32,
    suspicious_trade_count UInt32,
    wallet_funded_at DateTime DEFAULT toDateTime(0),
    wallet_net_worth Float64 DEFAULT 0,
    wallet_sol_balance Float64 DEFAULT 0,
    trader_tags Array(String) DEFAULT [],
    is_fresh_wallet UInt8 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, period_days, wallet_address, contract);

-- Current tradability and market health from Dexscreener.
CREATE TABLE IF NOT EXISTS nodex.token_market_health (
    contract String,
    chain LowCardinality(String),
    pair_address String,
    pair_url String,
    pair_count UInt16 DEFAULT 0,
    price Float64 DEFAULT 0,
    market_cap Float64 DEFAULT 0,
    fdv Float64 DEFAULT 0,
    liquidity Float64 DEFAULT 0,
    volume_24h Float64 DEFAULT 0,
    price_change_24h Float32 DEFAULT 0,
    healthy UInt8 DEFAULT 0,
    risk_flags Array(String) DEFAULT [],
    checked_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(checked_at)
ORDER BY (chain, contract);

-- Resumable cursor for bounded backfills and incremental ingestion.
CREATE TABLE IF NOT EXISTS nodex.worker_checkpoints (
    worker LowCardinality(String),
    chain LowCardinality(String),
    entity_key String,
    cursor String,
    last_block_time DateTime DEFAULT toDateTime(0),
    backfill_complete UInt8 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (worker, chain, entity_key);

-- Cached holder wealth used by alpha scoring.
CREATE TABLE IF NOT EXISTS nodex.wallet_wealth (
    wallet_address String,
    chain LowCardinality(String),
    net_worth_usd Float64 DEFAULT 0,
    tokens_held UInt32 DEFAULT 0,
    checked_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(checked_at)
ORDER BY (chain, wallet_address);

-- User watchlist (synced from Supabase or written directly)
CREATE TABLE IF NOT EXISTS nodex.user_watchlist (
    user_id String,
    wallet_address String,
    wallet_name String,
    chain LowCardinality(String),
    added_at DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY (user_id, chain, added_at);
