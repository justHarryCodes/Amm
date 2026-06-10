import { NextRequest, NextResponse } from 'next/server';
import { ethers } from 'ethers';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { address, signature, timestamp } =
    await req.json() as { address?: string; signature?: string; timestamp?: number };

  const adminAddress = process.env.ADMIN_ADDRESS;
  if (!adminAddress) {
    return NextResponse.json({ error: 'ADMIN_ADDRESS not set in environment' }, { status: 500 });
  }

  if (!address || !signature || !timestamp) {
    return NextResponse.json({ error: 'Missing address, signature, or timestamp' }, { status: 400 });
  }

  // Reject if the signed timestamp is older than 2 minutes (prevents replay attacks)
  if (Math.abs(Date.now() - timestamp) > 120_000) {
    return NextResponse.json({ error: 'Signature expired — please try again' }, { status: 401 });
  }

  // Reconstruct the exact message the client signed
  const message = `Sign in to PegBot\n\nTimestamp: ${timestamp}`;

  // Recover the address from the signature — this is the cryptographic proof
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  if (recovered.toLowerCase() !== adminAddress.toLowerCase()) {
    return NextResponse.json({ error: 'Wallet is not the admin address' }, { status: 403 });
  }

  // Address verified — issue session cookie (httpOnly, never readable by JS)
  const res = NextResponse.json({ ok: true });
  res.cookies.set('__session', process.env.API_SECRET!, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  });
  return res;
}
