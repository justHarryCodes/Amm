import { NextRequest, NextResponse } from 'next/server';
import { parseCsv } from '@/lib/utils/csvParser';
import { getMintDecimals } from '@/lib/solana/splTransfer';
import { getSolanaConnection } from '@/lib/solana/connection';
import { PublicKey } from '@solana/web3.js';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file  = form.get('csv') as File | null;
    const mint  = (form.get('tokenMint') as string ?? '').trim();

    if (!file) return NextResponse.json({ error: 'No CSV file' }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await parseCsv(buffer);

    // Optionally resolve decimals if mint is provided
    let decimals: number | null = null;
    if (mint) {
      try {
        decimals = await getMintDecimals(getSolanaConnection(), new PublicKey(mint));
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({
      fileName:           file.name,
      valid:              result.valid.length,
      invalid:            result.invalid.length,
      duplicates:         result.duplicates.length,
      totalAmount:        result.totalAmount,
      decimals,
      preview:            result.valid.slice(0, 10),
      invalidRows:        result.invalid.slice(0, 20),
      duplicateAddresses: result.duplicates.slice(0, 10),
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
