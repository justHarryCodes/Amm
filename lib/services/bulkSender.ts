import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getMultiSenderContract, ensureApproval, getTokenDecimals, txOverrides } from '../blockchain/contracts';
import { logger } from '../utils/logger';
import { query } from '../db/client';
import { CsvRow, chunkArray } from '../utils/csvParser';

type EvmChain = 'bsc' | 'ethereum';

export interface BulkJob {
  fileName: string; recipients: CsvRow[];
  tokenAddress: string; multiSenderAddress: string;
  batchSize: number; decimals: number;
  chain: EvmChain;
}

export interface BatchResult {
  jobId: number; batchNumber: number; recipients: CsvRow[];
  txHash: string | null; status: 'SUCCESS' | 'FAILED' | 'PENDING'; error?: string;
}

class BulkSender extends EventEmitter {
  async createJob(job: BulkJob): Promise<number> {
    let total = 0n;
    for (const r of job.recipients) {
      try { total += ethers.parseUnits(r.amount, job.decimals); } catch { /* skip */ }
    }
    const rows = await query<{ id: number }>(
      `INSERT INTO bulk_send_jobs (file_name,total_recipients,total_amount,status,token_address,multisender_address,batch_size)
       VALUES ($1,$2,$3,'PENDING',$4,$5,$6) RETURNING id`,
      [job.fileName, job.recipients.length, ethers.formatUnits(total, job.decimals),
       job.tokenAddress, job.multiSenderAddress, job.batchSize]
    );
    return rows[0].id;
  }

  async executeJob(jobId: number, job: BulkJob): Promise<void> {
    await query(`UPDATE bulk_send_jobs SET status='RUNNING' WHERE id=$1`, [jobId]);
    this.emit('jobStart', { jobId });

    const chain = job.chain ?? 'bsc';
    const ms = getMultiSenderContract(job.multiSenderAddress, chain);
    const batches = chunkArray(job.recipients, job.batchSize);

    // Approve total + 5% buffer
    let total = 0n;
    for (const r of job.recipients) {
      try { total += ethers.parseUnits(r.amount, job.decimals); } catch { /* skip */ }
    }
    try {
      const approvalTx = await ensureApproval(job.tokenAddress, job.multiSenderAddress, (total * 105n) / 100n, chain);
      if (approvalTx) logger.info('Approval confirmed', { jobId, txHash: approvalTx });
    } catch (e: unknown) {
      await query(`UPDATE bulk_send_jobs SET status='FAILED' WHERE id=$1`, [jobId]);
      this.emit('jobFailed', { jobId, error: (e as Error).message });
      return;
    }

    let failed = 0;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      const addresses = batch.map(r => r.address);
      const amounts   = batch.map(r => ethers.parseUnits(r.amount, job.decimals));

      try {
        logger.info(`Batch ${i + 1}/${batches.length}`, { jobId, count: batch.length });
        const overrides = await txOverrides(chain);
        const tx = await ms.sendCustomAmounts(job.tokenAddress, addresses, amounts, overrides);
        await this._saveBatch(jobId, i + 1, batch, tx.hash as string, 'PENDING', null);
        this.emit('batchSent', { jobId, batchNumber: i + 1, txHash: tx.hash });

        await tx.wait();
        await query(`UPDATE bulk_send_batches SET status='SUCCESS' WHERE job_id=$1 AND batch_number=$2`, [jobId, i + 1]);
        logger.info(`Batch ${i + 1} confirmed`, { jobId, txHash: tx.hash });
        this.emit('batchConfirmed', { jobId, batchNumber: i + 1, txHash: tx.hash });
      } catch (e: unknown) {
        failed++;
        const err = (e as Error).message;
        await this._saveBatch(jobId, i + 1, batch, null, 'FAILED', err);
        logger.error(`Batch ${i + 1} failed`, { jobId, err });
        this.emit('batchFailed', { jobId, batchNumber: i + 1, error: err });
      }

      if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
    }

    const finalStatus = failed === 0 ? 'COMPLETED' : failed === batches.length ? 'FAILED' : 'PARTIAL';
    await query(`UPDATE bulk_send_jobs SET status=$1, completed_at=NOW() WHERE id=$2`, [finalStatus, jobId]);
    logger.info('Job done', { jobId, status: finalStatus });
    this.emit('jobComplete', { jobId, status: finalStatus });
  }

  private async _saveBatch(jobId: number, batchNumber: number, recipients: CsvRow[],
    txHash: string | null, status: string, error: string | null) {
    await query(
      `INSERT INTO bulk_send_batches (job_id,batch_number,recipients,tx_hash,status,error_message)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (job_id,batch_number)
       DO UPDATE SET tx_hash=$4,status=$5,error_message=$6`,
      [jobId, batchNumber, JSON.stringify(recipients), txHash, status, error]
    );
  }

  async getJobStatus(jobId: number) {
    const jobs = await query<{
      id: number; file_name: string; total_recipients: number; total_amount: string;
      status: string; created_at: Date; completed_at: Date | null;
    }>(`SELECT * FROM bulk_send_jobs WHERE id=$1`, [jobId]);
    if (!jobs.length) return null;
    const j = jobs[0];

    const batches = await query<{
      batch_number: number; recipients: CsvRow[]; tx_hash: string | null;
      status: string; error_message: string | null;
    }>(`SELECT * FROM bulk_send_batches WHERE job_id=$1 ORDER BY batch_number`, [jobId]);

    return {
      id: j.id, fileName: j.file_name, totalRecipients: j.total_recipients,
      totalAmount: j.total_amount, status: j.status,
      createdAt: j.created_at, completedAt: j.completed_at,
      batches: batches.map(b => ({
        jobId, batchNumber: b.batch_number, recipients: b.recipients,
        txHash: b.tx_hash, status: b.status as BatchResult['status'],
        error: b.error_message ?? undefined,
      })),
    };
  }

  async listJobs(limit = 20) {
    return query<{
      id: number; file_name: string; total_recipients: number; total_amount: string;
      status: string; created_at: Date; completed_at: Date | null;
    }>(`SELECT id,file_name,total_recipients,total_amount,status,created_at,completed_at
        FROM bulk_send_jobs ORDER BY created_at DESC LIMIT $1`, [limit]);
  }

  async exportCsv(jobId: number): Promise<string> {
    const batches = await query<{
      batch_number: number; recipients: string; tx_hash: string | null; status: string;
    }>(`SELECT * FROM bulk_send_batches WHERE job_id=$1 ORDER BY batch_number`, [jobId]);

    const lines = ['address,amount,batch,tx_hash,status'];
    for (const b of batches) {
      const recipients: CsvRow[] = typeof b.recipients === 'string' ? JSON.parse(b.recipients) : b.recipients;
      for (const r of recipients) {
        lines.push(`${r.address},${r.amount},${b.batch_number},${b.tx_hash ?? ''},${b.status}`);
      }
    }
    return lines.join('\n');
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────
declare global { var __bulkSender: BulkSender | undefined }
export const bulkSender: BulkSender = global.__bulkSender ?? new BulkSender();
global.__bulkSender = bulkSender;
