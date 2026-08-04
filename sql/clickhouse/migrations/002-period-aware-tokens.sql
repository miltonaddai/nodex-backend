-- Migration: period-aware token analytics
-- Run once against an existing ClickHouse nodex database.

ALTER TABLE nodex.token_analytics ADD COLUMN IF NOT EXISTS period_days UInt16 DEFAULT 7;
ALTER TABLE nodex.token_analytics ADD COLUMN IF NOT EXISTS liquidity Float64 DEFAULT 0;
ALTER TABLE nodex.token_analytics ADD COLUMN IF NOT EXISTS change_pct Float32 DEFAULT 0;
