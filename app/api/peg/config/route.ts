import { NextRequest, NextResponse } from 'next/server';
import { getPegSlot } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const slot = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot') ?? 0)));
  return NextResponse.json(getPegSlot(slot).settings);
}

export async function PUT(req: NextRequest) {
  const slot = Math.min(2, Math.max(0, Number(req.nextUrl.searchParams.get('slot') ?? 0)));
  try {
    const body = await req.json();
    const peg = getPegSlot(slot);
    peg.updateSettings(body);
    return NextResponse.json({ success: true, settings: peg.settings });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
