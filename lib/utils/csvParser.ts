import { parse } from 'csv-parse';
import { ethers } from 'ethers';
import { Readable } from 'stream';

export interface CsvRow { address: string; amount: string }

export interface ParseResult {
  valid: CsvRow[];
  invalid: Array<{ line: number; raw: string; reason: string }>;
  duplicates: string[];
  totalAmount: string;
}

export async function parseCsv(buffer: Buffer): Promise<ParseResult> {
  const rows: CsvRow[] = [];
  const invalid: ParseResult['invalid'] = [];
  let lineIndex = 0;

  await new Promise<void>((resolve, reject) => {
    Readable.from(buffer)
      .pipe(parse({ columns: true, skip_empty_lines: true, trim: true }))
      .on('data', (row: Record<string, string>) => {
        lineIndex++;
        const addr   = (row['address'] || row['Address'] || row['wallet'] || '').trim();
        const amount = (row['amount']  || row['Amount']  || row['tokens']  || '').trim();

        if (!addr)   { invalid.push({ line: lineIndex + 1, raw: JSON.stringify(row), reason: 'Missing address' }); return; }
        if (!amount) { invalid.push({ line: lineIndex + 1, raw: addr, reason: 'Missing amount' }); return; }
        if (!ethers.isAddress(addr)) { invalid.push({ line: lineIndex + 1, raw: addr, reason: 'Invalid address' }); return; }
        const n = parseFloat(amount);
        if (isNaN(n) || n <= 0) { invalid.push({ line: lineIndex + 1, raw: addr, reason: `Invalid amount: ${amount}` }); return; }

        rows.push({ address: ethers.getAddress(addr), amount });
      })
      .on('error', reject)
      .on('end', resolve);
  });

  const seen = new Set<string>();
  const duplicates: string[] = [];
  const valid: CsvRow[] = [];

  for (const row of rows) {
    const key = row.address.toLowerCase();
    if (seen.has(key)) { duplicates.push(row.address); }
    else { seen.add(key); valid.push(row); }
  }

  let total = 0n;
  for (const row of valid) {
    try { total += ethers.parseUnits(row.amount, 18); } catch { /* skip */ }
  }

  return { valid, invalid, duplicates, totalAmount: ethers.formatUnits(total, 18) };
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
