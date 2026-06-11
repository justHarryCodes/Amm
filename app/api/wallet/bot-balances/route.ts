import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';
import { getSolanaKeypair } from '@/lib/solana/connection';
import { Connection } from '@solana/web3.js';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { CHAIN_TOKENS } from '@/lib/tokens';
import { config } from '@/lib/config';
import { getSettings } from '@/lib/serverSettings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

// Never throws — returns '0' on any RPC error
async function getNativeBalance(
  address: string,
  provider: ethers.AbstractProvider
): Promise<string> {
  try {
    const bal = await provider.getBalance(address);
    return ethers.formatEther(bal);
  } catch {
    return '0';
  }
}

// Never throws — returns '0' on any RPC/contract error
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

// Build a Solana connection that always falls back to public RPC if Alchemy fails
function getSolanaConnectionRobust(): Connection {
  const solNet = getSettings().solanaNetwork;
  const isMainnet = solNet === 'mainnet-beta';

  // Try Alchemy first, then public fallback
  const urls: string[] = [];

  if (config.alchemy.apiKey) {
    urls.push(
      isMainnet
        ? `https://solana-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
        : `https://solana-devnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
    );
  }

  // Always include public RPC
  urls.push(
    isMainnet
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com'
  );

  // Return connection using first URL; if it fails caller can retry with second
  return new Connection(urls[0], { commitment: 'confirmed', disableRetryOnRateLimit: true });
}

// Never throws — returns '0' on any error, tries public RPC as fallback
async function getSolBalance(walletPubkey: PublicKey): Promise<string> {
  const urls: string[] = [];
  const solNet = getSettings().solanaNetwork;
  const isMainnet = solNet === 'mainnet-beta';

  if (config.alchemy.apiKey) {
    urls.push(
      isMainnet
        ? `https://solana-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
        : `https://solana-devnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
    );
  }
  urls.push(isMainnet ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');

  for (const url of urls) {
    try {
      const conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
      const lamports = await conn.getBalance(walletPubkey, 'confirmed');
      return (lamports / LAMPORTS_PER_SOL).toFixed(6);
    } catch {
      continue;
    }
  }
  return '0';
}

// Never throws — returns '0' on any error, tries public RPC as fallback
async function getSplBalance(walletPubkey: PublicKey, mintAddr: string): Promise<string> {
  if (!mintAddr) return '0';

  const solNet = getSettings().solanaNetwork;
  const isMainnet = solNet === 'mainnet-beta';
  const urls: string[] = [];

  if (config.alchemy.apiKey) {
    urls.push(
      isMainnet
        ? `https://solana-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
        : `https://solana-devnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
    );
  }
  urls.push(isMainnet ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com');

  for (const url of urls) {
    try {
      const conn = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
      const mint = new PublicKey(mintAddr);
      const mintInfo = await getMint(conn, mint, 'confirmed');
      const ata = await getAssociatedTokenAddress(mint, walletPubkey);
      const account = await getAccount(conn, ata, 'confirmed');
      const raw = Number(account.amount);
      return (raw / 10 ** mintInfo.decimals).toFixed(mintInfo.decimals > 6 ? 6 : mintInfo.decimals);
    } catch {
      continue;
    }
  }
  return '0';
}

export async function GET() {
  const { chain, tokenAddress, stableAddress } = pegMaintainer.settings;
  const isEvm = chain === 'bsc' || chain === 'ethereum';

  // ── EVM balances ──────────────────────────────────────────────
  let evmData: {
    address: string;
    bsc: string;
    ethereum: string;
    tokenBalance: string;
    stableBalance: string;
    tokenAddress: string;
    stableAddress: string;
    bscUsdc: string;
    bscUsdt: string;
    ethUsdc: string;
    ethUsdt: string;
  } | undefined;
  let evmError: string | undefined;

  try {
    const signer = getChainSigner('bsc');
    const bscProvider = getChainProvider('bsc');
    const ethProvider = getChainProvider('ethereum');
    const activeEvmProvider = isEvm ? getChainProvider(chain as 'bsc' | 'ethereum') : bscProvider;

    // Each balance is fetched independently — one RPC failure won't kill the rest
    const [
      bscBal, ethBal,
      tokenBal, stableBal,
      bscUsdc, bscUsdt,
      ethUsdc, ethUsdt,
    ] = await Promise.all([
      getNativeBalance(signer.address, bscProvider),
      getNativeBalance(signer.address, ethProvider),
      isEvm ? getErc20Balance(signer.address, tokenAddress, activeEvmProvider) : Promise.resolve('0'),
      isEvm ? getErc20Balance(signer.address, stableAddress, activeEvmProvider) : Promise.resolve('0'),
      getErc20Balance(signer.address, CHAIN_TOKENS.bsc.usdc.address, bscProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.bsc.usdt.address, bscProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.ethereum.usdc.address, ethProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.ethereum.usdt.address, ethProvider),
    ]);

    evmData = {
      address: signer.address,
      bsc: bscBal,
      ethereum: ethBal,
      tokenBalance: tokenBal,
      stableBalance: stableBal,
      tokenAddress: isEvm ? tokenAddress : '',
      stableAddress: isEvm ? stableAddress : '',
      bscUsdc,
      bscUsdt,
      ethUsdc,
      ethUsdt,
    };
  } catch (e: unknown) {
    evmError = (e as Error).message;
  }

  // ── Solana balances ───────────────────────────────────────────
  let solanaData: {
    address: string;
    sol: string;
    tokenBalance: string;
    stableBalance: string;
    tokenMint: string;
    stableMint: string;
    usdcBalance: string;
    usdtBalance: string;
  } | undefined;
  let solanaError: string | undefined;

  try {
    const keypair = getSolanaKeypair();

    // All SPL fetches are non-throwing; sol balance tries Alchemy then public
    const [sol, tokenBal, stableBal, usdcBalance, usdtBalance] = await Promise.all([
      getSolBalance(keypair.publicKey),
      chain === 'solana' ? getSplBalance(keypair.publicKey, tokenAddress) : Promise.resolve('0'),
      chain === 'solana' ? getSplBalance(keypair.publicKey, stableAddress) : Promise.resolve('0'),
      getSplBalance(keypair.publicKey, CHAIN_TOKENS.solana.usdc.address),
      getSplBalance(keypair.publicKey, CHAIN_TOKENS.solana.usdt.address),
    ]);

    solanaData = {
      address: keypair.publicKey.toBase58(),
      sol,
      tokenBalance: tokenBal,
      stableBalance: stableBal,
      tokenMint: chain === 'solana' ? tokenAddress : '',
      stableMint: chain === 'solana' ? stableAddress : '',
      usdcBalance,
      usdtBalance,
    };
  } catch (e: unknown) {
    solanaError = (e as Error).message;
  }

  return NextResponse.json({
    evm:    evmData,
    solana: solanaData,
    errors: {
      ...(evmError    ? { evm:    evmError    } : {}),
      ...(solanaError ? { solana: solanaError } : {}),
    },
  });
}
