import { NextResponse } from 'next/server';
import { bulkSender } from '@/lib/services/bulkSender';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return NextResponse.json(await bulkSender.listJobs(20));
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
