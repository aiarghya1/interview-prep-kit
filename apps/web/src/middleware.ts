import { NextResponse, type NextRequest } from 'next/server';

/** Cheap first gate: no session cookie, no protected page. The API still verifies the token on every call. */
export function middleware(req: NextRequest) {
  if (!req.cookies.get('ipk_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/kits/:path*'] };
