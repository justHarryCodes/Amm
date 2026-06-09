import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const hours = Math.min(parseInt(req.nextUrl.searchParams.get('hours') ?? '24'), 168);
  try {
    const rows = await query(
      `SELECT timestamp, price, liquidity_usd FROM price_history
       WHERE timestamp > NOW() - ($1 || ' hours')::INTERVAL
       ORDER BY timestamp ASC`, [hours]
    );
    return NextResponse.json(rows);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
