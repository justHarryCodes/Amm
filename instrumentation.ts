// Called once when the Next.js server process starts (Next.js 14 instrumentation API).
// Runs DB migrations, then restores the bot's last known running state from the database
// so the bot continues automatically after a server restart — no browser interaction needed.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // 1. Run all migrations (idempotent — safe to run on every startup)
    try {
      const { runMigrations } = await import('./lib/db/runMigrations');
      await runMigrations();
    } catch (e: unknown) {
      console.error('[instrumentation] Migration failed:', (e as Error).message);
      // Non-fatal — bot will start with whatever schema exists
    }

    // 2. Restore bot state from DB (re-starts the bot if it was running before)
    try {
      const { pegMaintainer } = await import('./lib/services/pegMaintainer');
      await pegMaintainer.restoreState();
    } catch (e: unknown) {
      console.error('[instrumentation] Bot state restore failed:', (e as Error).message);
    }
  }
}
