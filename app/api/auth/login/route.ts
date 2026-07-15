import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { query } from '@/lib/db/client';

export const runtime = 'nodejs';

async function ensureAdminWalletsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_wallets (
      id       SERIAL PRIMARY KEY,
      address  TEXT UNIQUE NOT NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
}

export async function POST(req: NextRequest) {
  const { address, signature, timestamp } =
    await req.json() as { address?: string; signature?: string; timestamp?: number };

  const adminAddress = process.env.ADMIN_ADDRESS;
  if (!adminAddress) {
    return NextResponse.json({ error: 'ADMIN_ADDRESS not set in environment' }, { status: 500 });
  }

  if (!address || !signature || !timestamp) {
    return NextResponse.json({ error: 'Missing address, signature, or timestamp' }, { status: 400 });
  }

  if (Math.abs(Date.now() - timestamp) > 120_000) {
    return NextResponse.json({ error: 'Signature expired — please try again' }, { status: 401 });
  }

  const message = `Sign in to PegBot\n\nTimestamp: ${timestamp}`;

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const recoveredLower = recovered.toLowerCase();
  const isRootAdmin    = recoveredLower === adminAddress.toLowerCase();

  let allowed = isRootAdmin;
  if (!allowed) {
    await ensureAdminWalletsTable();
    const rows = await query(
      'SELECT 1 FROM admin_wallets WHERE LOWER(address) = $1', [recoveredLower]
    ).catch(() => []);
    allowed = rows.length > 0;
  }

  if (!allowed) {
    return NextResponse.json({ error: 'Wallet is not authorised as an admin' }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true, isRootAdmin });
  res.cookies.set('__session', process.env.API_SECRET!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  });
  return res;
}
