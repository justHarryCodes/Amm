import { NextResponse } from 'next/server';
import { pegMaintainer } from '@/lib/services/pegMaintainer';
export const runtime = 'nodejs';
export async function POST() {
  pegMaintainer.resume();
  return NextResponse.json({ success: true, state: pegMaintainer.state });
}
