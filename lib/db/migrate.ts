import fs from 'fs';
import path from 'path';
import { query } from './client';
import { logger } from '../utils/logger';

async function runSql(filePath: string) {
  const sql = fs.readFileSync(filePath, 'utf8');
  for (const stmt of sql.split(';').map(s => s.trim()).filter(Boolean)) {
    try { await query(stmt); }
    catch (err: unknown) {
      logger.error('Migration stmt failed', { err: (err as Error).message, stmt: stmt.slice(0, 80) });
    }
  }
}

async function migrate() {
  const dbDir  = path.join(process.cwd(), 'database');
  const migDir = path.join(dbDir, 'migrations');

  // Base schemas
  await runSql(path.join(dbDir, 'schema.sql'));
  await runSql(path.join(dbDir, 'solana_schema.sql'));

  // Numbered migration files (run in order)
  if (fs.existsSync(migDir)) {
    const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      logger.info('Running migration', { file });
      await runSql(path.join(migDir, file));
    }
  }

  logger.info('Migration complete');
}

migrate().catch(err => { console.error(err); process.exit(1); });
