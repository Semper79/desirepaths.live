/**
 * What the site has changed about itself, most recent first.
 *
 * `/proof` says what it currently believes; this says when it changed its mind, which is
 * the half with a narrative in it. "This website just retired one of its own headlines,
 * and here is the statistic that killed it" is content the machine produces by operating,
 * with no model and no editorial calendar behind it.
 *
 * Every entry keeps the reason written when the decision was made, verbatim. Rewriting
 * them into something friendlier would put a gap between what the operator was told and
 * what the public was told, and this page exists precisely because there is no such gap.
 */

import type { Metadata } from 'next';
import { pageMeta } from '@morph/seo';
import { changesFrom, summarise, type Change } from '../../lib/changes.js';
import { recentAdaptations } from '../../lib/db.js';
import { siteIdentity } from '../../lib/site.js';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const site = siteIdentity();
  const changes = changesFrom(await recentAdaptations());
  const title = 'What this site has changed about itself';
  const description = summarise(changes, Date.now());

  const meta = pageMeta({
    origin: site.origin,
    path: '/changes',
    title,
    description,
    siteName: site.name,
  });

  return {
    title,
    description,
    // No `types` override: a page-level one replaces the layout's outright, which would
    // have made this the only page on the site where the writing feed is undiscoverable.
    alternates: { canonical: meta.canonical },
    openGraph: { title, description, url: meta.canonical, type: 'website' },
    twitter: { card: 'summary_large_image', title, description },
  };
}

const TONE: Readonly<Record<Change['action'], string>> = {
  retired: 'var(--color-text-muted)',
  quarantined: 'var(--color-accent)',
  promoted: 'var(--color-accent)',
  generated: 'var(--color-text-muted)',
  other: 'var(--color-text-muted)',
};

function when(occurredAt: number, now: number): string {
  const hours = Math.max(0, Math.round((now - occurredAt) / 3_600_000));
  if (hours < 1) return 'just now';
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

export default async function ChangesPage() {
  const now = Date.now();
  const changes = changesFrom(await recentAdaptations());

  return (
    <main id="main" className="shell">
      <article
        style={{
          maxWidth: 'var(--measure)',
          marginInline: 'auto',
          paddingBlock: 'clamp(32px, 6vw, 72px) 96px',
        }}
      >
        <header style={{ marginBottom: 44 }}>
          <p
            style={{
              margin: '0 0 12px',
              fontSize: 13,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-accent)',
            }}
          >
            Changelog
          </p>

          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(32px, 6.5vw, 54px)',
              lineHeight: 1.06,
              letterSpacing: 'var(--tracking-display)',
              margin: '0 0 18px',
            }}
          >
            What this site has changed about itself.
          </h1>

          <p
            style={{
              fontSize: 18,
              lineHeight: 1.55,
              margin: '0 0 14px',
              color: 'var(--color-text-muted)',
            }}
          >
            {summarise(changes, now)}
          </p>

          <p style={{ margin: 0, fontSize: 15 }}>
            <a href="/changes.xml" style={{ color: 'var(--color-accent)' }}>
              Subscribe to the feed
            </a>{' '}
            <span style={{ color: 'var(--color-text-muted)' }}>
              — nobody writes these. They are what the engine did.
            </span>
          </p>
        </header>

        {changes.length === 0 ? (
          <p
            style={{
              padding: '20px 22px',
              border: '1px solid var(--color-border)',
              borderRadius: 12,
              color: 'var(--color-text-muted)',
              lineHeight: 1.6,
            }}
          >
            Nothing recorded yet. The engine only changes something when the evidence crosses the
            same threshold it would need to retire a variant, and it has not reached that on any
            surface so far. This page stays empty rather than showing an example of what one would
            look like.
          </p>
        ) : (
          <ol style={{ padding: 0, margin: 0, listStyle: 'none' }}>
            {changes.map((change) => (
              <li
                key={change.id}
                style={{ padding: '22px 0', borderTop: '1px solid var(--color-border)' }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    justifyContent: 'space-between',
                    alignItems: 'baseline',
                    flexWrap: 'wrap',
                  }}
                >
                  <h2
                    style={{
                      fontFamily: 'var(--font-display)',
                      fontSize: 19,
                      margin: 0,
                      color: TONE[change.action],
                    }}
                  >
                    {change.title}
                  </h2>
                  <time
                    dateTime={new Date(change.occurredAt).toISOString()}
                    style={{ fontSize: 13, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}
                  >
                    {when(change.occurredAt, now)}
                  </time>
                </div>

                <p style={{ margin: '8px 0 0', lineHeight: 1.6 }}>{change.detail}</p>

                <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--color-text-muted)' }}>
                  <code>{change.surfaceId}</code>
                  {change.impressions === null
                    ? null
                    : ` · ${change.impressions.toLocaleString('en-GB')} visits behind the decision`}
                </p>
              </li>
            ))}
          </ol>
        )}

        <footer
          style={{
            borderTop: '1px solid var(--color-border)',
            marginTop: 40,
            paddingTop: 24,
            color: 'var(--color-text-muted)',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          <p style={{ margin: 0 }}>
            Each reason above is the one written when the decision was made, kept word for word —
            there is no friendlier version for the public. What the site currently believes is on{' '}
            <a href="/proof" style={{ color: 'var(--color-accent)' }}>
              the evidence page
            </a>
            .
          </p>
        </footer>
      </article>
    </main>
  );
}
