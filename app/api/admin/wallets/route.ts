import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { query } from '@/lib/db/client';

export const runtime = 'nodejs';

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_wallets (
      id       SERIAL PRIMARY KEY,
      address  TEXT UNIQUE NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
}

export async function GET() {
  await ensureTable();
  const rows = await query<{ address: string; added_at: string }>(
    'SELECT address, added_at FROM admin_wallets ORDER BY added_at ASC'
  );
  const root = process.env.ADMIN_ADDRESS ?? '';
  return NextResponse.json({
    root,
    wallets: rows.map(r => ({ address: r.address, addedAt: r.added_at, isRoot: false })),
  });
}

export async function POST(req: NextRequest) {
  const { address } = await req.json() as { address?: string };
  if (!address || !ethers.isAddress(address)) {
    return NextResponse.json({ error: 'Invalid EVM address' }, { status: 400 });
  }
  const normalized = address.toLowerCase();
  const root = process.env.ADMIN_ADDRESS ?? '';
  if (normalized === root.toLowerCase()) {
    return NextResponse.json({ error: 'Root admin is already permanent' }, { status: 400 });
  }
  await ensureTable();
  try {
    await query(
      'INSERT INTO admin_wallets (address) VALUES ($1) ON CONFLICT (address) DO NOTHING',
      [normalized]
    );
    return NextResponse.json({ ok: true, address: normalized });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
