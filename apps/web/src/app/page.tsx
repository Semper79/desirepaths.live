/**
 * The home page.
 *
 * Sections are rendered in the order `layout.order` chose, and each section reads its
 * own surface's payload. Nothing here knows that variants exist — it asks the registry
 * for a typed payload and renders it, which is what keeps the optimiser and the markup
 * from having to know about each other.
 */

import { SURFACES, type FullAssignment } from '@morph/core';
import { faq, graph, serialiseJsonLd } from '@morph/seo';
import { headers } from 'next/headers';
import { assignmentForRequest } from '../lib/resolve.js';
import { motionAllowed, payloadOf, sectionOrder } from '../lib/render.js';
import { publishedContent } from '../lib/site.js';
import { FAQ_ITEMS } from '../lib/faq.js';

export default async function HomePage(): Promise<React.JSX.Element> {
  const resolved = await assignmentForRequest(await headers());
  const assignment = resolved.assignment;

  const sections: Record<string, React.JSX.Element> = {
    hero: <Hero key="hero" assignment={assignment} />,
    live_proof: (
      <LiveProof key="live_proof" assignment={assignment} resolvedSource={resolved.source} />
    ),
    trending: <Trending key="trending" />,
    how_it_works: <HowItWorks key="how_it_works" />,
    signup: <Signup key="signup" assignment={assignment} />,
    social_proof: <SocialProof key="social_proof" />,
  };

  return (
    <>
      {/*
        FAQ structured data — the highest-leverage answer-engine surface there is.
        Emitted from the same constant the markup renders, so the two cannot drift.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: serialiseJsonLd(graph([faq([...FAQ_ITEMS])])),
        }}
      />
      <main id="main" className="shell">
        {sectionOrder(assignment).map((name) => sections[name])}
      </main>
    </>
  );
}

// -----------------------------------------------------------------------------

function Hero({ assignment }: { readonly assignment: FullAssignment }): React.JSX.Element {
  const headline = payloadOf(assignment, 'hero.headline');
  const media = payloadOf(assignment, 'hero.media');
  const cta = payloadOf(assignment, 'cta.copy');
  const animate = motionAllowed(assignment) && !media.reducedMotionSafe;

  return (
    <section className="hero" aria-labelledby="hero-heading">
      <div className="stack">
        <h1 id="hero-heading">{headline.text}</h1>
        {headline.subtext !== undefined && <p className="muted">{headline.subtext}</p>}
        <p>
          <a className="cta" href="/join">
            {cta.text}
          </a>
        </p>
        {cta.supporting !== undefined && <p className="muted">{cta.supporting}</p>}
      </div>

      {/*
        `alt=""` marks a decorative treatment; a content image carries real alt text,
        and the registry's invariant refuses a variant that gets that wrong.
      */}
      {media.kind === 'image' && media.src !== undefined ? (
        <img className="hero-media" src={media.src} alt={media.alt} width={1600} height={1200} />
      ) : (
        <div
          className="hero-media"
          role={media.alt.length > 0 ? 'img' : 'presentation'}
          {...(media.alt.length > 0 ? { 'aria-label': media.alt } : { 'aria-hidden': true })}
          data-animate={animate ? 'true' : 'false'}
        />
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------

/**
 * The section that makes the product legible.
 *
 * A site that quietly rearranges itself is unsettling; a site that tells you it just
 * rearranged itself, and how, is the point. This is also the honest place to say when
 * a visitor is in the holdout cohort — they are seeing the un-adapted baseline, and
 * pretending otherwise would make the whole demonstration a lie.
 */
function LiveProof({
  assignment,
  resolvedSource,
}: {
  readonly assignment: FullAssignment;
  readonly resolvedSource: string;
}): React.JSX.Element {
  const palette = payloadOf(assignment, 'theme.palette');
  const typography = payloadOf(assignment, 'theme.typography');
  const density = payloadOf(assignment, 'layout.density');
  const motion = payloadOf(assignment, 'motion.intensity');

  return (
    <section aria-labelledby="live-heading">
      <h2 id="live-heading">What you are looking at right now</h2>
      <p className="muted">
        This page chose its own appearance before it was sent to you. Nothing was rearranged after
        it arrived.
      </p>

      <dl className="grid">
        <Fact label="Palette" value={palette.scheme === 'dark' ? 'dark' : 'light'} />
        <Fact label="Typography" value={typography.family} />
        <Fact label="Density" value={density.level} />
        <Fact label="Motion" value={motion.level} />
      </dl>

      {resolvedSource === 'holdout' && (
        <p className="muted">
          You are in the 5% holdout cohort: you are seeing the un-adapted baseline, so the lift of
          everything else stays measurable.
        </p>
      )}
      {resolvedSource === 'crawler' && (
        <p className="muted">
          Served the baseline, because this request looks automated. Crawlers always get the same
          page.
        </p>
      )}
    </section>
  );
}

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="card">
      <dt className="muted">{label}</dt>
      <dd style={{ margin: 0, fontSize: '1.25rem' }}>{value}</dd>
    </div>
  );
}

// -----------------------------------------------------------------------------

async function Trending(): Promise<React.JSX.Element> {
  const content = await publishedContent();
  return (
    <section aria-labelledby="trending-heading">
      <h2 id="trending-heading">What the web is saying</h2>
      <div className="grid">
        {content.map((item) => (
          <article className="card stack" key={item.slug}>
            <h3 style={{ fontSize: '1.125rem' }}>
              <a href={`/t/${item.slug}`}>{item.title}</a>
            </h3>
            <p className="muted">{item.summary}</p>
            <p className="muted">
              <time dateTime={item.publishedAt}>{item.publishedAt.slice(0, 10)}</time>
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------

function HowItWorks(): React.JSX.Element {
  return (
    <section aria-labelledby="how-heading">
      <h2 id="how-heading">How it works</h2>
      <div className="stack">
        {FAQ_ITEMS.map((item) => (
          <details key={item.question} className="card">
            <summary style={{ cursor: 'pointer', minHeight: 'var(--tap-min)' }}>
              {item.question}
            </summary>
            <p className="muted" style={{ marginBlockStart: 'var(--space-unit)' }}>
              {item.answer}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}

// -----------------------------------------------------------------------------

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
  discord: 'Continue with Discord',
  tiktok: 'Continue with TikTok',
  x: 'Continue with X',
  twitch: 'Continue with Twitch',
  instagram: 'Continue with Instagram',
  reddit: 'Continue with Reddit',
  spotify: 'Continue with Spotify',
  github: 'Continue with GitHub',
  email: 'Email me a link',
  passkey: 'Use a passkey',
};

function Signup({ assignment }: { readonly assignment: FullAssignment }): React.JSX.Element {
  const { order } = payloadOf(assignment, 'signup.providers_order');
  const lead = order.slice(0, 3);
  const rest = order.slice(3);

  return (
    <section aria-labelledby="signup-heading">
      <h2 id="signup-heading">Join</h2>
      <p className="muted">
        One tap. No password. We ask for nothing beyond what your provider already tells us.
      </p>

      <ul className="providers">
        {lead.map((provider) => (
          <li key={provider}>
            <a className="provider" href={`/api/auth/signin/${provider}`}>
              {PROVIDER_LABEL[provider] ?? provider}
            </a>
          </li>
        ))}
      </ul>

      {rest.length > 0 && (
        <details style={{ marginBlockStart: 'calc(var(--space-unit) * 2)' }}>
          <summary style={{ cursor: 'pointer', minHeight: 'var(--tap-min)' }}>
            Other ways to sign in
          </summary>
          <ul className="providers" style={{ marginBlockStart: 'var(--space-unit)' }}>
            {rest.map((provider) => (
              <li key={provider}>
                <a className="provider" href={`/api/auth/signin/${provider}`}>
                  {PROVIDER_LABEL[provider] ?? provider}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// -----------------------------------------------------------------------------

function SocialProof(): React.JSX.Element {
  const surfaceCount = Object.keys(SURFACES).length;
  const variantCount = Object.values(SURFACES).reduce((sum, s) => sum + s.variants.length, 0);

  return (
    <section aria-labelledby="proof-heading">
      <h2 id="proof-heading">By the numbers</h2>
      <div className="grid">
        <Fact label="Adaptive surfaces" value={String(surfaceCount)} />
        <Fact label="Variants in play" value={String(variantCount)} />
        <Fact label="Holdout cohort" value="5%" />
        <Fact label="Report cadence" value="hourly" />
      </div>
    </section>
  );
}
