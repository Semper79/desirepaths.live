import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { SURFACES, SURFACE_KEYS } from '@morph/core';
import { pageMeta } from '@morph/seo';
import { assignmentForRequest } from '../../lib/resolve';
import { siteIdentity } from '../../lib/site';

/**
 * The transparency page: exactly what this visitor was served, and why.
 *
 * `reasons` comes straight from the decision function, so this page cannot describe a
 * decision the engine did not make — it reads the same object the renderer used. The
 * site-wide adaptation log (what changed in the last hour) joins it once the worker is
 * writing to it in Phase 5.
 */

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/live',
    title: 'What Desire Path chose for you',
    description:
      'The exact variant of every adaptive surface you were served, and the reason for each.',
  });
  return { title: 'Live', alternates: { canonical: meta.canonical } };
}

const REASON_TEXT: Readonly<Record<string, string>> = {
  pinned: 'An operator pinned this variant.',
  adaptation_paused: 'Adaptation is paused; frozen on the current champion.',
  no_consent: 'You have not consented to measurement, so you get the baseline.',
  holdout: 'You are in the holdout cohort, which never adapts.',
  forced_exploration: 'Chosen at random — the exploration floor, so the engine keeps learning.',
  thompson: 'Chosen by Thompson sampling over the posteriors.',
  contextual: 'Chosen by the contextual model, given your device, referrer and time of week.',
  baseline_fallback: 'No variants were eligible, so the baseline was served.',
  sticky: 'Kept from your previous visit, so the site does not flicker between visits.',
  'crawler: baseline served for index stability':
    'This request looks automated, so it gets the baseline — the same page every crawler sees.',
  'no analytics consent': 'You have not consented to measurement, so you get the baseline.',
};

export default async function LivePage(): Promise<React.JSX.Element> {
  const resolved = await assignmentForRequest(await headers());

  return (
    <main id="main" className="shell">
      <section>
        <h1>What you were served</h1>
        <p className="muted">
          Every adaptive surface on this site, the variant you got, and why. This is read from the
          same decision the renderer used, so it cannot describe something that did not happen.
        </p>
        {resolved.isHoldout && (
          <p className="muted">
            You are in the 5% holdout cohort. You see the un-adapted baseline permanently, which is
            what makes the lift of everything else measurable.
          </p>
        )}
      </section>

      <section aria-labelledby="surfaces">
        <h2 id="surfaces">Surfaces</h2>
        <div className="stack">
          {SURFACE_KEYS.map((key) => {
            const reason = resolved.reasons[key] ?? 'baseline_fallback';
            return (
              <article className="card" key={key}>
                <h3 style={{ fontSize: '1rem' }}>{SURFACES[key].description}</h3>
                <p className="muted" style={{ marginBottom: 'var(--space-unit)' }}>
                  <code>{resolved.assignment[key]}</code>
                </p>
                <p className="muted">{REASON_TEXT[reason] ?? reason}</p>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
