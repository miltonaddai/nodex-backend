-- Solana launch intelligence and smart-money scoring.
-- Apply after 004-wallet-tokens-held.sql.

ALTER TABLE nodex.wallet_analytics
    ADD COLUMN IF NOT EXISTS smart_score Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS young_token_trades UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS young_token_wins UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS median_roi_pct Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_entry_delay_minutes Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS realized_profit Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unrealized_profit Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concentration_pct Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS risk_flags Array(String) DEFAULT [];

ALTER TABLE nodex.token_analytics
    ADD COLUMN IF NOT EXISTS launched_at DateTime DEFAULT toDateTime(0),
    ADD COLUMN IF NOT EXISTS age_days UInt16 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS alpha_score Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS smart_wallet_buyers UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS smart_money_net_flow Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS buy_acceleration Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS risk_flags Array(String) DEFAULT [];

CREATE TABLE IF NOT EXISTS nodex.token_launches (
    contract String,
    chain LowCardinality(String),
    name String,
    symbol String,
    launched_at DateTime,
    price Float64,
    market_cap Float64,
    volume_24h Float64,
    liquidity Float64,
    holders UInt32,
    price_change_24h Float32,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, contract);

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
    ingested_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (chain, contract, signature, event_index)
TTL block_time + INTERVAL 90 DAY DELETE;

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
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, period_days, wallet_address, contract);

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
