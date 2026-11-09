import type { Metadata } from 'next';
import { pageMeta } from '@morph/seo';
import { siteIdentity } from '../../lib/site';
import { ProviderLink, SignupTracker } from '../../components/signup-client';

/**
 * Where the hero's call to action goes (Phase 4, D5, D6).
 *
 * `hero.cta` is one of the eleven adaptive surfaces and points at `/join`.
 *
 * WHY THE SITE WORKS WITHOUT SIGN-UP (D6)
 * Desire Path is fully open. Content, feeds, and proof are open to all visitors
 * without metering or gating. Creating an account adds personalisation and the
 * upcoming digest, without locking anything behind an authentication wall.
 */

const PROVIDERS = [
  { id: 'google', name: 'Google' },
  { id: 'apple', name: 'Apple' },
  { id: 'discord', name: 'Discord' },
  { id: 'tiktok', name: 'TikTok' },
  { id: 'passkey', name: 'Passkey' },
] as const;

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/join',
    title: 'Joining Desire Path',
    description:
      'Sign up with one tap. What an account gives you, what it does not, and why the site works without it.',
  });

  return {
    title: 'Join',
    description: site.description,
    alternates: { canonical: meta.canonical },
    robots: { index: false, follow: true },
  };
}

export default function JoinPage(): React.JSX.Element {
  return (
    <main id="main" className="shell">
      <SignupTracker />
      <section>
        <h1>Join Desire Path</h1>
        <p className="muted">
          One tap through a provider you already have, no password, and nothing asked beyond what
          that provider already tells us.
        </p>

        <ul className="providers" style={{ marginBlockStart: 'calc(var(--space-unit) * 2)' }}>
          {PROVIDERS.map((p) => (
            <li key={p.id}>
              <ProviderLink provider={p.id} label={p.name} />
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="why-open">
        <h2 id="why-open">Why the site stays open (D6)</h2>
        <p className="muted">
          Desire Path has no paywall, no metering, and no gated articles. Creating an account
          enables personalised adaptation and subscriptions to the upcoming digest, but you can read
          everything on this site without ever signing in.
        </p>
      </section>

      <section aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">Your data and rights</h2>
        <p className="muted">
          We store only the provider account identifier and display name needed to recognise you. We
          never ask for social posting scopes and never store social media passwords. You can export
          or erase your account data at any time under <a href="/privacy">the privacy policy</a>.
        </p>
        <p style={{ marginBlockStart: 'calc(var(--space-unit) * 2)' }}>
          <a className="cta" href="/how-it-works">
            How the rest of it works
          </a>
        </p>
      </section>
    </main>
  );
}
