import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { getChainSigner } from '@/lib/blockchain/provider';
import { txOverrides } from '@/lib/blockchain/contracts';
import { CHAIN_TOKENS } from '@/lib/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APPROVE_ABI = ['function approve(address,uint256) returns (bool)'];

export async function POST() {
  const { chain, tokenAddress, stableAddress } = pegMaintainer.settings;

  if (chain === 'solana') {
    return NextResponse.json({ error: 'Solana does not use token approvals' }, { status: 400 });
  }

  if (!tokenAddress || !stableAddress) {
    return NextResponse.json({ error: 'Token and stable addresses must be set first' }, { status: 400 });
  }

  if (!ethers.isAddress(tokenAddress) || !ethers.isAddress(stableAddress)) {
    return NextResponse.json({ error: 'One or more addresses are invalid' }, { status: 400 });
  }

  const evmChain    = chain as 'bsc' | 'ethereum';
  const router      = CHAIN_TOKENS[evmChain].router;
  const signer      = getChainSigner(evmChain);
  const gas         = await txOverrides(evmChain);

  // Always send MaxUint256 approval — sequential so BSC nonce doesn't collide
  const tokenC  = new ethers.Contract(tokenAddress,  APPROVE_ABI, signer);
  const stableC = new ethers.Contract(stableAddress, APPROVE_ABI, signer);

  const tokenTx  = await tokenC.approve(router, ethers.MaxUint256, gas);
  await tokenTx.wait();

  const stableTx = await stableC.approve(router, ethers.MaxUint256, gas);
  await stableTx.wait();

  return NextResponse.json({
    tokenApprovalTx:  tokenTx.hash  as string,
    stableApprovalTx: stableTx.hash as string,
    alreadyApproved:  false,
  });
}
