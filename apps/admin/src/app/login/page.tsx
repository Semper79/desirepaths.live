/**
 * The sign-in page.
 *
 * A plain form. No client JavaScript, no framework state, no bundle — the page that grants
 * access to the console should work in whatever a browser can do without help.
 */

import { siteName } from '../../lib/branding';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const failed = (await searchParams)['failed'] !== undefined;

  return (
    <div style={{ maxWidth: 420, margin: '12vh auto 0' }}>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, margin: '0 0 8px' }}>
        {siteName()}
      </h1>
      <p style={{ color: 'var(--color-text-muted)', margin: '0 0 28px' }}>Operator console.</p>

      <form method="post" action="/api/login">
        <label htmlFor="secret" style={{ display: 'block', marginBottom: 8 }}>
          Operator secret
        </label>
        <input
          id="secret"
          name="secret"
          type="password"
          autoComplete="current-password"
          required
          style={{
            width: '100%',
            padding: '12px 14px',
            fontSize: 15,
            background: 'var(--color-surface)',
            color: 'var(--color-text)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
          }}
        />

        {failed ? (
          <p role="alert" style={{ color: 'var(--color-accent)', marginTop: 12 }}>
            That is not the operator secret.
          </p>
        ) : null}

        <button
          type="submit"
          style={{
            marginTop: 20,
            padding: '12px 22px',
            minHeight: 'var(--tap-min)',
            fontSize: 15,
            fontWeight: 600,
            background: 'var(--color-accent)',
            color: 'var(--color-on-accent)',
            border: 'none',
            borderRadius: 'var(--cta-radius)',
            cursor: 'pointer',
          }}
        >
          Sign in
        </button>
      </form>
    </div>
  );
}
