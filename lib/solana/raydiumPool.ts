/**
 * Raydium CPMM pool management for Solana.
 * Creates / adds liquidity to pools that Jupiter routes through.
 */
import {
  Raydium,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  DEVNET_PROGRAM_ID,
  Percent,
  TxVersion,
} from '@raydium-io/raydium-sdk-v2';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import BN from 'bn.js';
import { getSolanaConnection, getSolanaKeypair } from './connection';
import { config } from '../config';
import { logger } from '../utils/logger';

const isMainnet = config.solana.network === 'mainnet-beta';

const SPL_TOKEN_PROGRAM    = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const JUPITER_PRICE_URL    = 'https://lite-api.jup.ag/price/v2';

export interface SolanaPoolResult {
  isNewPool: boolean;
  poolId: string;
  txHash: string | null;
}

/** Determine which token program owns a mint (SPL vs Token-2022). */
async function getMintProgramId(connection: Connection, mint: string): Promise<string> {
  const info = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
  if (!info) throw new Error(`Mint account not found: ${mint}`);
  return info.owner.toBase58();
}

/** Build a minimal Raydium instance (server-side, no wallet adapter). */
async function loadRaydium(): Promise<Raydium> {
  const connection = getSolanaConnection();
  const owner      = getSolanaKeypair();
  return Raydium.load({
    connection,
    owner,
    cluster:          isMainnet ? 'mainnet' : 'devnet',
    disableLoadToken: true,
    disableFeatureCheck: true,
  });
}

/**
 * Check whether Jupiter can price the token vs the stable — if so, a pool exists.
 * Returns a non-null marker string when found (Jupiter doesn't expose pool IDs directly).
 */
