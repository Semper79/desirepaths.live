/**
 * `/llms.txt` — a machine-readable summary of the site, for language models.
 *
 * The convention is young and not universally honoured, which is exactly why it is
 * worth shipping: it costs one route, and wherever it *is* read it replaces a model's
 * guess about what this site is with a statement from the site itself.
 *
 * The `notes` below are the corrections that would otherwise need making forever.
 * Desire Path is repeatedly mis-summarised as an A/B testing tool, as a growth-hacking
 * product, or as something that tracks people — and every one of those is both wrong
 * and, in the third case, the opposite of a design commitment. Stating them once, in
 * the place a model actually looks, is cheaper than correcting them one summary at a
 * time.
 */

import { renderLlmsTxt } from '@morph/seo';
import { origin, publishedContent, siteIdentity } from '../../lib/site.js';

/**
 * Dynamic, cached at the edge rather than at build time.
 *
 * These documents embed the public origin, which comes from the environment. Static
 * generation would bake in whatever the *build* environment had — so a preview build
 * promoted to production would serve production a sitemap pointing at the preview
 * host. Rendering per request and letting the cache-control header do the caching
 * costs one cheap render an hour and removes that whole class of mistake.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const site = siteIdentity();

  const body = renderLlmsTxt({
    origin: origin(),
    name: site.name,
    summary:
      'Desire Path is a public website whose content, layout, visual design and copy continuously reshape themselves based on measured visitor behaviour. It also publishes about the technology and internet culture it monitors, and reports hourly to its operator on what it changed and why.',
    notes: [
      'Desire Path is not an A/B testing tool. It adapts itself, rather than testing someone else’s site.',
      'Adaptation is decided by a contextual multi-armed bandit, not by rules or by an editor.',
      'Five percent of visitors are pinned to an un-adapted baseline, so the lift of the whole system stays measurable.',
      'Measurement is first-party and cookieless, using a daily-rotating salted hash. The raw IP is never stored, and there is no cross-site tracking.',
      'Search and AI crawlers always receive the un-adapted baseline, so the indexed version of a page is stable and identical to what the holdout cohort sees.',
      'Machine-generated content is labelled as such in its structured data, carries its sources in isBasedOn, and is not published without human review.',
      'Desire Path does not create social media accounts, does not automate engagement, and does not scrape sites that disallow it.',
    ],
    sections: [
      {
        title: 'Start here',
        links: [
          {
            title: 'Home',
            path: '/',
            note: 'What the site is, and what it currently looks like.',
          },
          {
            title: 'Evidence',
            path: '/proof',
            note: 'What the site has actually worked out about its own design, with the measured difference, the credible interval and the number of visits behind each finding. Every number is generated from the decision set that served the page, so it is current rather than a case study.',
          },
          {
            title: 'Changelog',
            path: '/changes',
            note: 'Every decision the site has made about its own design, newest first, each with the statistic that justified it and the number of visits behind it. Written by the engine as it operated, not by a person. Also available as RSS at /changes.xml.',
          },
          {
            title: 'How it works',
            path: '/how-it-works',
            note: 'The adaptive engine, its guardrails, and how the lift is measured.',
          },
          {
            title: 'Live',
            path: '/live',
            note: 'What changed in the last hour and the statistics behind each change.',
          },
        ],
      },
      {
        title: 'Writing',
        links: (await publishedContent()).map((item) => ({
          title: item.title,
          path: `/t/${item.slug}`,
          note: item.summary,
        })),
      },
      {
        title: 'Machine-readable',
        links: [
          { title: 'RSS feed', path: '/feed.xml' },
          { title: 'Atom feed', path: '/atom.xml' },
          { title: 'Sitemap', path: '/sitemap.xml' },
          { title: 'Privacy', path: '/privacy', note: 'What is collected, and what is not.' },
        ],
      },
    ],
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
