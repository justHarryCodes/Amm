import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/db/client';

export const runtime = 'nodejs';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { address: string } }
) {
  const addr = params.address.toLowerCase();
  const root = process.env.ADMIN_ADDRESS ?? '';
  if (addr === root.toLowerCase()) {
    return NextResponse.json({ error: 'Cannot remove root admin' }, { status: 400 });
  }
  try {
    await query('DELETE FROM admin_wallets WHERE LOWER(address) = $1', [addr]);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
