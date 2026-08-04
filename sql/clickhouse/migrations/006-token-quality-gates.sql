-- Live token health and established-wallet quality gates.
-- Apply after 005-alpha-intelligence.sql.

ALTER TABLE nodex.wallet_token_performance
    ADD COLUMN IF NOT EXISTS wallet_funded_at DateTime DEFAULT toDateTime(0),
    ADD COLUMN IF NOT EXISTS wallet_net_worth Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS wallet_sol_balance Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trader_tags Array(String) DEFAULT [],
    ADD COLUMN IF NOT EXISTS is_fresh_wallet UInt8 DEFAULT 0;

ALTER TABLE nodex.token_analytics
    ADD COLUMN IF NOT EXISTS qualified_wallet_buyers UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fresh_wallet_buyers UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fresh_wallet_share Float32 DEFAULT 0;

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
