import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { getChainProvider, getChainSigner } from '@/lib/blockchain/provider';
import { getSolanaConnection, getSolanaKeypair } from '@/lib/solana/connection';
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { CHAIN_TOKENS } from '@/lib/tokens';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Custom stable — always shown in BSC wallet regardless of peg config
const CUSTOM_STABLE_ADDR = '0xbDFA0F1B0C42B2C43B31a2C5F1584B1759D48888';

async function getNativeBalance(
  address: string,
  provider: ethers.AbstractProvider
): Promise<string> {
  try {
    return ethers.formatEther(await provider.getBalance(address));
  } catch {
    return '0';
  }
}

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

async function getErc20Symbol(
  tokenAddr: string,
  provider: ethers.AbstractProvider,
  fallback: string
): Promise<string> {
  if (!tokenAddr || !ethers.isAddress(tokenAddr)) return fallback;
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    return String(await c.symbol());
  } catch {
    return fallback;
  }
}

async function getSplBalance(
  walletPubkey: PublicKey,
  mintAddr: string
): Promise<string> {
  if (!mintAddr) return '0';
  try {
    const conn     = getSolanaConnection();
    const mint     = new PublicKey(mintAddr);
    const mintInfo = await getMint(conn, mint, 'confirmed');
    const ata      = await getAssociatedTokenAddress(mint, walletPubkey);
    const account  = await getAccount(conn, ata, 'confirmed');
    const raw      = Number(account.amount);
    return (raw / 10 ** mintInfo.decimals).toFixed(mintInfo.decimals > 6 ? 6 : mintInfo.decimals);
  } catch {
    return '0';
  }
}

export async function GET() {
  const { chain, tokenAddress, stableAddress } = pegMaintainer.settings;
  const isEvm = chain === 'bsc' || chain === 'ethereum';

  // ── EVM ──────────────────────────────────────────────────────────────────────
  let evmData: {
    address: string;
    bsc: string;
    ethereum: string;
    tokenBalance: string;
    stableBalance: string;
    tokenAddress: string;
    stableAddress: string;
    tokenSymbol: string;
    stableSymbol: string;
    bscUsdc: string;
    bscUsdt: string;
    bscWbnb: string;
    ethUsdc: string;
    ethUsdt: string;
    ethWeth: string;
    customStable: string;
    customStableSymbol: string;
    activeChain: string;
  } | undefined;
  let evmError: string | undefined;

  try {
    const signer         = getChainSigner('bsc');
    const bscProvider    = getChainProvider('bsc');
    const ethProvider    = getChainProvider('ethereum');
    const activeProvider = isEvm ? getChainProvider(chain as 'bsc' | 'ethereum') : bscProvider;

    const [
      bscBal, ethBal,
      tokenBal, stableBal,
      bscUsdc, bscUsdt, bscWbnb,
      ethUsdc, ethUsdt, ethWeth,
      customStableBal,
      tokenSym, stableSym, customStableSym,
    ] = await Promise.all([
      getNativeBalance(signer.address, bscProvider),
      getNativeBalance(signer.address, ethProvider),
      isEvm ? getErc20Balance(signer.address, tokenAddress, activeProvider)  : Promise.resolve('0'),
      isEvm ? getErc20Balance(signer.address, stableAddress, activeProvider) : Promise.resolve('0'),
      getErc20Balance(signer.address, CHAIN_TOKENS.bsc.usdc.address,    bscProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.bsc.usdt.address,    bscProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.bsc.wNative.address, bscProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.ethereum.usdc.address,    ethProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.ethereum.usdt.address,    ethProvider),
      getErc20Balance(signer.address, CHAIN_TOKENS.ethereum.wNative.address, ethProvider),
      getErc20Balance(signer.address, CUSTOM_STABLE_ADDR, bscProvider),
      isEvm && tokenAddress  ? getErc20Symbol(tokenAddress,  activeProvider, '') : Promise.resolve(''),
      isEvm && stableAddress ? getErc20Symbol(stableAddress, activeProvider, '') : Promise.resolve(''),
      getErc20Symbol(CUSTOM_STABLE_ADDR, bscProvider, 'MYUSD'),
    ]);

    evmData = {
      address:      signer.address,
      bsc:          bscBal,
      ethereum:     ethBal,
      tokenBalance: tokenBal,
      stableBalance: stableBal,
      tokenAddress:  isEvm ? tokenAddress  : '',
      stableAddress: isEvm ? stableAddress : '',
      tokenSymbol:   tokenSym,
      stableSymbol:  stableSym,
      bscUsdc, bscUsdt, bscWbnb,
      ethUsdc, ethUsdt, ethWeth,
      customStable:       customStableBal,
      customStableSymbol: customStableSym,
      activeChain: chain,
    };
  } catch (e: unknown) {
    evmError = (e as Error).message;
  }

  // ── Solana ───────────────────────────────────────────────────────────────────
  let solanaData: {
    address: string;
    sol: string;
    tokenBalance: string;
    stableBalance: string;
    tokenMint: string;
    stableMint: string;
    usdcBalance: string;
    usdtBalance: string;
    wsolBalance: string;
  } | undefined;
  let solanaError: string | undefined;

  try {
    const keypair  = getSolanaKeypair();
    const conn     = getSolanaConnection();
    const lamports = await conn.getBalance(keypair.publicKey, 'confirmed');

    const [tokenBal, stableBal, usdcBalance, usdtBalance, wsolBalance] = await Promise.all([
      chain === 'solana' ? getSplBalance(keypair.publicKey, tokenAddress)  : Promise.resolve('0'),
      chain === 'solana' ? getSplBalance(keypair.publicKey, stableAddress) : Promise.resolve('0'),
      getSplBalance(keypair.publicKey, CHAIN_TOKENS.solana.usdc.address),
      getSplBalance(keypair.publicKey, CHAIN_TOKENS.solana.usdt.address),
      getSplBalance(keypair.publicKey, CHAIN_TOKENS.solana.wNative.address),
    ]);

    solanaData = {
      address:      keypair.publicKey.toBase58(),
      sol:          (lamports / LAMPORTS_PER_SOL).toFixed(6),
      tokenBalance: tokenBal,
      stableBalance: stableBal,
      tokenMint:    chain === 'solana' ? tokenAddress  : '',
      stableMint:   chain === 'solana' ? stableAddress : '',
      usdcBalance,
      usdtBalance,
      wsolBalance,
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
