import type { Metadata } from 'next';
import type { AuthProvider } from '@morph/core/surfaces';
import { pageMeta } from '@morph/seo';
import { siteIdentity } from '../../lib/site';
import { ProviderLink, SignupTracker } from '../../components/signup-client';
import { availableProviders, signInAvailable } from '../../lib/auth/availability';

/**
 * Where the hero's call to action goes (Phase 4, D5, D6).
 *
 * `hero.cta` is one of the eleven adaptive surfaces and every variant of it points here.
 *
 * THIS PAGE HAS TWO FORMS, AND THE ENVIRONMENT CHOOSES
 * Sign-in needs `AUTH_SECRET` and at least one provider's credentials, and those are the
 * operator's to set — registering an OAuth application takes days of review at some
 * providers. So the page asks `availability.ts` at request time: with sign-in working it
 * offers the providers that actually work, and without it says so plainly rather than
 * rendering buttons that answer 500. The route is dynamic (no `generateStaticParams`,
 * nothing cached) precisely so this is answered per request and not frozen at build time.
 *
 * WHY THE SITE WORKS WITHOUT SIGN-UP (D6)
 * Desire Path is fully open. Content, feeds and proof are open to every visitor without
 * metering or gating. An account adds personalised adaptation and the upcoming digest; it
 * does not unlock anything, because nothing is locked.
 */

const PROVIDER_NAME: Readonly<Record<AuthProvider, string>> = {
  google: 'Google',
  apple: 'Apple',
  discord: 'Discord',
  tiktok: 'TikTok',
  x: 'X',
  twitch: 'Twitch',
  instagram: 'Instagram',
  reddit: 'Reddit',
  spotify: 'Spotify',
  github: 'GitHub',
  email: 'Email link',
  passkey: 'Passkey',
};

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const open = signInAvailable();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/join',
    title: open ? 'Joining Desire Path' : 'Joining Desire Path is not open yet',
    description: open
      ? 'Sign up with one tap. What an account gives you, what it does not, and why the site works without it.'
      : 'Sign-up is not open yet. What it will ask for, what it will not, and why the site works without it.',
  });

  return {
    title: open ? 'Join' : 'Join — not open yet',
    description: site.description,
    alternates: { canonical: meta.canonical },
    // Not indexed either way: while it is closed the page competes with the pages that do
    // explain the thing, and once it is open a sign-in form is not what a search result
    // should lead with.
    robots: { index: false, follow: true },
  };
}

export default function JoinPage(): React.JSX.Element {
  return signInAvailable() ? <JoinOpen /> : <JoinClosed />;
}

function JoinOpen(): React.JSX.Element {
  const providers = availableProviders();

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
          {providers.map((provider) => (
            <li key={provider}>
              <ProviderLink
                provider={provider}
                label={PROVIDER_NAME[provider]}
                href={`/api/auth/signin/${provider}`}
                signsIn
              />
            </li>
          ))}
        </ul>
      </section>

      <WhyOpen />
      <YourData />
    </main>
  );
}

function JoinClosed(): React.JSX.Element {
  return (
    <main id="main" className="shell">
      <section>
        <h1>Not open yet</h1>
        <p className="muted">
          Sign-up is built, but no provider has been connected to it yet — that part needs an
          application registered with Google, Apple, Discord or TikTok, which is a review that takes
          days at some of them. Everything else on this site is running: the page you came from
          picked its own headline, layout and wording for you, and <a href="/proof">/proof</a> shows
          what it has worked out so far.
        </p>
      </section>

      <section aria-labelledby="why">
        <h2 id="why">Why there is no email box here</h2>
        <p className="muted">
          Because it would be the first thing on this site to hold personal data while sign-up is
          still closed. Desire Path currently keeps a rotating daily anonymous hash and nothing else
          — no account, no email address, no profile — and <a href="/privacy">the privacy notice</a>{' '}
          says so. One input field would make that sentence false, so it is not here. You are not
          being measured as a person; you are being measured as a visit, and only in aggregate.
        </p>
      </section>

      <section aria-labelledby="later">
        <h2 id="later">What it will be</h2>
        <p className="muted">
          One tap through a provider you already have, no password, and nothing asked beyond what
          that provider already tells us. Which providers appear first on the home page is itself
          one of the eleven things this site adapts — so the order you saw was chosen for you, and
          which one people reach for is exactly what decides which provider gets connected first.
        </p>
        <p>
          <a className="cta" href="/how-it-works">
            How the rest of it works
          </a>
        </p>
      </section>
    </main>
  );
}

function WhyOpen(): React.JSX.Element {
  return (
    <section aria-labelledby="why-open">
      <h2 id="why-open">Why the site stays open (D6)</h2>
      <p className="muted">
        Desire Path has no paywall, no metering, and no gated articles. Creating an account enables
        personalised adaptation and subscriptions to the upcoming digest, but you can read
        everything on this site without ever signing in.
      </p>
    </section>
  );
}

function YourData(): React.JSX.Element {
  return (
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
  );
}
