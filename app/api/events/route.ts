import { NextRequest } from 'next/server';
import { getPegSlot } from '@/lib/services/pegMaintainer';
import { getPriceMonitorSlot } from '@/lib/services/priceMonitor';
import { bulkSender } from '@/lib/services/bulkSender';
import { solanaBulkSender } from '@/lib/services/solanaBulkSender';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SLOTS = [0, 1, 2] as const;

export async function GET(req: NextRequest) {
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

      const heartbeat = setInterval(() => {
        if (closed) { clearInterval(heartbeat); return; }
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { /* closed */ }
      }, 20_000);

      // Send current state for all slots on connect
      for (const slot of SLOTS) {
        const snap = getPriceMonitorSlot(slot).getLastSnapshot();
        const peg  = getPegSlot(slot);
        if (snap) send('PRICE_UPDATE', { slot, ...snap });
        send('BOT_STATE', { slot, state: peg.state, settings: peg.settings });
      }

      // Per-slot peg event listeners
      const slotCleanups: (() => void)[] = [];

      for (const slot of SLOTS) {
        const mon = getPriceMonitorSlot(slot);
        const peg = getPegSlot(slot);

        const onPrice    = (d: unknown) => send('PRICE_UPDATE', { slot, ...(d as object) });
        const onState    = (d: unknown) => send('BOT_STATE',   { slot, state: d, settings: peg.settings });
        const onTrade    = (d: unknown) => send('TRADE',       { slot, ...(d as object) });
        const onPegCheck = (d: unknown) => send('PEG_CHECK',   { slot, ...(d as object) });

        mon.on('price',        onPrice);
        peg.on('stateChange',  onState);
        peg.on('trade',        onTrade);
        peg.on('priceUpdate',  onPegCheck);

        slotCleanups.push(() => {
          mon.removeListener('price',        onPrice);
          peg.removeListener('stateChange',  onState);
          peg.removeListener('trade',        onTrade);
          peg.removeListener('priceUpdate',  onPegCheck);
        });
      }

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

      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(heartbeat);
        slotCleanups.forEach(fn => fn());
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
      'X-Accel-Buffering': 'no',
    },
  });
}
