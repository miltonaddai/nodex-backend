-- Migration: wallet token holdings count
ALTER TABLE nodex.wallet_analytics ADD COLUMN IF NOT EXISTS tokens_held UInt32 DEFAULT 0;
