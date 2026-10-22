import type { Metadata } from 'next';
import { faq, graph, pageMeta, serialiseJsonLd } from '@morph/seo';
import { FAQ_ITEMS } from '../../lib/faq';
import { siteIdentity } from '../../lib/site';

/**
 * The explanation page.
 *
 * It carries the FAQ structured data as well as the home page, because this is the URL
 * a search result or an answer engine is most likely to land on for a "how does X work"
 * query — and the markup has to be on the page that answers the question, not only on
 * the one that mentions it.
 */

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/how-it-works',
    title: 'How Desire Path works',
    description:
      'Eleven adaptive surfaces, a contextual bandit, a pinned holdout cohort, and the guardrails that stop the optimiser doing something clever and wrong.',
  });
  return {
    title: 'How it works',
    description: site.description,
    alternates: { canonical: meta.canonical },
  };
}

export default function HowItWorksPage(): React.JSX.Element {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serialiseJsonLd(graph([faq([...FAQ_ITEMS])])) }}
      />
      <main id="main" className="shell">
        <section>
          <h1>How it works</h1>
          <p className="muted">
            Desire Path changes eleven things about itself and measures what happens. This page says
            exactly which things, how the decision is made, and how you can tell whether any of it
            is working.
          </p>
        </section>

        <section aria-labelledby="questions">
          <h2 id="questions">Questions</h2>
          <div className="stack">
            {FAQ_ITEMS.map((item) => (
              <article className="card" key={item.question}>
                <h3 style={{ fontSize: '1.125rem' }}>{item.question}</h3>
                <p className="muted">{item.answer}</p>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="guardrails">
          <h2 id="guardrails">What stops it going wrong</h2>
          <div className="grid">
            <article className="card">
              <h3 style={{ fontSize: '1rem' }}>A pinned holdout</h3>
              <p className="muted">
                Five percent of visitors never see an adaptation. Every individual comparison the
                engine makes is against the current champion, so the whole system could drift
                somewhere worse while every comparison reports a win. The holdout is the only
                defence against that.
              </p>
            </article>
            <article className="card">
              <h3 style={{ fontSize: '1rem' }}>Always-valid statistics</h3>
              <p className="muted">
                A conventional p-value is only valid if you look once. Desire Path looks
                continuously, so it uses a sequential test that stays valid at every sample size —
                you may stop whenever you like and the error rate holds.
              </p>
            </article>
            <article className="card">
              <h3 style={{ fontSize: '1rem' }}>An accessibility gate</h3>
              <p className="muted">
                Every colour combination is contrast-checked before a variant can be served, and a
                variant that fails is rejected rather than ranked lower. Accessibility is not
                something the optimiser is allowed to trade away.
              </p>
            </article>
            <article className="card">
              <h3 style={{ fontSize: '1rem' }}>Automatic rollback</h3>
              <p className="muted">
                A variant whose Core Web Vitals, error rate or bounce rate breach a threshold is
                quarantined immediately, on a signal separate from the reward — because a variant
                can convert well in the short window before anyone notices it is slow.
              </p>
            </article>
          </div>
        </section>
      </main>
    </>
  );
}
