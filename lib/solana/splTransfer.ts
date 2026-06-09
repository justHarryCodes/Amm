/**
 * Solana SPL Token Bulk Transfer
 *
 * Batching strategy:
 *   - Legacy transactions are capped at 1232 bytes.
 *   - Each transfer instruction ≈ 130 bytes; ATA create ≈ 120 bytes extra.
 *   - Safe default: 10 recipients/tx (fits with or without ATA creation).
 *   - Compute units: 50k base + 50k per recipient (ATA create costs more).
 *   - Concurrent sends: configurable (default 3) to avoid RPC rate limits.
 *   - Confirmation: uses lastValidBlockHeight for precise expiry detection.
 *   - Retry: re-fetches blockhash and resigns on expiry (up to maxRetries).
 */
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  ComputeBudgetProgram, SendTransactionError,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { logger } from '../utils/logger';
import { CsvRow } from '../utils/csvParser';

export interface TransferBatch {
  batchIndex: number;
  recipients: CsvRow[];
}

export interface BatchSendResult {
  batchIndex: number;
  txSignature: string | null;
  status: 'SUCCESS' | 'FAILED';
  error?: string;
  recipientCount: number;
  atasCreated: number;
}

/** Fetch mint decimals (cached per call — callers should cache externally for loops). */
export async function getMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const info = await getMint(connection, mint, 'confirmed');
  return info.decimals;
}

/**
 * Pre-flight: check which recipient ATAs already exist using getMultipleAccountsInfo.
 * Returns a Set of ATA pubkeys (as base58) that DO NOT exist yet.
 */
export async function getMissingATAs(
  connection: Connection,
  tokenMint: PublicKey,
  recipientPubkeys: PublicKey[]
): Promise<Set<string>> {
  if (recipientPubkeys.length === 0) return new Set();

  const ataAddresses = await Promise.all(
    recipientPubkeys.map(pk => getAssociatedTokenAddress(tokenMint, pk))
  );

  // getMultipleAccountsInfo handles up to 100 at a time
  const CHUNK = 100;
  const missing = new Set<string>();

  for (let i = 0; i < ataAddresses.length; i += CHUNK) {
    const chunk = ataAddresses.slice(i, i + CHUNK);
    const infos  = await connection.getMultipleAccountsInfo(chunk, 'confirmed');
    infos.forEach((info, idx) => {
      if (!info) missing.add(ataAddresses[i + idx].toBase58());
    });
  }

  return missing;
}

/**
 * Build a single transaction for one batch of recipients.
 * Includes:
 *   1. ComputeBudget — limit + priority fee
 *   2. createAssociatedTokenAccount for any missing ATAs
 *   3. transferChecked for each recipient
 */
export async function buildBatchTransaction(
  connection: Connection,
  signer: Keypair,
  tokenMint: PublicKey,
  decimals: number,
  batch: CsvRow[],
  missingATAs: Set<string>,
  priorityMicroLamports: number
): Promise<{ tx: Transaction; atasCreated: number }> {
  const tx = new Transaction();
  const recipientPubkeys = batch.map(r => new PublicKey(r.address));
  const ataAddresses = await Promise.all(
    recipientPubkeys.map(pk => getAssociatedTokenAddress(tokenMint, pk))
  );

  // Count how many ATAs we'll create in this batch
  let atasCreated = 0;
  for (const ata of ataAddresses) {
    if (missingATAs.has(ata.toBase58())) atasCreated++;
  }

  // Compute units: base 20k + 50k per transfer + 25k per ATA creation
  const computeUnits = 20_000 + batch.length * 50_000 + atasCreated * 25_000;
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(computeUnits, 1_400_000) }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }));

  const senderATA = await getAssociatedTokenAddress(tokenMint, signer.publicKey);

  for (let i = 0; i < batch.length; i++) {
    const recipientATA = ataAddresses[i];

    // Create ATA if missing
    if (missingATAs.has(recipientATA.toBase58())) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          signer.publicKey,    // fee payer
          recipientATA,        // new ATA
          recipientPubkeys[i], // owner
          tokenMint
        )
      );
    }

    // Transfer tokens
    const rawAmount = BigInt(
      Math.floor(parseFloat(batch[i].amount) * 10 ** decimals)
    );

    tx.add(
      createTransferCheckedInstruction(
        senderATA,           // source
        tokenMint,           // mint
        recipientATA,        // destination
        signer.publicKey,    // owner of source
        rawAmount,
        decimals
      )
    );
  }

  return { tx, atasCreated };
}

