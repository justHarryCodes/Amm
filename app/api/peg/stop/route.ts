import { NextRequest, NextResponse } from 'next/server';
import { getPegSlot } from '@/lib/services/pegMaintainer';
export const runtime = 'nodejs';
export async function POST(req: NextRequest) {
  const slot = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot') ?? 0)));
  const peg = getPegSlot(slot);
  peg.stop();
  return NextResponse.json({ success: true, state: peg.state, slot });
}
