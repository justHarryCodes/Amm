import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../utils/logger';

declare global { var __pgPool: Pool | undefined }

function getPool(): Pool {
  if (!global.__pgPool) {
    if (!config.database.url) throw new Error('DATABASE_URL is not set');
    global.__pgPool = new Pool({
      connectionString: config.database.url,
      ssl: false,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    global.__pgPool.on('error', (err) => logger.error('PG pool error', { msg: err.message }));
  }
  return global.__pgPool;
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await getPool().connect();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    client.release();
  }
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function testConnection(): Promise<boolean> {
  try { await query('SELECT 1'); return true; } catch { return false; }
}
