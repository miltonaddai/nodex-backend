-- Smart money wallets now come from FOMO's trader leaderboards, with names attached.
-- Apply after 015-smart-money-swaps.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: the Birdeye 30-day leaderboard surfaced token deployers, clone farms and bots that
-- needed several filters and still let some through. FOMO's leaderboards list named traders
-- with their Solana and EVM wallets, saved monthly to src/data/fomo-top-traders.json.

ALTER TABLE nodex.smart_money_wallets
    ADD COLUMN IF NOT EXISTS handle String DEFAULT '',
    ADD COLUMN IF NOT EXISTS display_name String DEFAULT '',
    ADD COLUMN IF NOT EXISTS avatar_url String DEFAULT '',
    ADD COLUMN IF NOT EXISTS followers UInt32 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'birdeye';
