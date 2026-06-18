import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../config';
import { getSettings } from '../serverSettings';
import { logger } from '../utils/logger';

declare global {
  var __solanaConnection: Connection | undefined;
  var __solanaKeypair:    Keypair    | undefined;
}

function buildSolanaUrl(): string {
  const key = config.alchemy.apiKey;
  if (key) {
    const solNet    = getSettings().solanaNetwork;
    const isMainnet = solNet === 'mainnet-beta';
    return isMainnet
      ? `https://solana-mainnet.g.alchemy.com/v2/${key}`
      : `https://solana-devnet.g.alchemy.com/v2/${key}`;
  }
  if (config.solana.rpcUrl) return config.solana.rpcUrl;
  return 'https://api.mainnet-beta.solana.com';
}

export function getSolanaConnection(): Connection {
  if (!global.__solanaConnection) {
    const url = buildSolanaUrl();
    global.__solanaConnection = new Connection(url, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: config.solana.confirmTimeout * 1000,
    });
    logger.info('Solana connection ready (Alchemy)', { network: getSettings().solanaNetwork });
  }
  return global.__solanaConnection;
}

export function clearSolanaCache(): void {
  global.__solanaConnection = undefined;
}

export function getSolanaKeypair(): Keypair {
  if (!global.__solanaKeypair) {
    if (!config.solana.privateKey) throw new Error('SOLANA_PRIVATE_KEY is not configured');
    try {
      // Phantom / Backpack: base58-encoded 64-byte secret key
      const secretKey = bs58.decode(config.solana.privateKey);
      global.__solanaKeypair = Keypair.fromSecretKey(secretKey);
    } catch {
      // JSON array format: "[1,2,3,...]"
      const arr = JSON.parse(config.solana.privateKey) as number[];
      global.__solanaKeypair = Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    logger.info('Solana signer ready', { address: global.__solanaKeypair.publicKey.toBase58() });
  }
  return global.__solanaKeypair;
}

export async function getSolanaWalletInfo(): Promise<{
  address: string;
  solBalance: string;
  tokenBalance: string | null;
}> {
  const conn    = getSolanaConnection();
  const keypair = getSolanaKeypair();
  const address = keypair.publicKey.toBase58();

  const lamports   = await conn.getBalance(keypair.publicKey, 'confirmed');
  const solBalance = (lamports / LAMPORTS_PER_SOL).toFixed(6);

  return { address, solBalance, tokenBalance: null };
}

export async function getSolanaTokenBalance(tokenMint: string): Promise<string> {
  const conn    = getSolanaConnection();
  const keypair = getSolanaKeypair();
  const mint    = new PublicKey(tokenMint);

  try {
    const ata     = await getAssociatedTokenAddress(mint, keypair.publicKey);
    const account = await getAccount(conn, ata, 'confirmed');
    return account.amount.toString();
  } catch {
    return '0';
  }
}
