import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { headers } from 'next/headers';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';
import { getSolanaConnection, getSolanaKeypair } from '@/lib/solana/connection';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { pegMaintainer } from '@/lib/services/pegMaintainer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_KEY = process.env.API_SECRET;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

async function getErc20Balance(
  walletAddress: string,
  tokenAddr: string,
  provider: ethers.AbstractProvider
): Promise<string> {
  if (!tokenAddr || !ethers.isAddress(tokenAddr)) return '0';
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const [bal, dec] = await Promise.all([c.balanceOf(walletAddress), c.decimals()]);
    return ethers.formatUnits(bal, Number(dec));
  } catch {
    return '0';
  }
}

async function getSplBalance(
  connection: ReturnType<typeof getSolanaConnection>,
  walletPubkey: PublicKey,
  mintAddr: string
): Promise<string> {
  if (!mintAddr) return '0';
  try {
    const mint = new PublicKey(mintAddr);
    const mintInfo = await getMint(connection, mint, 'confirmed');
    const ata = await getAssociatedTokenAddress(mint, walletPubkey);
    const account = await getAccount(connection, ata, 'confirmed');
    const raw = Number(account.amount);
    return (raw / 10 ** mintInfo.decimals).toFixed(mintInfo.decimals > 6 ? 6 : mintInfo.decimals);
  } catch {
    return '0';
  }
}

export async function GET() {
  const headersList = headers();
  if (headersList.get('x-api-key') !== API_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { chain, tokenAddress, stableAddress } = pegMaintainer.settings;
  const isEvm = chain === 'bsc' || chain === 'ethereum';

  const result: {
    evm?: {
      address: string;
      bsc: string;
      ethereum: string;
      tokenBalance: string;
      stableBalance: string;
      tokenAddress: string;
      stableAddress: string;
    };
    solana?: {
      address: string;
      sol: string;
      tokenBalance: string;
      stableBalance: string;
      tokenMint: string;
      stableMint: string;
    };
    errors: Record<string, string>;
  } = { errors: {} };

  // EVM balances
  try {
    const signer = getChainSigner('bsc');
    const evmProvider = getChainProvider(isEvm ? chain : 'bsc');

    const [bscBal, ethBal, tokenBal, stableBal] = await Promise.all([
      getChainProvider('bsc').getBalance(signer.address),
      getChainProvider('ethereum').getBalance(signer.address),
      isEvm ? getErc20Balance(signer.address, tokenAddress, evmProvider) : Promise.resolve('0'),
      isEvm ? getErc20Balance(signer.address, stableAddress, evmProvider) : Promise.resolve('0'),
    ]);

    result.evm = {
      address: signer.address,
      bsc: ethers.formatEther(bscBal),
      ethereum: ethers.formatEther(ethBal),
      tokenBalance: tokenBal,
      stableBalance: stableBal,
      tokenAddress: isEvm ? tokenAddress : '',
      stableAddress: isEvm ? stableAddress : '',
    };
  } catch (e: unknown) {
    result.errors.evm = (e as Error).message;
  }

  // Solana balance
  try {
    const keypair = getSolanaKeypair();
    const conn = getSolanaConnection();
    const lamports = await conn.getBalance(keypair.publicKey, 'confirmed');

    const [tokenBal, stableBal] = chain === 'solana'
      ? await Promise.all([
          getSplBalance(conn, keypair.publicKey, tokenAddress),
          getSplBalance(conn, keypair.publicKey, stableAddress),
        ])
      : ['0', '0'];

    result.solana = {
      address: keypair.publicKey.toBase58(),
      sol: (lamports / LAMPORTS_PER_SOL).toFixed(6),
      tokenBalance: tokenBal,
      stableBalance: stableBal,
      tokenMint: chain === 'solana' ? tokenAddress : '',
      stableMint: chain === 'solana' ? stableAddress : '',
    };
  } catch (e: unknown) {
    result.errors.solana = (e as Error).message;
  }

  return NextResponse.json(result);
}
