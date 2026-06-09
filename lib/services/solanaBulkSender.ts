import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { getSolanaConnection, getSolanaKeypair } from '../solana/connection';
import {
  getMintDecimals, getMissingATAs, sendBatchesConcurrently,
  TransferBatch, BatchSendResult,
} from '../solana/splTransfer';
import { config } from '../config';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { CsvRow, chunkArray } from '../utils/csvParser';

export interface SolanaJob {
  fileName: string;
  recipients: CsvRow[];
  tokenMint: string;
  batchSize: number;
}

export interface SolanaJobStatus {
  id: number;
  file_name: string;
  token_mint: string;
  total_recipients: number;
  total_amount_raw: string;
  batch_size: number;
  status: string;
  success_batches: number;
  failed_batches: number;
  atas_created: number;
  recipients_sent: number;
  created_at: Date;
  completed_at: Date | null;
  batches: Array<{
    batchIndex: number;
    tx_signature: string | null;
    status: string;
    recipient_count: number;
    atas_created: number;
    error_message?: string;
  }>;
}

class SolanaBulkSender extends EventEmitter {
  async createJob(job: SolanaJob): Promise<number> {
    let total = 0n;
    // We don't know decimals here yet — store raw amounts, convert later
    const rows = await query<{ id: number }>(
      `INSERT INTO solana_bulk_send_jobs
         (file_name, token_mint, total_recipients, total_amount_raw, status, batch_size)
       VALUES ($1, $2, $3, $4, 'PENDING', $5) RETURNING id`,
      [job.fileName, job.tokenMint, job.recipients.length,
       job.recipients.reduce((s, r) => s + parseFloat(r.amount), 0).toString(),
       job.batchSize]
    );
    return rows[0].id;
  }

  async executeJob(jobId: number, job: SolanaJob): Promise<void> {
    await query(`UPDATE solana_bulk_send_jobs SET status='RUNNING' WHERE id=$1`, [jobId]);
    this.emit('jobStart', { jobId, chain: 'solana' });

    const connection = getSolanaConnection();
    const signer     = getSolanaKeypair();

    logger.info('Solana bulk job started', {
      jobId, mint: job.tokenMint,
      recipients: job.recipients.length, batchSize: job.batchSize,
    });

    // ── Step 1: resolve mint decimals ──────────────────────────────────────
    let decimals: number;
    try {
      decimals = await getMintDecimals(connection, new PublicKey(job.tokenMint));
      logger.info('Mint decimals resolved', { jobId, decimals });
    } catch (e: unknown) {
      const err = `Failed to resolve mint: ${(e as Error).message}`;
      await query(`UPDATE solana_bulk_send_jobs SET status='FAILED' WHERE id=$1`, [jobId]);
      this.emit('jobFailed', { jobId, chain: 'solana', error: err });
      return;
    }

    // ── Step 2: bulk ATA pre-flight ────────────────────────────────────────
    logger.info('Checking ATAs...', { jobId, count: job.recipients.length });
    let missingATAs: Set<string>;
    try {
      const pubkeys = job.recipients.map(r => new PublicKey(r.address));
      missingATAs   = await getMissingATAs(connection, new PublicKey(job.tokenMint), pubkeys);
      logger.info('ATA pre-flight complete', { jobId, missing: missingATAs.size, existing: job.recipients.length - missingATAs.size });
    } catch (e: unknown) {
      logger.warn('ATA pre-flight failed, continuing without cache', { jobId, err: (e as Error).message });
      missingATAs = new Set(); // will be handled per-tx (less efficient but safe)
    }

    // ── Step 3: split into batches ─────────────────────────────────────────
    const chunks: CsvRow[][] = chunkArray(job.recipients, job.batchSize);
    const batches: TransferBatch[] = chunks.map((recipients, i) => ({ batchIndex: i + 1, recipients }));

    logger.info('Sending batches', {
      jobId, total: batches.length,
      concurrency: config.solana.concurrency,
      priorityFee: config.solana.priorityFee,
    });

    // ── Step 4: send concurrently ──────────────────────────────────────────
    let successBatches = 0, failedBatches = 0, totalATAsCreated = 0, totalSent = 0;

    await sendBatchesConcurrently(
      connection, signer, new PublicKey(job.tokenMint), decimals, batches,
      missingATAs, config.solana.priorityFee, config.solana.concurrency,
      config.solana.maxRetries,
      async (result: BatchSendResult) => {
        await this._saveBatch(jobId, result);

        if (result.status === 'SUCCESS') {
          successBatches++;
          totalATAsCreated += result.atasCreated;
          totalSent += result.recipientCount;
          logger.info(`Batch ${result.batchIndex} confirmed`, { jobId, sig: result.txSignature?.slice(0, 12) });
          this.emit('batchConfirmed', { jobId, chain: 'solana', batchIndex: result.batchIndex, txSignature: result.txSignature });
        } else {
          failedBatches++;
          logger.error(`Batch ${result.batchIndex} failed`, { jobId, error: result.error });
          this.emit('batchFailed', { jobId, chain: 'solana', batchIndex: result.batchIndex, error: result.error });
        }

        this.emit('batchDone', { jobId, chain: 'solana', result });
      }
    );

    // ── Step 5: finalise job ───────────────────────────────────────────────
    const finalStatus = failedBatches === 0 ? 'COMPLETED'
      : successBatches === 0  ? 'FAILED' : 'PARTIAL';

    await query(
      `UPDATE solana_bulk_send_jobs
       SET status=$1, completed_at=NOW(), success_batches=$2,
           failed_batches=$3, atas_created=$4, recipients_sent=$5
       WHERE id=$6`,
      [finalStatus, successBatches, failedBatches, totalATAsCreated, totalSent, jobId]
    );

    logger.info('Solana job done', { jobId, finalStatus, successBatches, failedBatches, totalATAsCreated });
    this.emit('jobComplete', { jobId, chain: 'solana', status: finalStatus, successBatches, failedBatches });
  }

