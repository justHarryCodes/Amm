import { NextRequest, NextResponse } from 'next/server';
import { solanaBulkSender } from '@/lib/services/solanaBulkSender';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const id = parseInt(params.id);
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid job ID' }, { status: 400 });
  try {
    const status = await solanaBulkSender.getJobStatus(id);
    if (!status) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    return NextResponse.json(status);
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
