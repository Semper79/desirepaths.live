'use client';

/**
 * Client-side tracker and interactive controls for the sign-up surface (Phase 4).
 *
 * Emits `signup_view` on mount and `signup_start` on provider selection, routed
 * entirely through the existing client beacon (`components/beacon.tsx`) to `/i`.
 */

import { useEffect } from 'react';
import { emitClientEvent } from './beacon';

export function SignupTracker(): null {
  useEffect(() => {
    emitClientEvent('signup_view');
  }, []);

  return null;
}

/**
 * Both the destination and the wording are decided on the server, not here.
 *
 * A client component cannot see whether a provider holds credentials, and guessing is how
 * every one of these came to point at a route that answered 500. `signsIn` also governs
 * the label: "Continue with Google" is a specific commitment, so it is only made by a
 * button that keeps it, and the bare provider name is what a visitor sees until then.
 *
 * The click is recorded against the provider either way. That measurement is the surface's
 * purpose and stays truthful whether or not the provider is wired up yet.
 */
export function ProviderLink({
  provider,
  label,
  href,
  signsIn,
}: {
  readonly provider: string;
  readonly label: string;
  readonly href: string;
  readonly signsIn: boolean;
}): React.JSX.Element {
  return (
    <a
      className="provider"
      href={href}
      onClick={() => {
        emitClientEvent('signup_start', 0, { provider });
      }}
    >
      {signsIn ? `Continue with ${label}` : label}
    </a>
  );
}
