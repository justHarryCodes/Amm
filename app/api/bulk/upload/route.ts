import { NextRequest, NextResponse } from 'next/server';
import { parseCsv } from '@/lib/utils/csvParser';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('csv') as File | null;
    if (!file) return NextResponse.json({ error: 'No CSV file' }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await parseCsv(buffer);

    return NextResponse.json({
      fileName:           file.name,
      valid:              result.valid.length,
      invalid:            result.invalid.length,
      duplicates:         result.duplicates.length,
      totalAmount:        result.totalAmount,
      preview:            result.valid.slice(0, 10),
      invalidRows:        result.invalid.slice(0, 20),
      duplicateAddresses: result.duplicates.slice(0, 10),
    });
  } catch (e: unknown) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