/**
 * Sign and send one transaction, waiting for confirmation.
 * Re-fetches blockhash on each attempt so we never send an expired transaction.
 */
export async function sendAndConfirmBatch(
  connection: Connection,
  tx: Transaction,
  signer: Keypair,
  maxRetries: number
): Promise<string> {
  let lastErr: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;

    // Re-sign on each attempt (new blockhash = new sig)
    tx.signatures = [];
    tx.sign(signer);

    let signature: string;
    try {
      signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 0, // we handle retries ourselves
      });
    } catch (e: unknown) {
      // Preflight failure — no point retrying identical transaction
      const msg = (e as Error).message ?? String(e);
      if (msg.includes('custom program error') || msg.includes('insufficient funds')) {
        throw e;
      }
      lastErr = e as Error;
      logger.warn(`Tx send failed (attempt ${attempt})`, { error: msg });
      await sleep(1500 * attempt);
      continue;
    }

    try {
      const result = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );
      if (result.value.err) {
        throw new Error(`Transaction error: ${JSON.stringify(result.value.err)}`);
      }
      return signature;
    } catch (e: unknown) {
      const msg = (e as Error).message ?? String(e);
      lastErr = e as Error;

      const isExpiry = msg.includes('block height exceeded') || msg.includes('Blockhash not found');
      logger.warn(`Tx confirm failed (attempt ${attempt})`, { signature, error: msg, isExpiry });

      if (!isExpiry) throw e; // Non-expiry errors don't benefit from retry
      await sleep(2000);
    }
  }

  throw lastErr;
}

/**
 * Process multiple batches with bounded concurrency.
 * Sends `concurrency` batches in parallel, waits for all to settle, then continues.
 * This prevents RPC overload while maximising throughput.
 */
export async function sendBatchesConcurrently(
  connection: Connection,
  signer: Keypair,
  tokenMint: PublicKey,
  decimals: number,
  batches: TransferBatch[],
  missingATAs: Set<string>,
  priorityMicroLamports: number,
  concurrency: number,
  maxRetries: number,
  onBatchDone: (result: BatchSendResult) => void
): Promise<BatchSendResult[]> {
  const results: BatchSendResult[] = [];

  for (let i = 0; i < batches.length; i += concurrency) {
    const window = batches.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      window.map(async (batch): Promise<BatchSendResult> => {
        let atasCreated = 0;
        try {
          const { tx, atasCreated: ac } = await buildBatchTransaction(
            connection, signer, tokenMint, decimals,
            batch.recipients, missingATAs, priorityMicroLamports
          );
          atasCreated = ac;
          const sig = await sendAndConfirmBatch(connection, tx, signer, maxRetries);

          return {
            batchIndex: batch.batchIndex,
            txSignature: sig,
            status: 'SUCCESS',
            recipientCount: batch.recipients.length,
            atasCreated,
          };
        } catch (e: unknown) {
          return {
            batchIndex: batch.batchIndex,
            txSignature: null,
            status: 'FAILED',
            error: (e as Error).message ?? String(e),
            recipientCount: batch.recipients.length,
            atasCreated,
          };
        }
      })
    );

    for (const s of settled) {
      const result = s.status === 'fulfilled'
        ? s.value
        : { batchIndex: -1, txSignature: null, status: 'FAILED' as const,
            error: String((s as PromiseRejectedResult).reason), recipientCount: 0, atasCreated: 0 };
      results.push(result);
      onBatchDone(result);
    }
  }

  return results;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
