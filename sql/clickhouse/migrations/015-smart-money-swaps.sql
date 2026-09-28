-- Stored swaps for tracked smart money wallets, and buyer profit per token.
-- Apply after 014-smart-money-buys.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: the buy window grew to 72 hours and the tracked set to 200 wallets. Re-downloading
-- three days of swaps for every wallet on every run would cost several Birdeye pages per active
-- wallet. Swaps are stored here instead, so each run fetches only what is new since the last.

CREATE TABLE IF NOT EXISTS nodex.smart_money_swaps (
    chain LowCardinality(String),
    wallet String,
    tx_hash String,
    ins_index UInt16 DEFAULT 0,
    inner_ins_index UInt16 DEFAULT 0,
    block_time DateTime,
    volume_usd Float64,
    base_address String,
    base_symbol String,
    base_change Float64,
    quote_address String,
    quote_symbol String,
    quote_change Float64,
    fetched_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(fetched_at)
ORDER BY (chain, wallet, tx_hash, ins_index, inner_ins_index)
TTL block_time + INTERVAL 4 DAY DELETE;

ALTER TABLE nodex.smart_money_buys
    -- Combined 30-day realized profit of the wallets buying this token. Breaks ties on count.
    ADD COLUMN IF NOT EXISTS buyer_realized_pnl_30d Float64 DEFAULT 0;
