-- Migration 003: volume trade tracking
-- Distinguishes peg-correction trades from volume-generation swaps

ALTER TABLE peg_trades
  ADD COLUMN IF NOT EXISTS is_volume_trade BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_peg_trades_volume ON peg_trades (is_volume_trade, timestamp DESC);
