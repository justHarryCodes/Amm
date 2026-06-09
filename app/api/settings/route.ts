import { NextRequest, NextResponse } from 'next/server';
import { getSettings, updateSettings } from '@/lib/serverSettings';
import { clearEvmCaches } from '@/lib/blockchain/provider';
import { clearSolanaCache } from '@/lib/solana/connection';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(getSettings());
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, string>;
    const patch: Parameters<typeof updateSettings>[0] = {};

    if (body.evmNetwork === 'mainnet' || body.evmNetwork === 'testnet') {
      patch.evmNetwork = body.evmNetwork;
    }
    if (body.solanaNetwork === 'mainnet-beta' || body.solanaNetwork === 'devnet') {
      patch.solanaNetwork = body.solanaNetwork;
    }

    const updated = updateSettings(patch);

    // Clear provider caches so they rebuild with the new network on next use.
    if (patch.evmNetwork !== undefined)    clearEvmCaches();
    if (patch.solanaNetwork !== undefined) clearSolanaCache();

    return NextResponse.json(updated);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
