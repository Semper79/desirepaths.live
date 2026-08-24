/**
 * Edge middleware.
 *
 * Computes the visitor context once per request and passes it downstream as headers.
 * The raw inputs — IP, User-Agent, referrer — are consumed here and never travel
 * further: what reaches the application is an anonymous id and a bounded set of
 * covariates. See `docs/PRIVACY.md#2`.
 *
 * Assignment itself is resolved in the root layout rather than here. The reasoning is
 * in `src/lib/request-context.ts`, and it comes down to the Edge runtime having no TCP
 * sockets and therefore no way to reach Redis for the posterior snapshot. Both places
 * run before a byte is sent, so the property that matters — fully adapted HTML, no
 * client re-render, no layout flash — holds either way.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { VisitorIdentity } from '@morph/core';
import {
  ANON_ID_HEADER,
  BOT_SCORE_HEADER,
  CONTEXT_HEADER,
  buildContext,
  encodeContext,
} from './lib/request-context.js';

const pepper = process.env['ANON_ID_PEPPER'] ?? '';
const timezone = process.env['MORPH_TIMEZONE'] ?? 'Europe/Rome';

/**
 * Constructed once per isolate rather than per request: the salt cache inside it is
 * the whole point, and rebuilding it every request would re-derive an HMAC 5,000 times
 * a second for a value that changes daily.
 */
const identity = pepper.length >= 32 ? new VisitorIdentity(pepper) : null;

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Without a pepper there is no identifier, and inventing one would be worse than
  // having none. Serve the site un-personalised rather than fabricate identity.
  if (identity === null) return NextResponse.next();

  const selfHost = request.nextUrl.hostname;
  const ip =
    request.headers.get('x-real-ip') ?? request.headers.get('cf-connecting-ip') ?? '0.0.0.0';

  const { anonId, botScore, context } = await buildContext(
    { url: request.url, headers: request.headers },
    {
      identity,
      selfHost,
      timezone,
      now: new Date(),
      country: request.headers.get('x-country') ?? 'ZZ',
      ip,
    },
  );

  const headers = new Headers(request.headers);
  headers.set(ANON_ID_HEADER, anonId);
  headers.set(BOT_SCORE_HEADER, String(botScore));
  headers.set(CONTEXT_HEADER, encodeContext(context));

  // Strip the raw inputs before they reach the application. Nothing downstream has a
  // legitimate use for them, and a header that is present will eventually be read.
  headers.delete('x-real-ip');
  headers.delete('cf-connecting-ip');
  headers.delete('x-forwarded-for');

  const response = NextResponse.next({ request: { headers } });

  // A first-party marker, so "new vs returning" is answerable without a tracking
  // cookie. It holds no identifier — only the fact that a visit happened before.
  if (!request.cookies.has('morph_seen')) {
    response.cookies.set('morph_seen', '1', {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.nextUrl.protocol === 'https:',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    });
  }

  return response;
}

export const config = {
  /**
   * Everything except static assets and the endpoints that have no visitor.
   *
   * Running middleware on `/_next/static` would derive an identifier for every image
   * request — pure cost, and a privacy operation performed for no reason.
   */
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|feed.xml|atom.xml|api/health|api/ready).*)',
  ],
};
