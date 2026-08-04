-- Source the wallets view from the churn-qualified token list.
-- Apply after 010-churn-discovery.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: the wallets page ranked wallets by a smart_score derived from whatever tokens trade
-- ingestion happened to cover, which was a different set from the tokens the product surfaces.
-- None of the 22 churn-qualified tokens had wallet performance rows at all.
--
-- A wallet is now interesting for a specific reason: it traded several tokens that passed the
-- churn screen and made money on them. One profitable token is luck, so the view requires
-- repeat performance across the qualified set.

ALTER TABLE nodex.wallet_analytics
    -- Distinct churn-qualified tokens this wallet traded.
    ADD COLUMN IF NOT EXISTS qualified_tokens UInt32 DEFAULT 0,
    -- Of those, how many it closed or currently holds at a profit.
    ADD COLUMN IF NOT EXISTS qualified_wins UInt32 DEFAULT 0,
    -- Combined realized plus unrealized profit across the qualified set only.
    ADD COLUMN IF NOT EXISTS qualified_profit_usd Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS qualified_win_rate Float32 DEFAULT 0;
