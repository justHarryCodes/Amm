import axios from 'axios';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getSolanaConnection } from './connection';
import { getMintDecimals } from './splTransfer';

export interface SolanaPriceResult {
  price: number;
  timestamp: Date;
}

// Derive token price in stablecoin terms by quoting a small stable → token swap.
// This replaces the deprecated Jupiter Price API v4 (price.jup.ag/v4).
// Using 1 unit of stable (assumes 6-decimal stable such as USDC / USDT).
export async function fetchSolanaPrice(
  tokenMint: string,
  stableMint: string
): Promise<SolanaPriceResult> {
  const { jupiterQuoteApi } = config.pegChains.solana;

  // 1 stable unit (6 decimals = 1 USDC / USDT) — small enough to avoid price impact
  const stableInputRaw = 1_000_000;

  const res = await axios.get(`${jupiterQuoteApi}/quote`, {
    params: {
      inputMint:   stableMint,
      outputMint:  tokenMint,
      amount:      stableInputRaw.toString(),
      slippageBps: 50,
    },
    timeout: 10_000,
  });

  const quote = res.data;
  if (!quote?.outAmount) {
    throw new Error(`Jupiter quote not available for token ${tokenMint.slice(0, 8)}…`);
  }

  const conn     = getSolanaConnection();
  const tokenDec = await getMintDecimals(conn, new PublicKey(tokenMint));

  const stableIn = stableInputRaw / 1e6;                        // assume 6-dec stable
  const tokenOut = Number(quote.outAmount) / 10 ** tokenDec;
  const price    = tokenOut > 0 ? stableIn / tokenOut : 0;

  return { price, timestamp: new Date() };
}

// Execute a token swap via Jupiter V6 aggregator (lite-api.jup.ag/swap/v1)
// direction: SELL = token → stable, BUY = stable → token
export async function executeJupiterSwap(opts: {
  direction: 'BUY' | 'SELL';
  amountRaw: bigint;            // raw input units (already decimals-adjusted)
  tokenMint: string;
  stableMint: string;
  slippageBps: number;          // e.g. 50 = 0.5%
  connection: Connection;
  keypair: Keypair;
}): Promise<{ txSignature: string; outputAmount: bigint }> {
  const { direction, amountRaw, tokenMint, stableMint, slippageBps, connection, keypair } = opts;
  const { jupiterQuoteApi } = config.pegChains.solana;

  const inputMint  = direction === 'SELL' ? tokenMint  : stableMint;
  const outputMint = direction === 'SELL' ? stableMint : tokenMint;

  // 1. Get quote
  const quoteRes = await axios.get(`${jupiterQuoteApi}/quote`, {
    params: { inputMint, outputMint, amount: amountRaw.toString(), slippageBps },
    timeout: 10_000,
  });
  const quote = quoteRes.data;
  if (!quote?.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(quote)}`);

  // 2. Request the swap transaction
  const swapRes = await axios.post(`${jupiterQuoteApi}/swap`, {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
    wrapAndUnwrapSol: false,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: config.solana.priorityFee,
  }, { timeout: 15_000 });

  const { swapTransaction } = swapRes.data;
  if (!swapTransaction) throw new Error('Jupiter did not return a swap transaction');

  // 3. Deserialize, sign, broadcast
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);

  const latestBlockhash = await connection.getLatestBlockhash();
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature: sig, ...latestBlockhash },
    'confirmed'
  );

  logger.info('Jupiter swap confirmed', { direction, sig: sig.slice(0, 16) });
  return { txSignature: sig, outputAmount: BigInt(quote.outAmount) };
}
