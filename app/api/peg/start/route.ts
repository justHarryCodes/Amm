import { NextRequest, NextResponse } from 'next/server';
import { getPegSlot } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { mode?: string; slot?: number };
    const slot = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot') ?? body.slot ?? 0)));
    const { mode } = body;
    if (!mode || !['MONITOR_ONLY', 'AUTO_TRADE'].includes(mode)) {
      return NextResponse.json({ error: 'mode must be MONITOR_ONLY or AUTO_TRADE' }, { status: 400 });
    }
    const peg = getPegSlot(slot);
    await peg.start(mode as 'MONITOR_ONLY' | 'AUTO_TRADE');
    return NextResponse.json({ success: true, state: peg.state, slot });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
