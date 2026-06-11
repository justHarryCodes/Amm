import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';
import { CHAIN_TOKENS } from '@/lib/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Threshold: if allowance >= this, consider it "max approved".
// After MaxUint256 approval the value is ~1.16e77, so anything >= 1e36 qualifies.
const APPROVED_THRESHOLD = ethers.parseUnits('1', 36);

export async function GET() {
  const { chain, tokenAddress, stableAddress } = pegMaintainer.settings;

  if (chain === 'solana') {
    return NextResponse.json({ tokenApproved: true, stableApproved: true, solana: true });
  }

  if (
    !tokenAddress || !stableAddress ||
    !ethers.isAddress(tokenAddress) || !ethers.isAddress(stableAddress)
  ) {
    return NextResponse.json({
      tokenApproved: false, stableApproved: false,
      tokenAllowance: '0', stableAllowance: '0',
    });
  }

  const evmChain = chain as 'bsc' | 'ethereum';
  const router   = CHAIN_TOKENS[evmChain].router;
  const signer   = getChainSigner(evmChain);
  const provider = getChainProvider(evmChain);

  const tokenC  = new ethers.Contract(tokenAddress,  ABI, provider);
  const stableC = new ethers.Contract(stableAddress, ABI, provider);

  const [tokenAllow, stableAllow, tokenSym, stableSym] = await Promise.all([
    tokenC.allowance(signer.address, router)  as Promise<bigint>,
    stableC.allowance(signer.address, router) as Promise<bigint>,
    tokenC.symbol().catch(() => 'TOKEN')      as Promise<string>,
    stableC.symbol().catch(() => 'STABLE')    as Promise<string>,
  ]);

  return NextResponse.json({
    tokenAllowance:  tokenAllow.toString(),
    stableAllowance: stableAllow.toString(),
    tokenApproved:   tokenAllow  >= APPROVED_THRESHOLD,
    stableApproved:  stableAllow >= APPROVED_THRESHOLD,
    tokenSymbol:     tokenSym,
    stableSymbol:    stableSym,
    router,
    botAddress: signer.address,
  });
}
