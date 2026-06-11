// Called once when the Next.js server process starts (Next.js 14 stable instrumentation API).
// 1. Ensures the bot_state table exists (idempotent DDL — no-op if already there).
// 2. Restores the bot's last known running mode from the database so it continues
//    automatically after a server restart or redeploy without any browser interaction.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { query } = await import('./lib/db/client');

      // Idempotent schema setup — runs in ~1ms if table already exists
      await query(`
        CREATE TABLE IF NOT EXISTS bot_state (
          id         INTEGER PRIMARY KEY DEFAULT 1,
          mode       VARCHAR(20) NOT NULL DEFAULT 'STOPPED',
          settings   JSONB       NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT bot_state_single_row CHECK (id = 1)
        )
      `);
      await query(`
        INSERT INTO bot_state (id, mode, settings)
        VALUES (1, 'STOPPED', '{}')
        ON CONFLICT (id) DO NOTHING
      `);
    } catch { /* DB not ready yet — bot will start in STOPPED state */ }

    const { pegMaintainer } = await import('./lib/services/pegMaintainer');
    await pegMaintainer.restoreState();
  }
}
