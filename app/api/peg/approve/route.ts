import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { getChainSigner } from '@/lib/blockchain/provider';
import { txOverrides } from '@/lib/blockchain/contracts';
import { CHAIN_TOKENS } from '@/lib/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const APPROVE_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

async function approveToken(
  tokenAddress: string,
  router: string,
  signer: ethers.Wallet,
  gas: Record<string, unknown>,
): Promise<string> {
  const c = new ethers.Contract(tokenAddress, APPROVE_ABI, signer);
  const tx = await c.approve(router, ethers.MaxUint256, gas);
  await tx.wait();

  // Verify the allowance was actually set
  const provider = signer.provider!;
  const verifyC = new ethers.Contract(tokenAddress, APPROVE_ABI, provider);
  const allowance = await verifyC.allowance(signer.address, router) as bigint;
  if (allowance === 0n) {
    throw new Error(`Approval tx confirmed but allowance is still 0 for ${tokenAddress} — token may have non-standard approve`);
  }

  return tx.hash as string;
}

// POST body: { target: 'token' | 'stable' | 'both' }  (default: 'both')
export async function POST(req: NextRequest) {
  const body       = await req.json().catch(() => ({})) as { target?: string };
  const target     = body.target ?? 'both';

  const { chain, tokenAddress, stableAddress } = pegMaintainer.settings;

  if (chain === 'solana') {
    return NextResponse.json({ error: 'Solana does not use ERC-20 approvals' }, { status: 400 });
  }
  if (!tokenAddress || !stableAddress) {
    return NextResponse.json({ error: 'Token and stable addresses must be saved first' }, { status: 400 });
  }
  if (!ethers.isAddress(tokenAddress) || !ethers.isAddress(stableAddress)) {
    return NextResponse.json({ error: 'Invalid token or stable address' }, { status: 400 });
  }

  const evmChain = chain as 'bsc' | 'ethereum';
  const router   = CHAIN_TOKENS[evmChain].router;
  const signer   = getChainSigner(evmChain);
  const gas      = await txOverrides(evmChain) as Record<string, unknown>;

  let tokenHash:  string | null = null;
  let stableHash: string | null = null;

  // Sequential — BSC rejects concurrent txns from same address (nonce collision)
  if (target === 'token' || target === 'both') {
    tokenHash = await approveToken(tokenAddress, router, signer, gas);
  }
  if (target === 'stable' || target === 'both') {
    stableHash = await approveToken(stableAddress, router, signer, gas);
  }

  return NextResponse.json({ tokenHash, stableHash, router });
}
