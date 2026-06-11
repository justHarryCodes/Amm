import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getChainSigner, getChainProvider } from '@/lib/blockchain/provider';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { PublicKey } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { getSolanaConnection, getSolanaKeypair } from '@/lib/solana/connection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export async function GET(req: NextRequest) {
  const tokenAddress = req.nextUrl.searchParams.get('tokenAddress') ?? '';
  const chain = (pegMaintainer.settings.chain ?? 'bsc') as 'bsc' | 'ethereum' | 'solana';

  try {
    if (chain === 'solana') {
      let mint: PublicKey;
      try { mint = new PublicKey(tokenAddress); } catch {
        return NextResponse.json({ error: 'Invalid Solana mint address' }, { status: 400 });
      }
      const keypair = getSolanaKeypair();
      const conn    = getSolanaConnection();
      const mintInfo = await getMint(conn, mint, 'confirmed');
      let balance = '0';
      try {
        const ata = await getAssociatedTokenAddress(mint, keypair.publicKey);
        const acct = await getAccount(conn, ata, 'confirmed');
        balance = (Number(acct.amount) / 10 ** mintInfo.decimals).toFixed(mintInfo.decimals > 6 ? 6 : mintInfo.decimals);
      } catch { balance = '0'; }
      return NextResponse.json({ botAddress: keypair.publicKey.toBase58(), balance, symbol: 'TOKEN', decimals: mintInfo.decimals });
    }

    // EVM
    if (!ethers.isAddress(tokenAddress)) {
      return NextResponse.json({ error: 'Invalid token address' }, { status: 400 });
    }
    const evmChain = chain as 'bsc' | 'ethereum';
    const signer   = getChainSigner(evmChain);
    const provider = getChainProvider(evmChain);
    const c = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [bal, dec, sym] = await Promise.all([
      c.balanceOf(signer.address),
      c.decimals(),
      c.symbol().catch(() => 'TOKEN'),
    ]);
    return NextResponse.json({
      botAddress: signer.address,
      balance: ethers.formatUnits(bal, Number(dec)),
      symbol: sym as string,
      decimals: Number(dec),
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
