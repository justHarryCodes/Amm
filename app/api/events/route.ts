import { NextRequest } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
import { priceMonitor } from '@/lib/services/priceMonitor';
import { bulkSender } from '@/lib/services/bulkSender';
import { solanaBulkSender } from '@/lib/services/solanaBulkSender';
import { config } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // EventSource can't send custom headers — use query param for auth
  const key = req.nextUrl.searchParams.get('key');
  if (key !== config.apiSecret) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, data })}\n\n`));
        } catch { /* stream closed */ }
      };

      // Heartbeat — keeps connection alive through proxies
      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
      }, 20_000);

      // Send current state immediately on connect
      const snap = priceMonitor.getLastSnapshot();
      if (snap) send('PRICE_UPDATE', snap);
      send('BOT_STATE', { state: pegMaintainer.state, settings: pegMaintainer.settings });

      // Peg events
      const onPrice       = (d: unknown) => send('PRICE_UPDATE', d);
      const onState       = (d: unknown) => send('BOT_STATE', { state: d, settings: pegMaintainer.settings });
      const onTrade       = (d: unknown) => send('TRADE', d);
      const onPegCheck    = (d: unknown) => send('PEG_CHECK', d);

      // BNB Bulk events
      const onJobStart    = (d: unknown) => send('BULK_JOB_START', d);
      const onJobComplete = (d: unknown) => send('BULK_JOB_COMPLETE', d);
      const onJobFailed   = (d: unknown) => send('BULK_JOB_FAILED', d);
      const onBatchSent   = (d: unknown) => send('BULK_BATCH_SENT', d);
      const onBatchOk     = (d: unknown) => send('BULK_BATCH_CONFIRMED', d);
      const onBatchFail   = (d: unknown) => send('BULK_BATCH_FAILED', d);

      // Solana Bulk events
      const onSolJobStart    = (d: unknown) => send('SOL_JOB_START', d);
      const onSolJobComplete = (d: unknown) => send('SOL_JOB_COMPLETE', d);
      const onSolJobFailed   = (d: unknown) => send('SOL_JOB_FAILED', d);
      const onSolBatchDone   = (d: unknown) => send('SOL_BATCH_DONE', d);
      const onSolBatchOk     = (d: unknown) => send('SOL_BATCH_CONFIRMED', d);
      const onSolBatchFail   = (d: unknown) => send('SOL_BATCH_FAILED', d);

      priceMonitor.on('price',        onPrice);
      pegMaintainer.on('stateChange', onState);
      pegMaintainer.on('trade',       onTrade);
      pegMaintainer.on('priceUpdate', onPegCheck);
      bulkSender.on('jobStart',       onJobStart);
      bulkSender.on('jobComplete',    onJobComplete);
      bulkSender.on('jobFailed',      onJobFailed);
      bulkSender.on('batchSent',      onBatchSent);
      bulkSender.on('batchConfirmed', onBatchOk);
      bulkSender.on('batchFailed',    onBatchFail);
      solanaBulkSender.on('jobStart',       onSolJobStart);
      solanaBulkSender.on('jobComplete',    onSolJobComplete);
      solanaBulkSender.on('jobFailed',      onSolJobFailed);
      solanaBulkSender.on('batchDone',      onSolBatchDone);
      solanaBulkSender.on('batchConfirmed', onSolBatchOk);
      solanaBulkSender.on('batchFailed',    onSolBatchFail);

      // Clean up when the browser disconnects
      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(heartbeat);
        priceMonitor.removeListener('price',        onPrice);
        pegMaintainer.removeListener('stateChange', onState);
        pegMaintainer.removeListener('trade',       onTrade);
        pegMaintainer.removeListener('priceUpdate', onPegCheck);
        bulkSender.removeListener('jobStart',       onJobStart);
        bulkSender.removeListener('jobComplete',    onJobComplete);
        bulkSender.removeListener('jobFailed',      onJobFailed);
        bulkSender.removeListener('batchSent',      onBatchSent);
        bulkSender.removeListener('batchConfirmed', onBatchOk);
        bulkSender.removeListener('batchFailed',    onBatchFail);
        solanaBulkSender.removeListener('jobStart',       onSolJobStart);
        solanaBulkSender.removeListener('jobComplete',    onSolJobComplete);
        solanaBulkSender.removeListener('jobFailed',      onSolJobFailed);
        solanaBulkSender.removeListener('batchDone',      onSolBatchDone);
        solanaBulkSender.removeListener('batchConfirmed', onSolBatchOk);
        solanaBulkSender.removeListener('batchFailed',    onSolBatchFail);
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  });
}
