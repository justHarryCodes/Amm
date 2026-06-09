-- =========================================================
-- Solana Bulk Send Schema
-- =========================================================

CREATE TABLE IF NOT EXISTS solana_bulk_send_jobs (
  id                 SERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  file_name          VARCHAR(255) NOT NULL,
  token_mint         VARCHAR(44)  NOT NULL,   -- Solana base58 address
  total_recipients   INTEGER      NOT NULL DEFAULT 0,
  total_amount_raw   TEXT         NOT NULL DEFAULT '0',
  batch_size         INTEGER      NOT NULL DEFAULT 10,
  status             VARCHAR(10)  NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING','RUNNING','COMPLETED','PARTIAL','FAILED')),
  -- Stats filled at completion
  success_batches    INTEGER DEFAULT 0,
  failed_batches     INTEGER DEFAULT 0,
  atas_created       INTEGER DEFAULT 0,
  recipients_sent    INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sol_jobs_status     ON solana_bulk_send_jobs (status);
CREATE INDEX IF NOT EXISTS idx_sol_jobs_created_at ON solana_bulk_send_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS solana_bulk_send_batches (
  id               SERIAL PRIMARY KEY,
  job_id           INTEGER NOT NULL REFERENCES solana_bulk_send_jobs(id) ON DELETE CASCADE,
  batch_index      INTEGER NOT NULL,
  tx_signature     VARCHAR(88),   -- Solana base58 signature
  status           VARCHAR(10)  NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  recipient_count  INTEGER      NOT NULL DEFAULT 0,
  atas_created     INTEGER      NOT NULL DEFAULT 0,
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, batch_index)
);

CREATE INDEX IF NOT EXISTS idx_sol_batches_job_id ON solana_bulk_send_batches (job_id);
