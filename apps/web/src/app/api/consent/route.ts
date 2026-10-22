/**
 * The consent endpoint.
 *
 * A form POST rather than a fetch, so the consent gate works with JavaScript disabled.
 * A consent mechanism that requires a script to record a refusal is not a consent
 * mechanism — the visitor most likely to be running a script blocker is exactly the one
 * most likely to be refusing.
 *
 * The cookie is set here, by the server, so its attributes cannot drift between the
 * banner and the privacy page.
 */

import { maskForChoice, setCookieValue } from '../../../lib/consent';
import { origin } from '../../../lib/site';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();

  // A FormData entry is a string or a File. Reading a File through String() yields
  // '[object Object]', which would become an unrecognised choice — and an unrecognised
  // choice resolves to necessary-only, so a malformed request would look like a
  // deliberate refusal rather than an error.
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };

  const mask = maskForChoice(field('choice'));

  // Only ever return to our own origin. A `next` parameter that can point anywhere is
  // an open redirect, and this endpoint is reachable without authentication.
  const requested = field('next') || '/';
  const target = new URL(requested.startsWith('/') ? requested : '/', origin());

  return new Response(null, {
    status: 303,
    headers: {
      location: target.toString(),
      'set-cookie': setCookieValue(mask, target.protocol === 'https:'),
      'cache-control': 'no-store',
    },
  });
}
