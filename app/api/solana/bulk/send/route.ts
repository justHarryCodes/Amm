import { NextRequest, NextResponse } from 'next/server';
import { parseCsv } from '@/lib/utils/csvParser';
import { solanaBulkSender } from '@/lib/services/solanaBulkSender';
import { logger } from '@/lib/utils/logger';
import { config } from '@/lib/config';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const form      = await req.formData();
    const file      = form.get('csv') as File | null;
    const tokenMint = (form.get('tokenMint') as string ?? '').trim();
    const batchSize = Math.min(
      parseInt(form.get('batchSize') as string ?? String(config.solana.batchSize)),
      15 // hard cap: Solana legacy tx limit
    );

    if (!file)      return NextResponse.json({ error: 'No CSV file' },       { status: 400 });
    if (!tokenMint) return NextResponse.json({ error: 'tokenMint required' }, { status: 400 });

    // Basic base58 address validation
    try { new (await import('@solana/web3.js')).PublicKey(tokenMint); }
    catch { return NextResponse.json({ error: 'Invalid tokenMint address' }, { status: 400 }); }

    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await parseCsv(buffer);

    if (parsed.valid.length === 0)
      return NextResponse.json({ error: 'No valid recipients in CSV' }, { status: 400 });

    const jobId = await solanaBulkSender.createJob({
      fileName: file.name, recipients: parsed.valid, tokenMint, batchSize,
    });

    setImmediate(() => {
      solanaBulkSender.executeJob(jobId, {
        fileName: file.name, recipients: parsed.valid, tokenMint, batchSize,
      }).catch((e: unknown) =>
        logger.error('Solana bulk job error', { jobId, err: (e as Error).message })
      );
    });

    const totalBatches = Math.ceil(parsed.valid.length / batchSize);
    return NextResponse.json({
      jobId,
      totalRecipients: parsed.valid.length,
      skipped:         parsed.invalid.length + parsed.duplicates.length,
      totalBatches,
      batchSize,
      concurrency:     config.solana.concurrency,
      message: `Job started. ${totalBatches} transactions will be sent ${config.solana.concurrency} at a time.`,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
