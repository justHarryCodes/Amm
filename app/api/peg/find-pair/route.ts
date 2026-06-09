import { NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const pair = await pegMaintainer.findPair();
    if (pair) {
      pegMaintainer.updateSettings({ pairAddress: pair });
      return NextResponse.json({ found: true, pairAddress: pair });
    }
    return NextResponse.json({ found: false, pairAddress: null });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
