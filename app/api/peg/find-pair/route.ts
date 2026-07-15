import { NextRequest, NextResponse } from 'next/server';
import { getPegSlot } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const slot = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot') ?? 0)));
  const peg = getPegSlot(slot);
  try {
    const pair = await peg.findPair();
    if (pair) {
      peg.updateSettings({ pairAddress: pair });
      return NextResponse.json({ found: true, pairAddress: pair });
    }
    return NextResponse.json({ found: false, pairAddress: null });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
