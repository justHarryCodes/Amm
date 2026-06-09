import { NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { priceMonitor } from '@/lib/services/priceMonitor';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snap = priceMonitor.getLastSnapshot();
    const { chain, targetPeg, upperBand, lowerBand } = pegMaintainer.settings;
    const stats = await pegMaintainer.getDailyStats();

    // Describe which token/pair addresses are active for this chain
    const chainCfg = chain === 'bsc'
      ? config.pegChains.bsc
      : chain === 'ethereum'
        ? config.pegChains.ethereum
        : config.pegChains.solana;

    return NextResponse.json({
      state:       pegMaintainer.state,
      chain,
      chainConfig: chainCfg,
      currentPrice:  snap?.price ?? null,
      targetPeg,
      upperBound:    targetPeg * (1 + upperBand),
      lowerBound:    targetPeg * (1 - lowerBand),
      liquidityUsd:  snap?.liquidityUsd ?? null,
      tokenReserve:  snap?.tokenReserve ?? null,
      stableReserve: snap?.stableReserve ?? null,
      lastUpdated:   snap?.timestamp ?? null,
      dailyStats:    stats,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
