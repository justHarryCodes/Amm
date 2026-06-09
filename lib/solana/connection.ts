import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { config } from '../config';
import { getSettings } from '../serverSettings';
import { logger } from '../utils/logger';

declare global {
  var __solanaConnection: Connection | undefined;
  var __solanaKeypair: Keypair | undefined;
}

export function getSolanaConnection(): Connection {
  if (!global.__solanaConnection) {
    const solNet = getSettings().solanaNetwork;
    const isMainnet = solNet === 'mainnet-beta';

    let rpcUrl: string;
    if (config.alchemy.apiKey) {
      rpcUrl = isMainnet
        ? `https://solana-mainnet.g.alchemy.com/v2/${config.alchemy.apiKey}`
        : `https://solana-devnet.g.alchemy.com/v2/${config.alchemy.apiKey}`;
    } else if (config.solana.rpcUrl && !config.solana.rpcUrl.includes('devnet')) {
      rpcUrl = config.solana.rpcUrl;
    } else {
      rpcUrl = isMainnet
        ? 'https://api.mainnet-beta.solana.com'
        : 'https://api.devnet.solana.com';
    }

    global.__solanaConnection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: config.solana.confirmTimeout * 1000,
    });
    logger.info('Solana connection ready', {
      network: solNet,
      mode: config.alchemy.apiKey ? 'alchemy' : 'public',
    });
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
      // Try base58 first (Phantom / Backpack export format)
      const secretKey = bs58.decode(config.solana.privateKey);
      global.__solanaKeypair = Keypair.fromSecretKey(secretKey);
    } catch {
      // Fall back to JSON array format: "[1,2,3,...]"
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
  const conn     = getSolanaConnection();
  const keypair  = getSolanaKeypair();
  const address  = keypair.publicKey.toBase58();

  const lamports = await conn.getBalance(keypair.publicKey, 'confirmed');
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
