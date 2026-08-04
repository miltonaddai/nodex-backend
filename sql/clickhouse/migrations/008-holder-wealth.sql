-- Holder wealth signal for alpha scoring.
-- Apply after 007-alpha-v2.sql.
--
-- Context: manual review found that tokens surfaced by v2 were bundles — ~15 buyers against
-- multi-million market caps. Two guardrails follow from that: a hard minimum on real buyers,
-- and evidence that the largest holders are substantial wallets rather than throwaways.
--
-- Birdeye returns wallet net worth as 0 on the free plan (confirmed: 0 of 5,025 rows populated),
-- so wealth is enriched from Helius balances instead and cached here with a TTL.

CREATE TABLE IF NOT EXISTS nodex.wallet_wealth (
    wallet_address String,
    chain LowCardinality(String),
    net_worth_usd Float64 DEFAULT 0,
    tokens_held UInt32 DEFAULT 0,
    checked_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(checked_at)
ORDER BY (chain, wallet_address);

ALTER TABLE nodex.token_analytics
    -- Top holders that clear the wealth threshold, and the median wealth of those sampled.
    ADD COLUMN IF NOT EXISTS wealthy_holders UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS median_holder_wealth_usd Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS enriched_holders UInt32 DEFAULT 0;
