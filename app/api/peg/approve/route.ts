import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { ethers } from 'ethers';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { ensureApproval } from '@/lib/blockchain/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_KEY = process.env.API_SECRET;

export async function POST() {
  const headersList = headers();
  if (headersList.get('x-api-key') !== API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { chain, tokenAddress, stableAddress, routerAddress } = pegMaintainer.settings;

  if (chain === 'solana') {
    return NextResponse.json({ error: 'Solana does not use token approvals — SPL transfers are handled via ATAs' }, { status: 400 });
  }

  if (!tokenAddress || !stableAddress || !routerAddress) {
    return NextResponse.json({ error: 'Token, stablecoin, and router addresses must all be set first' }, { status: 400 });
  }

  if (!ethers.isAddress(tokenAddress) || !ethers.isAddress(stableAddress) || !ethers.isAddress(routerAddress)) {
    return NextResponse.json({ error: 'One or more addresses are invalid' }, { status: 400 });
  }

  const evmChain = chain as 'bsc' | 'ethereum';

  // Approve both token and stable for MaxUint256 — sequential so BSC nonce doesn't collide
  const tokenTx  = await ensureApproval(tokenAddress,  routerAddress, ethers.MaxUint256, evmChain);
  const stableTx = await ensureApproval(stableAddress, routerAddress, ethers.MaxUint256, evmChain);

  return NextResponse.json({
    tokenApprovalTx:  tokenTx  ?? null,
    stableApprovalTx: stableTx ?? null,
    alreadyApproved:  !tokenTx && !stableTx,
  });
}
