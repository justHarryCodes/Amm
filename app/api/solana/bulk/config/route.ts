import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { getSolanaWalletInfo } from '@/lib/solana/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const wallet = await getSolanaWalletInfo();
    return NextResponse.json({
      network:       config.solana.network,
      walletAddress: wallet.address,
      solBalance:    wallet.solBalance,
      defaultBatchSize: config.solana.batchSize,
      concurrency:   config.solana.concurrency,
      priorityFee:   config.solana.priorityFee,
      rpcUrl:        config.solana.rpcUrl.replace(/\/[^/]+$/, '/***'), // redact key in URL
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
