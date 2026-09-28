-- Launch-insider analysis for the Insider Plays page.
-- Apply after 012-token-images.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: the churn screen rejects bundled launches outright, because a bundle sits in the
-- farm band. Super Inu launched with three co-signing wallets taking 11.7% of supply in the
-- creation block, retraced to $667k and ran to $24.5M, and never appeared on the site. This
-- table holds a per-token launch analysis (who bought together, who funded whom) and a
-- per-run refresh of how much of that supply the insiders still hold.

CREATE TABLE IF NOT EXISTS nodex.token_insider_analysis (
    contract String,
    chain LowCardinality(String),
    name String,
    symbol String,
    image_url String DEFAULT '',
    launched_at DateTime,
    analyzed_at DateTime,
    -- Launch analysis. Computed once, since the launch window never changes.
    launch_buyers UInt32 DEFAULT 0,
    launch_supply_pct Float32 DEFAULT 0,
    creation_block_supply_pct Float32 DEFAULT 0,
    linked_wallets UInt32 DEFAULT 0,
    linked_supply_pct Float32 DEFAULT 0,
    clusters UInt32 DEFAULT 0,
    largest_cluster_supply_pct Float32 DEFAULT 0,
    co_signed_links UInt32 DEFAULT 0,
    fee_paid_links UInt32 DEFAULT 0,
    split_transfers UInt32 DEFAULT 0,
    shared_funder_links UInt32 DEFAULT 0,
    insider_wallets Array(String) DEFAULT [],
    insider_acquired_pct Float32 DEFAULT 0,
    launch_score Float32 DEFAULT 0,
    evidence Array(String) DEFAULT [],
    -- Refreshed every run.
    insider_holding_pct Float32 DEFAULT 0,
    insider_status LowCardinality(String) DEFAULT 'unknown',
    price Float64 DEFAULT 0,
    market_cap Float64 DEFAULT 0,
    liquidity Float64 DEFAULT 0,
    volume_24h Float64 DEFAULT 0,
    price_change_24h Float32 DEFAULT 0,
    holders UInt32 DEFAULT 0,
    launch_high_mc Float64 DEFAULT 0,
    post_launch_low_mc Float64 DEFAULT 0,
    ath_mc Float64 DEFAULT 0,
    price_pattern LowCardinality(String) DEFAULT 'unknown',
    insider_score Float32 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, contract);
