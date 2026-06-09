import { NextRequest, NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(pegMaintainer.settings);
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    pegMaintainer.updateSettings(body);
    return NextResponse.json({ success: true, settings: pegMaintainer.settings });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
