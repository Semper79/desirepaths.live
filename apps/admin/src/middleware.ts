/**
 * The gate, applied to everything.
 *
 * Written as a middleware rather than as a check inside each page, because a check per
 * page is a check somebody eventually forgets to add — and the page they forget it on is
 * the one that lists the adaptation log. The default here is closed: everything is gated
 * unless it appears in `PUBLIC_PATHS`, so a new route is protected the moment it exists
 * rather than the moment somebody remembers.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifyToken } from './lib/session.js';

/** The only paths reachable without a session. Deliberately two. */
const PUBLIC_PATHS = new Set(['/login', '/api/login']);

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const secret = process.env['ADMIN_SECRET'] ?? '';
  const token = request.cookies.get(SESSION_COOKIE)?.value;

  if (await verifyToken(secret, token, Date.now())) return NextResponse.next();

  // Redirected rather than 401'd: this is a browser-facing console and the correct
  // response to "you are not signed in" is the sign-in page. No `next` parameter is
  // carried across — an open redirect on a login form is a classic, and the console has
  // few enough pages that landing on the index costs nothing.
  const login = request.nextUrl.clone();
  login.pathname = '/login';
  login.search = '';

  return NextResponse.redirect(login);
}

export const config = {
  /**
   * Everything except Next's own assets.
   *
   * `_next/static` and `_next/image` are build output with no operator data in them, and
   * gating them would mean the login page could not style itself.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
