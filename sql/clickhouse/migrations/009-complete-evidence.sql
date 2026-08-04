-- Require complete trade history before a token is scoreable, and record market cap per buyer.
-- Apply after 008-holder-wealth.sql.
--
-- NOTE: the migration runner splits statements on semicolons, so avoid them in comments.
--
-- Context: TNOS scored 77.4 with 70 real buyers against a $5.2M market cap and was confirmed a
-- scam by manual review. Two defects allowed it:
--
--   1. evidence_tier='verified' only required a trade and trader count, not that ingestion had
--      finished. TNOS had backfill_complete=0, so 70 buyers was a lower bound being treated as
--      the true figure, and every ratio derived from it (independence, buyers per dollar of
--      market cap) was wrong in the token's favour.
--   2. Nothing compared buyer count to valuation. $74,600 of market cap per buyer sits 5x above
--      the 75th percentile of observed tokens. A real holder base spreads valuation across many
--      buyers, whereas a bundle concentrates it behind a handful of wallets.

ALTER TABLE nodex.token_analytics
    ADD COLUMN IF NOT EXISTS backfill_complete UInt8 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS mcap_per_buyer Float64 DEFAULT 0;
