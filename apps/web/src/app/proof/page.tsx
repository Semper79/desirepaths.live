/**
 * The evidence page.
 *
 * The numbers here are publishable because this site is the thing being optimised rather
 * than somebody else's site running the optimiser — see the note in `lib/proof.ts`.
 *
 * Designed to be screenshotted. One enormous number, then the findings ranked by how
 * convincing they are, then an honest account of what is still undecided. A page that
 * showed only the settled results would be a scoreboard; showing the undecided ones next
 * to them is what makes it evidence.
 *
 * Server-rendered, no client JavaScript, and every number comes from the same snapshot the
 * renderer used to serve this very page. There is no separate reporting path that could
 * flatter it, which is precisely why it can be published.
 */

import type { Metadata } from 'next';
import { dataset, graph, pageMeta, serialiseJsonLd, twitterCard } from '@morph/seo';
import { currentSnapshot } from '../../lib/resolve';
import { proofFrom, headline, measurements, format, type SettledSurface } from '../../lib/proof';
import { siteIdentity } from '../../lib/site';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = siteIdentity();
  const snapshot = await currentSnapshot();
  const proof = proofFrom(snapshot.arms, snapshot.generatedAt, snapshot.adaptationEnabled);

  const title = 'What this site has worked out about itself';

  /**
   * Generated from the live numbers rather than written once.
   *
   * This is the highest-leverage string in the codebase: it is what a search result shows,
   * what a shared link shows, and what an AI crawler is most likely to quote. A static
   * description would say the same thing in January and in June; this one says what is
   * true today, which is the only reason anyone would repeat it.
   *
   * Explicitly set on `openGraph` and `twitter` as well as at the top level — Next does
   * not propagate the page description into either, and the layout's site-wide one would
   * win by default. That is exactly the bug this page cannot afford.
   */
  const description = headline(proof);

  const meta = pageMeta({
    origin: site.origin,
    path: '/proof',
    title,
    description,
    siteName: site.name,
  });

  return {
    title,
    description,
    alternates: { canonical: meta.canonical },
    openGraph: { title, description, url: meta.canonical, type: 'website' },
    twitter: { card: twitterCard(meta), title, description },
  };
}

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * The spread of options on one surface, with the winner's error bar.
 *
 * The first version scaled the track to the winner's own credible interval, which was
 * technically correct and visually useless: with a large sample the interval is narrow, so
 * the mark sat pinned to the right-hand end of every row and said nothing. What a reader
 * wants is *how far apart the options were* — the winner's margin only means something
 * next to the alternatives it beat.
 *
 * So the track spans the surface's full range, every option gets a tick, and the winner
 * gets a band showing the 95% credible interval. When that band is narrow the site is
 * certain; when it overlaps a neighbouring tick, it is not — and that overlap is a more
 * honest statement of confidence than any number would be.
 *
 * Inline SVG, so it is in the first paint with no bundle and no layout shift.
 */
