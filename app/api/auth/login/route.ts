import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const { password } = await req.json() as { password?: string };

  if (!password || password !== process.env.API_SECRET) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set('__session', process.env.API_SECRET!, {
    httpOnly: true,                                        // JS cannot read this
    secure: process.env.NODE_ENV === 'production',        // HTTPS-only in prod
    sameSite: 'strict',                                   // no cross-site sends
    maxAge: 60 * 60 * 24 * 7,                             // 7 days
    path: '/',
  });
  return res;
}
