-- Smart money: what the most profitable wallets of the last 30 days are buying now.
-- Apply after 013-insider-analysis.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: the wallets page now lists tokens rather than wallets. The tracked wallets come from
-- Birdeye's 30-day profit leaderboard, filtered to wallets whose profit is real and realized, and
-- are refreshed daily. Each pipeline run records which tokens they are net buying.

CREATE TABLE IF NOT EXISTS nodex.smart_money_wallets (
    wallet String,
    chain LowCardinality(String),
    rank UInt16,
    pnl_30d Float64,
    realized_pnl_30d Float64,
    volume_30d Float64,
    trades_30d UInt32,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, wallet);

-- One row per token per pipeline run. Readers use the latest snapshot_at.
CREATE TABLE IF NOT EXISTS nodex.smart_money_buys (
    snapshot_at DateTime,
    chain LowCardinality(String),
    contract String,
    symbol String,
    name String,
    image_url String DEFAULT '',
    wallet_count UInt16,
    buy_usd Float64,
    sell_usd Float64,
    net_buy_usd Float64,
    buy_count UInt32,
    wallets Array(String),
    wallet_net_buy_usd Array(Float64),
    wallet_last_buy_at Array(DateTime),
    first_buy_at DateTime,
    last_buy_at DateTime,
    price Float64 DEFAULT 0,
    market_cap Float64 DEFAULT 0,
    liquidity Float64 DEFAULT 0,
    volume_24h Float64 DEFAULT 0,
    price_change_24h Float32 DEFAULT 0
) ENGINE = MergeTree
ORDER BY (chain, snapshot_at, contract)
TTL snapshot_at + INTERVAL 7 DAY DELETE;
