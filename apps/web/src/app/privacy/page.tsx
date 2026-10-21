import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { categoriesOf, controllerFrom } from '@morph/core';
import { pageMeta } from '@morph/seo';
import { maskFromCookieHeader } from '../../lib/consent.js';
import { siteIdentity } from '../../lib/site.js';

/**
 * The privacy page, and the place a choice can be changed.
 *
 * Withdrawing is a form POST to the same endpoint the banner uses — no script, no
 * modal, no third-party consent platform. A withdrawal that is harder than the original
 * consent is not a withdrawal.
 *
 * THE CONTROLLER SECTION IS LOAD-BEARING (D4)
 * Art. 13 requires the controller's identity and contact details before any processing.
 * When they are not configured this page says so in those words rather than rendering a
 * placeholder, because the collector is genuinely refusing events in that state — so the
 * sentence "nothing about you is being recorded" is true rather than reassuring. The two
 * halves are wired to the same check in `@morph/core`; they cannot disagree.
 */

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/privacy',
    title: 'Privacy',
    description: 'What Desire Path measures, what it never collects, and how to change your mind.',
  });
  return { title: 'Privacy', alternates: { canonical: meta.canonical } };
}

export default async function PrivacyPage(): Promise<React.JSX.Element> {
  const cookie = (await headers()).get('cookie') ?? '';
  const mask = maskFromCookieHeader(cookie);

  // Read per request rather than at module scope: on Workers these come from `env`, which
  // only exists inside a request. A module-level read would find nothing and then cache
  // that nothing for the life of the isolate — a privacy page permanently claiming the
  // controller is unconfigured on a deployment where it is.
  const controller = controllerFrom({
    MORPH_CONTROLLER_NAME: process.env['MORPH_CONTROLLER_NAME'],
    MORPH_CONTROLLER_ADDRESS: process.env['MORPH_CONTROLLER_ADDRESS'],
    MORPH_CONTROLLER_EMAIL: process.env['MORPH_CONTROLLER_EMAIL'],
    MORPH_CONTROLLER_DPO_EMAIL: process.env['MORPH_CONTROLLER_DPO_EMAIL'],
  });

  return (
    <main id="main" className="shell">
      <section>
        <h1>Privacy</h1>
        <p className="muted">
          The short version: Desire Path measures behaviour, not people. Everything below is how —
          and the engineering behind each claim is in the repository rather than in a policy nobody
          reads.
        </p>
      </section>

      <section aria-labelledby="collected">
        <h2 id="collected">What is collected</h2>
        <ul className="muted" style={{ maxWidth: 'var(--measure)' }}>
          <li>Which page you looked at, how far you scrolled, how long the tab was visible.</li>
          <li>Which variant of the site you were shown, so the measurement means something.</li>
          <li>Device class, viewport size, country, referrer class, and the hour of the week.</li>
          <li>Core Web Vitals — how fast the page actually was for you.</li>
        </ul>

        <h2>What is never collected</h2>
        <ul className="muted" style={{ maxWidth: 'var(--measure)' }}>
          <li>
            Your IP address. It is hashed inside the edge process and discarded; it is never stored
            and never logged.
          </li>
          <li>Mouse movement, keystrokes, clipboard, form contents, or session recordings.</li>
          <li>Anything from a third-party analytics or advertising service. There are none.</li>
          <li>Any identifier that works across sites, or that survives more than a day.</li>
        </ul>
      </section>

      <section aria-labelledby="identifier">
        <h2 id="identifier">The identifier</h2>
        <p className="muted">
          Measurement uses a hash of a server-side secret, a salt that changes every day, your IP
          address and your user agent, truncated to 128 bits. Because the salt rotates, the previous
          day&apos;s identifier cannot be recomputed for the same visitor even with full access to
          the database. That is what bounds this to a single day, and it is also why an erasure
          request reaches exactly the 90 days of raw data that are kept.
        </p>
      </section>

      <section aria-labelledby="choice">
        <h2 id="choice">Your choice</h2>
        <p className="muted">
          Currently: <strong>{categoriesOf(mask).join(', ')}</strong>.
        </p>

        <form
          method="post"
          action="/api/consent"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-unit)' }}
        >
          <input type="hidden" name="next" value="/privacy" />
          <button className="cta" type="submit" name="choice" value="necessary">
            Only what is necessary
          </button>
          <button className="cta" type="submit" name="choice" value="analytics">
            Anonymous measurement
          </button>
          <button className="cta" type="submit" name="choice" value="all">
            Measurement and personalisation
          </button>
        </form>

        <p className="muted" style={{ marginTop: 'calc(var(--space-unit) * 2)' }}>
          Choosing the first pins you to the same un-adapted baseline that 5% of visitors see
          permanently. The site does not degrade: that baseline is a known-good experience, not a
          punishment.
        </p>
      </section>

      <section aria-labelledby="rights">
        <h2 id="rights">Your rights</h2>
        <p className="muted">
          With an account you can export everything held about you, or have it erased, from your
          settings. Both are answered within 30 days and in practice within minutes. Raw behavioural
          data is deleted after 90 days regardless; what remains after that carries no identifier
          and cannot be traced to anyone — a statement about the data rather than a refusal.
        </p>
      </section>

      <section aria-labelledby="controller">
        <h2 id="controller">Who is responsible</h2>
        {controller === null ? (
          <p
            className="muted"
            style={{
              border: '1px solid var(--color-accent)',
              borderRadius: 12,
              padding: '16px 18px',
              maxWidth: 'var(--measure)',
            }}
          >
            <strong>This deployment has no data controller configured.</strong> It is therefore not
            measuring anybody: the collector refuses events and the readiness probe refuses the
            deployment. If you are seeing this on a public site, nothing about you is being recorded
            — which is the only honest thing a page can say in this state.
          </p>
        ) : (
          <>
            <p className="muted" style={{ maxWidth: 'var(--measure)' }}>
              The data controller is <strong>{controller.name}</strong>, {controller.address}.
            </p>
            <p className="muted" style={{ maxWidth: 'var(--measure)' }}>
              To ask what is held about you, to have it erased, or to object to the processing,
              write to{' '}
              <a href={`mailto:${controller.email}`} style={{ color: 'var(--color-accent)' }}>
                {controller.email}
              </a>
              . There is no form and no ticket system in front of it.
              {controller.dpoEmail === undefined ? null : (
                <>
                  {' '}
                  The data protection officer can be reached at{' '}
                  <a
                    href={`mailto:${controller.dpoEmail}`}
                    style={{ color: 'var(--color-accent)' }}
                  >
                    {controller.dpoEmail}
                  </a>
                  .
                </>
              )}
            </p>
            <p className="muted" style={{ maxWidth: 'var(--measure)' }}>
              You can also complain to your national supervisory authority. In Italy that is the{' '}
              <a
                href="https://www.garanteprivacy.it"
                rel="noopener"
                style={{ color: 'var(--color-accent)' }}
              >
                Garante per la protezione dei dati personali
              </a>
              ; elsewhere in the EU it is the equivalent body where you live.
            </p>
          </>
        )}
      </section>

      <section aria-labelledby="where">
        <h2 id="where">Where this runs</h2>
        <p className="muted" style={{ maxWidth: 'var(--measure)' }}>
          On Cloudflare's network, which means your request is handled at whichever of their
          locations is nearest to you — and that can be outside the EU. What reaches storage does
          not depend on where that happened: your IP address is hashed inside the process that
          received it and the original is discarded before anything is written. There is no database
          row, anywhere, that contains it.
        </p>
      </section>
    </main>
  );
}
