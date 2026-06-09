-- Migration 001: multi-chain peg support
-- Adds chain column to peg_trades and extends tx_hash for Solana signatures (88 chars)

ALTER TABLE peg_trades
  ADD COLUMN IF NOT EXISTS chain VARCHAR(10) NOT NULL DEFAULT 'bsc';

-- Extend tx_hash to hold Solana base58 signatures (88 chars) or EVM hashes (66 chars)
ALTER TABLE peg_trades
  ALTER COLUMN tx_hash TYPE VARCHAR(100);