function Spread({ row }: { row: SettledSurface }) {
  const [low, high] = row.interval;
  const rewards = row.options.map((option) => option.reward);
  const min = Math.min(...rewards, low);
  const max = Math.max(...rewards, high);

  // A little air at each end so a tick at the extreme is not clipped by the viewBox, and a
  // floor on the span so two nearly identical options do not produce a division by zero.
  const span = Math.max(max - min, 1e-6) * 1.18;
  const origin = min - Math.max(max - min, 1e-6) * 0.09;
  const at = (value: number): number => ((value - origin) / span) * 100;

  return (
    <svg
      viewBox="0 0 100 14"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${row.winner} scored ${percent(row.reward)}, with 95% confidence between ${percent(low)} and ${percent(high)}. The other options scored ${row.options
        .slice(1)
        .map((option) => percent(option.reward))
        .join(', ')}.`}
      style={{ width: '100%', height: 14, display: 'block', overflow: 'visible' }}
    >
      <rect x={0} y={6.4} width={100} height={1.2} fill="var(--color-border)" opacity={0.3} />

      {row.options.slice(1).map((option) => (
        <rect
          key={option.variantId}
          x={at(option.reward) - 0.25}
          y={4}
          width={0.5}
          height={6}
          fill="var(--color-text-muted)"
          opacity={0.7}
        />
      ))}

      <rect
        x={at(low)}
        y={5.2}
        width={Math.max(at(high) - at(low), 0.8)}
        height={3.6}
        rx={1.8}
        fill="var(--color-accent)"
        opacity={0.3}
      />
      <rect
        x={at(row.reward) - 0.35}
        y={2.6}
        width={0.7}
        height={8.8}
        rx={0.35}
        fill="var(--color-accent)"
      />
    </svg>
  );
}

function Finding({ row, settled }: { row: SettledSurface; settled: boolean }) {
  return (
    <li
      style={{
        listStyle: 'none',
        padding: '22px 0',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--color-text-muted)' }}>
            {row.description}
          </p>
          <p style={{ margin: 0, fontSize: 17 }}>
            <code style={{ fontSize: 15 }}>{row.winner}</code>
          </p>
        </div>

        <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <p
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 30,
              letterSpacing: 'var(--tracking-display)',
              color: settled ? 'var(--color-accent)' : 'var(--color-text)',
            }}
          >
            {settled ? `+${String(Math.round(row.marginOverWorst * 100))}%` : percent(row.reward)}
          </p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--color-text-muted)' }}>
            {settled
              ? 'over the weakest option'
              : `${percent(row.challengerChance, 0)} chance it is wrong`}
          </p>
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <Spread row={row} />
        <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
          {format(row.impressions)} visits · {row.liveVariants} options tried · reward between{' '}
          {percent(row.interval[0])} and {percent(row.interval[1])}
        </p>
      </div>
    </li>
  );
}

export default async function ProofPage() {
  const site = siteIdentity();
  const snapshot = await currentSnapshot();
  const proof = proofFrom(snapshot.arms, snapshot.generatedAt, snapshot.adaptationEnabled);
  const nothingYet = proof.settled.length === 0 && proof.stillDeciding.length === 0;

  const structured = serialiseJsonLd(
    graph([
      dataset(
        {
          origin: site.origin,
          name: site.name,
          description: site.description,
          logoUrl: site.logoUrl,
        },
        {
          url: `${site.origin}/proof`,
          name: 'What Desire Path has worked out about its own design',
          description: headline(proof),
          measuredAt: new Date(
            proof.generatedAt === 0 ? Date.now() : proof.generatedAt,
          ).toISOString(),
          measurements: measurements(proof),
        },
      ),
    ]),
  );

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structured }} />
      {/*
        `main#main` because the layout renders a "Skip to content" link pointing at it, and
        every other page provides one. This page did not, so the skip link led nowhere —
        a broken skip link is worse than no skip link, since a screen-reader user who
        follows it lands back at the top with no way to tell that it failed. Found by
        checking the landmark structure rather than by reading the markup.

        `.shell` carries the site's standard gutter, which is why the hand-rolled padding
        that used to be here is gone: two sources for one measurement is how a page drifts
        away from the rest of the site one release at a time.
      */}
      <main id="main" className="shell">
        <article
          style={{
            maxWidth: 'var(--measure)',
            marginInline: 'auto',
            paddingBlock: 'clamp(32px, 6vw, 72px) 96px',
          }}
        >
          <header style={{ marginBottom: 48 }}>
            <p
              style={{
                margin: '0 0 12px',
                fontSize: 13,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--color-accent)',
              }}
            >
              Evidence
            </p>

            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(34px, 7vw, 58px)',
                lineHeight: 1.05,
                letterSpacing: 'var(--tracking-display)',
                margin: '0 0 20px',
              }}
            >
              What this site has worked out about itself.
            </h1>

            <p
              style={{
                fontSize: 18,
                lineHeight: 1.55,
                margin: 0,
                color: 'var(--color-text-muted)',
              }}
            >
              {headline(proof)}
            </p>
          </header>

          {nothingYet ? (
            <p
              style={{
                padding: '20px 22px',
                border: '1px solid var(--color-border)',
                borderRadius: 12,
                color: 'var(--color-text-muted)',
                lineHeight: 1.6,
              }}
            >
              Nothing yet. The engine folds an hour of measured behaviour into its posteriors every
              hour, and until it has done that at least once, every part of this page would be a
              guess. It says so rather than showing a plausible chart.
            </p>
          ) : null}

          {proof.settled.length > 0 ? (
            <section style={{ marginBottom: 56 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>
                Settled
              </h2>
              <p style={{ margin: '0 0 8px', color: 'var(--color-text-muted)', fontSize: 15 }}>
                Decisions where the evidence has stopped being ambiguous — under a 5% chance the
                runner-up is actually better. The same bar the engine uses before it retires
                anything.
              </p>
              <ul style={{ padding: 0, margin: 0 }}>
                {proof.settled.map((row) => (
                  <Finding key={row.key} row={row} settled />
                ))}
              </ul>
            </section>
          ) : null}

          {proof.stillDeciding.length > 0 ? (
            <section style={{ marginBottom: 56 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>
                Still deciding
              </h2>
              <p style={{ margin: '0 0 8px', color: 'var(--color-text-muted)', fontSize: 15 }}>
                Currently being served the leader, without enough evidence to call it. Shown because
                a page with only the settled results would be a scoreboard rather than evidence.
              </p>
              <ul style={{ padding: 0, margin: 0 }}>
                {proof.stillDeciding.map((row) => (
                  <Finding key={row.key} row={row} settled={false} />
                ))}
              </ul>
            </section>
          ) : null}

          {proof.notYetMeasured.length > 0 ? (
            <section style={{ marginBottom: 56 }}>
              <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>
                Not yet measured
              </h2>
              <p style={{ margin: '0 0 12px', color: 'var(--color-text-muted)', fontSize: 15 }}>
                {proof.notYetMeasured.length} surfaces with no live comparison running — either no
                evidence has arrived yet, or every option but one has already been retired.
              </p>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--color-text-muted)' }}>
                {proof.notYetMeasured.map((key) => (
                  <code key={key} style={{ marginRight: 14, display: 'inline-block' }}>
                    {key}
                  </code>
                ))}
              </p>
            </section>
          ) : null}

          <footer
            style={{
              borderTop: '1px solid var(--color-border)',
              paddingTop: 24,
              color: 'var(--color-text-muted)',
              fontSize: 14,
              lineHeight: 1.6,
            }}
          >
            <p style={{ margin: '0 0 10px' }}>
              Every number here comes from the same decision set that rendered this page. There is
              no separate reporting path, which is why it can be published at all.
            </p>
            <p style={{ margin: 0 }}>
              Five per cent of visitors are pinned to an un-adapted baseline and never counted in
              the figures above — that cohort is how the site measures itself against not adapting.
              Measurement is anonymous, first-party and cookieless;{' '}
              <a href="/privacy" style={{ color: 'var(--color-accent)' }}>
                the privacy page
              </a>{' '}
              says exactly what is collected.{' '}
              <a href="/live" style={{ color: 'var(--color-accent)' }}>
                See what you were served
              </a>{' '}
              or{' '}
              <a href="/changes" style={{ color: 'var(--color-accent)' }}>
                follow what it changes
              </a>
              .
            </p>
          </footer>
        </article>
      </main>
    </>
  );
}
