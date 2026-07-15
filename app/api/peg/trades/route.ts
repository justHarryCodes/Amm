import { NextRequest, NextResponse } from 'next/server';
import { getPegSlot } from '@/lib/services/pegMaintainer';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest) {
  const slot   = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot')   ?? 0)));
  const limit  = Math.min(parseInt(req.nextUrl.searchParams.get('limit')  ?? '50'), 200);
  const offset = parseInt(req.nextUrl.searchParams.get('offset') ?? '0');
  try {
    const trades = await getPegSlot(slot).getTradeHistory(limit, offset);
    return NextResponse.json(trades);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
