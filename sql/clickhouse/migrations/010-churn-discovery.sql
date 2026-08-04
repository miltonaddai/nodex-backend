-- Churn-based discovery metrics.
-- Apply after 009-complete-evidence.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: churn = unique_wallet_24h / holder, both returned by the Birdeye discovery call.
-- A bot farm mints one wallet per holder and trades each once, which pins churn at ~1.00.
-- A seeded bundle has holders that never trade, pushing it near 0. Organic tokens break the
-- identity upward because traders exit while other holders sit still.
--
-- Measured across 122 sampled tokens: 54 farms in 0.5-1.2, 42 bundles under 0.5, only 3 in the
-- 1.2-1.5 grey zone, and 23 above 1.5. Two independently hand-verified legitimate tokens landed
-- at 1.94 and 2.30. The gap makes this a structural separator rather than a tuned threshold, and
-- because it comes from the discovery response it screens tokens before any ingestion happens.

ALTER TABLE nodex.token_launches
    ADD COLUMN IF NOT EXISTS unique_wallet_24h UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trade_24h_count UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS buy_24h UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sell_24h UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS fdv Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS churn Float32 DEFAULT 0;

ALTER TABLE nodex.token_analytics
    ADD COLUMN IF NOT EXISTS churn Float32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS unique_wallet_24h UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS buy_sell_ratio Float32 DEFAULT 0,
    -- Set when the token cleared the churn band at discovery time.
    ADD COLUMN IF NOT EXISTS churn_qualified UInt8 DEFAULT 0;
