/**
 * The sign-in POST.
 *
 * A form post with no client JavaScript, matching how the public site's consent gate
 * works and for the same reason: the thing that grants access should not depend on a
 * bundle having loaded.
 */

import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  isOperator,
  issueToken,
} from '../../../lib/session';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env['ADMIN_SECRET'] ?? '';
  const form = await request.formData();
  const supplied = form.get('secret');

  const origin = new URL(request.url).origin;

  if (typeof supplied !== 'string' || !(await isOperator(secret, supplied))) {
    // One generic failure for every reason: wrong secret, missing secret, misconfigured
    // server. Distinguishing them tells an attacker which half of the problem to work on.
    return NextResponse.redirect(`${origin}/login?failed=1`, { status: 303 });
  }

  const response = NextResponse.redirect(origin, { status: 303 });

  response.cookies.set(SESSION_COOKIE, await issueToken(secret, Date.now()), {
    httpOnly: true,
    sameSite: 'strict',
    // Strict rather than Lax: there is no cross-site flow into this console that should
    // arrive already authenticated, and Lax would allow a top-level navigation from
    // anywhere to act as the operator.
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return response;
}
