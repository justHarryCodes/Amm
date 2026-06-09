import { NextRequest, NextResponse } from 'next/server';
import { parseCsv } from '@/lib/utils/csvParser';
import { getTokenDecimals } from '@/lib/blockchain/contracts';
import { bulkSender } from '@/lib/services/bulkSender';
import { logger } from '@/lib/utils/logger';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file             = form.get('csv') as File | null;
    const tokenAddress     = (form.get('tokenAddress') as string ?? '').trim();
    const multiSenderAddr  = (form.get('multiSenderAddress') as string ?? '').trim();
    const batchSize        = Math.min(parseInt(form.get('batchSize') as string ?? '50'), 200);

    if (!file)            return NextResponse.json({ error: 'No CSV file' },                      { status: 400 });
    if (!tokenAddress)    return NextResponse.json({ error: 'tokenAddress required' },            { status: 400 });
    if (!multiSenderAddr) return NextResponse.json({ error: 'multiSenderAddress required' },     { status: 400 });

    const chain = ((form.get('chain') as string) ?? 'bsc') === 'ethereum' ? 'ethereum' : 'bsc';

    const buffer  = Buffer.from(await file.arrayBuffer());
    const parsed  = await parseCsv(buffer);

    if (parsed.valid.length === 0)
      return NextResponse.json({ error: 'No valid recipients in CSV' }, { status: 400 });

    const decimals = await getTokenDecimals(tokenAddress, chain);
    const jobId    = await bulkSender.createJob({
      fileName: file.name, recipients: parsed.valid,
      tokenAddress, multiSenderAddress: multiSenderAddr, batchSize, decimals, chain,
    });

    // Fire and forget — return immediately
    setImmediate(() => {
      bulkSender.executeJob(jobId, {
        fileName: file.name, recipients: parsed.valid,
        tokenAddress, multiSenderAddress: multiSenderAddr, batchSize, decimals, chain,
      }).catch((e: unknown) => logger.error('Bulk job error', { jobId, err: (e as Error).message }));
    });

    return NextResponse.json({
      jobId,
      totalRecipients: parsed.valid.length,
      skipped: parsed.invalid.length + parsed.duplicates.length,
      message: `Job started. Track at GET /api/bulk/jobs/${jobId}`,
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
