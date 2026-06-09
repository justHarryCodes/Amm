import { NextRequest, NextResponse } from 'next/server';
import { bulkSender } from '@/lib/services/bulkSender';
export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = parseInt(params.id);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid job ID' }, { status: 400 });
  try {
    const csv = await bulkSender.exportCsv(id);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="bulk_job_${id}.csv"`,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
