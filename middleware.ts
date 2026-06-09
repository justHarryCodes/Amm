import { NextRequest, NextResponse } from 'next/server';

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // SSE endpoint: EventSource can't send headers, so auth via ?key= query param
  if (pathname === '/api/events') {
    const key = searchParams.get('key');
    if (!key || key !== process.env.API_SECRET) {
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return NextResponse.next();
  }

  // All other /api/* routes: x-api-key header
  if (pathname.startsWith('/api/')) {
    const key = req.headers.get('x-api-key');
    if (!key || key !== process.env.API_SECRET) {
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
