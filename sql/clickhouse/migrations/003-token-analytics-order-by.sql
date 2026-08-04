-- Migration: fix token_analytics sort key to include period_days
-- Required because ReplacingMergeTree dedupes by ORDER BY key only.
-- Without period_days in the key, each period overwrites the same contract row.

CREATE TABLE IF NOT EXISTS nodex.token_analytics_v2 (
    contract String,
    chain LowCardinality(String),
    period_days UInt16,
    name String,
    symbol String,
    price Float64,
    market_cap Float64,
    change_pct Float32,
    volume Float64,
    liquidity Float64,
    holders UInt32,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, period_days, contract);

INSERT INTO nodex.token_analytics_v2
SELECT
    contract,
    chain,
    period_days,
    name,
    symbol,
    price,
    market_cap,
    change_pct,
    volume,
    liquidity,
    holders,
    updated_at
FROM (
    SELECT
        *,
        row_number() OVER (
            PARTITION BY chain, period_days, contract
            ORDER BY updated_at DESC
        ) AS rn
    FROM nodex.token_analytics
) AS deduped
WHERE rn = 1;

DROP TABLE nodex.token_analytics;

RENAME TABLE nodex.token_analytics_v2 TO nodex.token_analytics;
