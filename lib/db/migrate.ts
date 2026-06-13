import { runMigrations } from './runMigrations';

runMigrations().catch(err => {
  console.error('[migrate] Fatal error:', err);
  process.exit(1);
});
