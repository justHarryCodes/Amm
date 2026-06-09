import { NextResponse } from 'next/server';
import { getBotBalance } from '@/lib/blockchain/provider';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return NextResponse.json(await getBotBalance());
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
