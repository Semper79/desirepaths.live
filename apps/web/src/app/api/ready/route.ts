/**
 * Readiness. Checks what the process genuinely cannot serve without.
 *
 * A missing pepper is deliberately *not* ready: the site would render, but every
 * visitor would be un-identified and the adaptive layer silently inert. Failing the
 * probe surfaces a misconfiguration at deploy time rather than as a flat line on a
 * dashboard a week later.
 */

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const checks = {
    pepper: (process.env['ANON_ID_PEPPER'] ?? '').length >= 32,
    publicUrl: (process.env['MORPH_PUBLIC_URL'] ?? '').length > 0,
  };
  const ready = Object.values(checks).every(Boolean);
  return Response.json({ ready, checks }, { status: ready ? 200 : 503 });
}
