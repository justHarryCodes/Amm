import { NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';

// V3 concentrated-liquidity pools must be created through the DEX UI (PancakeSwap V3 / Uniswap V3).
// The bot does not create pools — paste the pool address in the Bot Setup form instead.
export async function POST() {
  const { chain } = pegMaintainer.settings;
  const dex = chain === 'bsc' ? 'PancakeSwap V3' : 'Uniswap V3';
  const url = chain === 'bsc'
    ? 'https://pancakeswap.finance/add'
    : 'https://app.uniswap.org/add/v3';
  return NextResponse.json(
    { error: `V3 pools require concentrated-liquidity positions. Create the pool on ${dex} (${url}), then paste the pool address in Bot Setup.` },
    { status: 400 }
  );
}
