import type { Metadata } from 'next';
import { pageMeta } from '@morph/seo';
import { siteIdentity } from '../../lib/site';

/**
 * Where the hero's call to action goes.
 *
 * It went nowhere until this existed. `hero.cta` is one of the eleven adaptive surfaces,
 * every variant of it points at `/join`, and the route had never been built — so the most
 * prominent control on the home page answered 404, on a site whose entire argument is that
 * it measures what visitors actually do. The sign-up surface below it was the same: every
 * provider linked to `/api/auth/signin/<provider>`, and no such route exists either.
 *
 * WHY THIS PAGE SAYS NO INSTEAD OF COLLECTING SOMETHING
 * The obvious move is an email box — capture the intent while it is here. That would make
 * this the first page on the site to collect personal data, and `docs/PRIVACY.md` describes
 * a system that holds none: a rotating daily anonymous hash and nothing else. One input
 * field would make the export and erasure endpoints, the retention policy and the Art. 13
 * notice all describe something slightly untrue, which is a worse trade than a visitor
 * reading one honest paragraph and coming back.
 *
 * Sign-up proper is Phase 4 in `docs/ROADMAP.md`, deferred by the operator. It needs OAuth
 * applications registered with each provider — which is the operator's to do, and which
 * takes days to weeks of review at some of them (D2).
 */

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/join',
    title: 'Joining Desire Path',
    description:
      'Sign-up is not open yet. What it will ask for, what it will not, and why the site works without it.',
  });

  return {
    title: 'Join',
    description: site.description,
    alternates: { canonical: meta.canonical },
    // Not indexed: a page whose entire content is "not yet" competes with the pages that
    // do explain the thing, and it will be rewritten the moment Phase 4 lands.
    robots: { index: false, follow: true },
  };
}

export default function JoinPage(): React.JSX.Element {
  return (
    <main id="main" className="shell">
      <section>
        <h1>Not open yet</h1>
        <p className="muted">
          Sign-up is the one part of Desire Path that has not been built. Everything else on this
          site is running: the page you came from picked its own headline, layout and wording for
          you, and <a href="/proof">/proof</a> shows what it has worked out so far.
        </p>
      </section>

      <section aria-labelledby="why">
        <h2 id="why">Why there is no email box here</h2>
        <p className="muted">
          Because it would be the first thing on this site to hold personal data. Desire Path
          currently keeps a rotating daily anonymous hash and nothing else — no account, no email
          address, no profile — and <a href="/privacy">the privacy notice</a> says so. One input
          field would make that sentence false, so it is not here. You are not being measured as a
          person; you are being measured as a visit, and only in aggregate.
        </p>
      </section>

      <section aria-labelledby="later">
        <h2 id="later">What it will be</h2>
        <p className="muted">
          One tap through a provider you already have, no password, and nothing asked beyond what
          that provider already tells us. Which providers appear first on the home page is itself
          one of the eleven things this site adapts — so the order you saw was chosen for you, and
          which one people reach for is exactly what decides the order the next visitor sees.
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
