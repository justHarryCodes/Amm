import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
export const runtime = 'nodejs';
export async function GET() {
  return NextResponse.json({
    multiSenderAddress: config.multiSender.address,
    tokenAddress: config.tokens.token || null,
  });
}
