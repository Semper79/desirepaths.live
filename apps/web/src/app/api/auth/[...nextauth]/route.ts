/**
 * NextAuth route handler for apps/web.
 *
 * Handles OAuth sign-in, callback, session, and sign-out routes under `/api/auth/*`.
 *
 * Emits `morph_signup` cookie upon successful OAuth callback redirect so the client
 * beacon (`components/beacon.tsx`) can record `signup_complete` with the provider prop.
 */

import type { NextRequest } from 'next/server';
import { handlers } from '../../../../lib/auth';

function handleAuthResponse(request: NextRequest, response: Response): Response {
  const url = new URL(request.url);
  const callbackMatch = url.pathname.match(/\/api\/auth\/callback\/([^/?#]+)/);

  if (callbackMatch?.[1] && (response.status === 302 || response.status === 307)) {
    const provider = callbackMatch[1];
    const location = response.headers.get('location') ?? '';

    // Only set on successful completion (not redirecting to error)
    if (!location.includes('error=')) {
      const headers = new Headers(response.headers);
      headers.append('Set-Cookie', `morph_signup=${provider}; Path=/; Max-Age=60; SameSite=Lax`);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
  }

  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  const response = await handlers.GET(request);
  return handleAuthResponse(request, response);
}

export async function POST(request: NextRequest): Promise<Response> {
  const response = await handlers.POST(request);
  return handleAuthResponse(request, response);
}