export async function findSolanaPool(
  tokenMint: string,
  stableMint: string,
): Promise<string | null> {
  try {
    const url = `${JUPITER_PRICE_URL}?ids=${tokenMint}&vsToken=${stableMint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Record<string, { price: number } | null> };
    const entry = data.data?.[tokenMint];
    if (entry && entry.price > 0) return 'FOUND_VIA_JUPITER';
  } catch { /* network error — treat as not found */ }
  return null;
}

/**
 * Create a Raydium CPMM pool and seed it with initial liquidity.
 * This is a 2-tx operation: createPool + addLiquidity (both included in the SDK call).
 */
export async function initializeSolanaPool(
  tokenMint: string,
  stableMint: string,
  tokenAmount: number,
  stableAmount: number,
): Promise<SolanaPoolResult> {
  const connection = getSolanaConnection();
  const raydium    = await loadRaydium();

  const [tokenProgramId, stableProgramId, tokenDecimals, stableDecimals] = await Promise.all([
    getMintProgramId(connection, tokenMint),
    getMintProgramId(connection, stableMint),
    (async () => {
      const info = await connection.getParsedAccountInfo(new PublicKey(tokenMint), 'confirmed');
      const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed;
      return parsed?.info?.decimals ?? 6;
    })(),
    (async () => {
      const info = await connection.getParsedAccountInfo(new PublicKey(stableMint), 'confirmed');
      const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number } } })?.parsed;
      return parsed?.info?.decimals ?? 6;
    })(),
  ]);

  const feeConfigs = await raydium.api.getCpmmConfigs();
  if (!feeConfigs?.length) throw new Error('No Raydium CPMM fee configs available');
  const feeConfig = feeConfigs[0]; // lowest fee tier

  const tokenAmt  = new BN(Math.round(tokenAmount  * 10 ** tokenDecimals));
  const stableAmt = new BN(Math.round(stableAmount * 10 ** stableDecimals));

  logger.info('Creating Raydium CPMM pool', { tokenMint, stableMint, tokenAmount, stableAmount });

  const { execute, extInfo } = await raydium.cpmm.createPool({
    programId:     isMainnet ? CREATE_CPMM_POOL_PROGRAM : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
    poolFeeAccount: isMainnet ? CREATE_CPMM_POOL_FEE_ACC : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC,
    mintA: { address: tokenMint,  decimals: tokenDecimals,  programId: tokenProgramId },
    mintB: { address: stableMint, decimals: stableDecimals, programId: stableProgramId },
    mintAAmount: tokenAmt,
    mintBAmount: stableAmt,
    startTime:   new BN(0),
    feeConfig,
    associatedOnly: false,
    ownerInfo:   { useSOLBalance: true },
    txVersion:   TxVersion.LEGACY,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  const poolId = (extInfo as { address: { poolId: PublicKey } }).address.poolId.toBase58();

  logger.info('Raydium CPMM pool created', { poolId, txId });
  return { isNewPool: true, poolId, txHash: txId };
}

// ── Pool resolution ────────────────────────────────────────────────────────────

interface RaydiumApiMint {
  address: string;
  symbol:  string;
  name:    string;
  decimals: number;
}

interface RaydiumApiPool {
  type:         string;
  id:           string;
  mintA:        RaydiumApiMint;
  mintB:        RaydiumApiMint;
  price:        number;
  mintAmountA:  number;
  mintAmountB:  number;
  tvl:          number;
}

export interface SolanaResolvedPool {
  poolId:       string;
  type:         string;
  mintA:        RaydiumApiMint & { botBalance: number };
  mintB:        RaydiumApiMint & { botBalance: number };
  price:        number;
  mintAmountA:  number;
  mintAmountB:  number;
  liquidityUsd: number;
  botAddress:   string;
}

async function getSplBotBalance(connection: Connection, mint: string, owner: PublicKey): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner);
    const bal = await connection.getTokenAccountBalance(ata, 'confirmed');
    return bal.value.uiAmount ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Resolve a Raydium pool by ID: returns token mints, symbols, vault amounts, and bot balances.
 * Uses the Raydium API v3 endpoint.
 */
export async function resolveSolanaPool(poolId: string): Promise<SolanaResolvedPool> {
  const res = await fetch(
    `https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(poolId)}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!res.ok) throw new Error(`Raydium API error (${res.status})`);

  const json = await res.json() as { success: boolean; data?: { data?: RaydiumApiPool[] } };
  if (!json.success || !json.data?.data?.length) {
    throw new Error('Pool not found in Raydium — verify the pool address');
  }
  const pool = json.data.data[0];

  const connection  = getSolanaConnection();
  const keypair     = getSolanaKeypair();
  const botPublicKey = keypair.publicKey;

  const [botBalA, botBalB] = await Promise.all([
    getSplBotBalance(connection, pool.mintA.address, botPublicKey),
    getSplBotBalance(connection, pool.mintB.address, botPublicKey),
  ]);

  return {
    poolId:       pool.id,
    type:         pool.type,
    mintA:        { ...pool.mintA, botBalance: botBalA },
    mintB:        { ...pool.mintB, botBalance: botBalB },
    price:        pool.price,
    mintAmountA:  pool.mintAmountA,
    mintAmountB:  pool.mintAmountB,
    liquidityUsd: pool.tvl,
    botAddress:   botPublicKey.toBase58(),
  };
}

/**
 * Add liquidity to an existing Raydium CPMM pool identified by poolId.
 */
export async function addSolanaLiquidity(
  poolId: string,
  tokenMint: string,
  tokenAmount: number,
): Promise<{ txHash: string }> {
  const connection = getSolanaConnection();
  const raydium    = await loadRaydium();

  const { poolInfo, poolKeys } = await raydium.cpmm.getPoolInfoFromRpc(poolId);

  const tokenDecimals = poolInfo.mintA.address === tokenMint
    ? poolInfo.mintA.decimals
    : poolInfo.mintB.decimals;
  const baseIn = poolInfo.mintA.address === tokenMint;

  const inputAmount = new BN(Math.round(tokenAmount * 10 ** tokenDecimals));

  const { execute } = await raydium.cpmm.addLiquidity({
    poolInfo,
    poolKeys,
    inputAmount,
    baseIn,
    slippage: new Percent(5, 100), // 5%
    txVersion: TxVersion.LEGACY,
  });

  const { txId } = await execute({ sendAndConfirm: true });
  logger.info('Added Solana CPMM liquidity', { poolId, txId });
  return { txHash: txId };
}
