import { NextRequest, NextResponse } from 'next/server';

function hasValidSession(req: NextRequest): boolean {
  // httpOnly session cookie set by /api/auth/login
  const session = req.cookies.get('__session')?.value;
  if (session && session === process.env.API_SECRET) return true;

  // Programmatic access via x-api-key header (CLI / scripts)
  const apiKey = req.headers.get('x-api-key');
  if (apiKey && apiKey === process.env.API_SECRET) return true;

  return false;
}

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // Auth endpoints — always public
  if (pathname.startsWith('/api/auth/')) return NextResponse.next();

  // SSE: EventSource sends cookies automatically — drop the ?key= fallback
  if (pathname === '/api/events') {
    if (!hasValidSession(req)) {
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return NextResponse.next();
  }

  // All other API routes
  if (pathname.startsWith('/api/')) {
    if (!hasValidSession(req)) {
      return new NextResponse(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return NextResponse.next();
  }

  // Page routes — redirect to /login if no valid session
  if (!hasValidSession(req)) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // All API routes
    '/api/:path*',
    // All pages except /login, Next.js internals, and static assets
    '/((?!login|_next/static|_next/image|favicon\\.ico).*)',
  ],
};
