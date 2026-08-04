-- Persist provider-hosted token image URLs for token tables.
-- Apply after 011-qualified-wallets.sql.

ALTER TABLE nodex.token_launches
    ADD COLUMN IF NOT EXISTS image_url String DEFAULT '';

ALTER TABLE nodex.token_analytics
    ADD COLUMN IF NOT EXISTS image_url String DEFAULT '';
