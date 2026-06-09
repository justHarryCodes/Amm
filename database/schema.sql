-- =========================================================
-- Peg Maintainer + Bulk Sender Database Schema
-- =========================================================

-- Price history (populated every ~15s by PriceMonitor)
CREATE TABLE IF NOT EXISTS price_history (
  id            SERIAL PRIMARY KEY,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price         NUMERIC(30, 18) NOT NULL,
  token_reserve NUMERIC(30, 18) NOT NULL,
  stable_reserve NUMERIC(30, 18) NOT NULL,
  liquidity_usd NUMERIC(20, 4) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history (timestamp DESC);

-- Peg trade log
CREATE TABLE IF NOT EXISTS peg_trades (
  id             SERIAL PRIMARY KEY,
  timestamp      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action         VARCHAR(4)  NOT NULL CHECK (action IN ('BUY', 'SELL')),
  token_amount   NUMERIC(30, 18) NOT NULL DEFAULT 0,
  stable_amount  NUMERIC(30, 18) NOT NULL DEFAULT 0,
  price_before   NUMERIC(30, 18),
  price_after    NUMERIC(30, 18),
  tx_hash        VARCHAR(66),
  status         VARCHAR(10) NOT NULL CHECK (status IN ('SUCCESS', 'FAILED', 'PENDING')),
  error_message  TEXT
);

CREATE INDEX IF NOT EXISTS idx_peg_trades_timestamp ON peg_trades (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_peg_trades_status    ON peg_trades (status);

-- Bulk send jobs
CREATE TABLE IF NOT EXISTS bulk_send_jobs (
  id                   SERIAL PRIMARY KEY,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,
  file_name            VARCHAR(255) NOT NULL,
  total_recipients     INTEGER NOT NULL DEFAULT 0,
  total_amount         NUMERIC(30, 18) NOT NULL DEFAULT 0,
  status               VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  token_address        VARCHAR(42),
  multisender_address  VARCHAR(42),
  batch_size           INTEGER NOT NULL DEFAULT 50
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status     ON bulk_send_jobs (status);
CREATE INDEX IF NOT EXISTS idx_bulk_jobs_created_at ON bulk_send_jobs (created_at DESC);

-- Bulk send batches
CREATE TABLE IF NOT EXISTS bulk_send_batches (
  id            SERIAL PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES bulk_send_jobs(id) ON DELETE CASCADE,
  batch_number  INTEGER NOT NULL,
  recipients    JSONB NOT NULL DEFAULT '[]',
  tx_hash       VARCHAR(66),
  status        VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED')),
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, batch_number)
);

CREATE INDEX IF NOT EXISTS idx_bulk_batches_job_id ON bulk_send_batches (job_id);

-- Convenience view: daily peg trade summary
CREATE OR REPLACE VIEW daily_peg_summary AS
SELECT
  DATE_TRUNC('day', timestamp) AS day,
  action,
  COUNT(*)                     AS trade_count,
  SUM(token_amount)            AS total_tokens,
  SUM(stable_amount)           AS total_stable,
  COUNT(*) FILTER (WHERE status = 'SUCCESS') AS success_count,
  COUNT(*) FILTER (WHERE status = 'FAILED')  AS fail_count
FROM peg_trades
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
