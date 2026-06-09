import { NextRequest, NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { mode } = await req.json() as { mode?: string };
    if (!mode || !['MONITOR_ONLY', 'AUTO_TRADE'].includes(mode)) {
      return NextResponse.json({ error: 'mode must be MONITOR_ONLY or AUTO_TRADE' }, { status: 400 });
    }
    await pegMaintainer.start(mode as 'MONITOR_ONLY' | 'AUTO_TRADE');
    return NextResponse.json({ success: true, state: pegMaintainer.state });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
