import { NextRequest, NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const { tokenAmount, stableAmount } = await req.json();

    if (!tokenAmount || !stableAmount || tokenAmount <= 0 || stableAmount <= 0)
      return NextResponse.json({ error: 'tokenAmount and stableAmount must be positive numbers' }, { status: 400 });

    const result = await pegMaintainer.initializePool(
      Number(tokenAmount),
      Number(stableAmount)
    );

    return NextResponse.json(result);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
