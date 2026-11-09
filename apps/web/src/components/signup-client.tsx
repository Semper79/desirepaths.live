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

export function ProviderLink({
  provider,
  label,
}: {
  readonly provider: string;
  readonly label: string;
}): React.JSX.Element {
  return (
    <a
      className="provider"
      href={`/api/auth/signin/${provider}`}
      onClick={() => {
        emitClientEvent('signup_start', 0, { provider });
      }}
    >
      Continue with {label}
    </a>
  );
}