  private async _saveBatch(jobId: number, result: BatchSendResult): Promise<void> {
    try {
      await query(
        `INSERT INTO solana_bulk_send_batches
           (job_id, batch_index, tx_signature, status, recipient_count, atas_created, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (job_id, batch_index)
         DO UPDATE SET tx_signature=$3, status=$4, atas_created=$6, error_message=$7`,
        [jobId, result.batchIndex, result.txSignature, result.status,
         result.recipientCount, result.atasCreated, result.error ?? null]
      );
    } catch { /* non-fatal */ }
  }

  async getJobStatus(jobId: number): Promise<SolanaJobStatus | null> {
    const rows = await query<{
      id: number; file_name: string; token_mint: string; total_recipients: number;
      total_amount_raw: string; status: string; batch_size: number;
      created_at: Date; completed_at: Date | null;
      success_batches: number; failed_batches: number;
      atas_created: number; recipients_sent: number;
    }>(`SELECT * FROM solana_bulk_send_jobs WHERE id=$1`, [jobId]);
    if (!rows.length) return null;
    const j = rows[0];

    const batches = await query<{
      batch_index: number; tx_signature: string | null; status: string;
      recipient_count: number; atas_created: number; error_message: string | null;
    }>(`SELECT batch_index,tx_signature,status,recipient_count,atas_created,error_message
        FROM solana_bulk_send_batches WHERE job_id=$1 ORDER BY batch_index`, [jobId]);

    return {
      id:               j.id,
      file_name:        j.file_name,
      token_mint:       j.token_mint,
      total_recipients: j.total_recipients,
      total_amount_raw: j.total_amount_raw,
      batch_size:       j.batch_size,
      status:           j.status,
      success_batches:  j.success_batches ?? 0,
      failed_batches:   j.failed_batches  ?? 0,
      atas_created:     j.atas_created    ?? 0,
      recipients_sent:  j.recipients_sent ?? 0,
      created_at:       j.created_at,
      completed_at:     j.completed_at,
      batches: batches.map(b => ({
        batchIndex:     b.batch_index,
        tx_signature:   b.tx_signature,
        status:         b.status,
        recipient_count: b.recipient_count,
        atas_created:   b.atas_created,
        error_message:  b.error_message ?? undefined,
      })),
    };
  }

  async listJobs(limit = 20) {
    return query<{
      id: number; file_name: string; token_mint: string; total_recipients: number;
      total_amount_raw: string; batch_size: number; status: string;
      success_batches: number; failed_batches: number;
      atas_created: number; recipients_sent: number;
      created_at: Date; completed_at: Date | null;
    }>(
      `SELECT id,file_name,token_mint,total_recipients,total_amount_raw,batch_size,
              status,success_batches,failed_batches,atas_created,recipients_sent,
              created_at,completed_at
       FROM solana_bulk_send_jobs ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
  }

  async exportCsv(jobId: number): Promise<string> {
    const job = await this.getJobStatus(jobId);
    if (!job) throw new Error('Job not found');

    const lines = ['batch_index,tx_signature,status,recipient_count,atas_created,error'];
    for (const b of job.batches) {
      lines.push(`${b.batchIndex},${b.tx_signature ?? ''},${b.status},${b.recipient_count},${b.atas_created},${b.error_message ?? ''}`);
    }
    return lines.join('\n');
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
declare global { var __solanaBulkSender: SolanaBulkSender | undefined }
export const solanaBulkSender: SolanaBulkSender = global.__solanaBulkSender ?? new SolanaBulkSender();
global.__solanaBulkSender = solanaBulkSender;
