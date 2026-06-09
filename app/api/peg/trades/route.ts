import { NextRequest, NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const limit  = Math.min(parseInt(req.nextUrl.searchParams.get('limit')  ?? '50'), 200);
  const offset = parseInt(req.nextUrl.searchParams.get('offset') ?? '0');
  try {
    const trades = await pegMaintainer.getTradeHistory(limit, offset);
    return NextResponse.json(trades);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
