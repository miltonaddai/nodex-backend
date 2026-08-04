-- Alpha scoring v2: evidence tiering, real-demand metrics, out-of-sample wallet reputation.
-- Apply after 006-token-quality-gates.sql.
--
-- Context: v1 could never emit a nonzero alpha_score. Wallet smart_score rewarded realized
-- profit (net sellers) while isQualifiedBuyer required net accumulation (net buyers), so the
-- qualified-buyer count was structurally always 0. v2 separates wallet reputation (past exits,
-- computed out-of-sample) from token demand (current accumulation), and adds an evidence tier
-- so tokens without trade-level data are labelled rather than silently scored 0.

ALTER TABLE nodex.token_analytics
    -- 'verified' = has raw trade evidence, 'partial' = live market health only, 'unverified' = neither.
    ADD COLUMN IF NOT EXISTS evidence_tier LowCardinality(String) DEFAULT 'unverified',
    -- Layer 2: real demand, derived from wallet_token_trades rather than aggregates.
    ADD COLUMN IF NOT EXISTS real_buyers UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS independent_buyers UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS net_inflow_usd Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retention_rate Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS demand_persistence Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sniper_share Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS top_buyer_share Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS wash_ratio Float32 DEFAULT 0,
    -- Layer 1: set when a hard safety gate trips. Such rows stay queryable but are excluded
    -- from the ranked list, so filters can be audited and tuned.
    ADD COLUMN IF NOT EXISTS safety_failed UInt8 DEFAULT 0,
    -- Reputation-weighted conviction, kept separate from alpha_score for debugging.
    ADD COLUMN IF NOT EXISTS reputation_weighted_inflow Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trade_count UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS distinct_traders UInt32 DEFAULT 0;

ALTER TABLE nodex.wallet_analytics
    -- Layer 3: reputation from closed positions on OTHER tokens (leave-one-out).
    -- smart_score is retained during migration so v1 rows remain readable.
    ADD COLUMN IF NOT EXISTS reputation_score Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS closed_positions UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reputation_sample UInt32 DEFAULT 0;

ALTER TABLE nodex.wallet_token_trades
    -- Distinguishes genuine wash/self-trades from multi-hop aggregator routing, which the
    -- v1 `suspicious` flag conflated (69% of trades were flagged, all from transfer count).
    ADD COLUMN IF NOT EXISTS wash_suspected UInt8 DEFAULT 0;
