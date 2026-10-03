-- When NodeX first saw each token in one of its tables, and how high its market cap has gone since.
-- The worker creates and backfills this table itself on its next run (see
-- src/workers/sync-sightings.ts), so running this file by hand is optional.
--
-- Updated at the end of every pipeline run from market caps the run already fetched, so it costs
-- no extra API calls. The peak is sampled at each run (every 2 hours), so a spike that rises and
-- falls between two runs is not captured. Readings that jump implausibly are ignored (see
-- src/lib/sightings.ts).

CREATE TABLE IF NOT EXISTS nodex.token_sightings (
    chain LowCardinality(String),
    contract String,
    first_seen_at DateTime,
    -- Price and market cap at the first priced sighting. 0 until one exists.
    first_price Float64 DEFAULT 0,
    first_mc Float64 DEFAULT 0,
    -- The multiple is peak_price / first_price. Market cap is for display: Dexscreener's figure
    -- for bridged tokens flips between supply numbers at a steady price.
    peak_price Float64 DEFAULT 0,
    peak_mc Float64 DEFAULT 0,
    peak_at DateTime DEFAULT toDateTime(0),
    -- Last accepted reading. One that jumps far in both price and liquidity is treated as a bad
    -- quote and ignored (src/lib/sightings.ts).
    last_price Float64 DEFAULT 0,
    last_liq Float64 DEFAULT 0,
    updated_at DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (chain, contract);
