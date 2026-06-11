-- Migration 002: bot state persistence
-- Stores the bot's last known mode + settings so it auto-resumes after a server restart

CREATE TABLE IF NOT EXISTS bot_state (
  id         INTEGER PRIMARY KEY DEFAULT 1,
  mode       VARCHAR(20) NOT NULL DEFAULT 'STOPPED',
  settings   JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bot_state_single_row CHECK (id = 1)
);

-- Seed the single control row
INSERT INTO bot_state (id, mode, settings)
VALUES (1, 'STOPPED', '{}')
ON CONFLICT (id) DO NOTHING;
