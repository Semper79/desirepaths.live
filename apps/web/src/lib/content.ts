/**
 * What a published article is, and what the site falls back to before there is one.
 *
 * Pure: the shape, the mapping from a database row, and the development seed. The query
 * that produces those rows is in `db.ts`, which is the only file here that opens a
 * connection — so the decisions in this one are testable without a database, and that
 * one has nothing in it to get wrong.
 */

import { parseContentBody, type ContentBody, type ContentSource } from '@morph/core';

export interface PublishedArticle {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: ContentBody;
  readonly publishedAt: string;
  readonly modifiedAt?: string;
  readonly keywords: readonly string[];
  readonly sources: readonly ContentSource[];
  readonly generatedBy?: string;
  readonly reviewedBy?: string;
}

/** What a row looks like on the way out of the query. */
export interface ContentRow {
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly body: unknown;
  readonly sources: readonly ContentSource[];
  readonly generatedBy: string | null;
  readonly reviewedBy: string | null;
  readonly publishedAt: Date | null;
  readonly updatedAt: Date;
}

/**
 * A row, as the page wants it.
 *
 * Separate from the query so the decisions in it — which date wins, when a modified date
 * is worth emitting, what a missing summary becomes — are testable without a database.
 * The query above is then one statement with nothing to get wrong.
 */
export function toArticle(row: ContentRow): PublishedArticle {
  // A published row should always have `published_at`, but the column is nullable and a
  // date is required by the structured data. Falling back to `updated_at` produces a
  // plausible date rather than an invalid one in every consumer.
  const publishedAt = (row.publishedAt ?? row.updatedAt).toISOString();
  const modifiedAt = row.updatedAt.toISOString();

  return {
    slug: row.slug,
    title: row.title,
    summary: row.summary ?? '',
    body: parseContentBody(row.body),
    publishedAt,
    // Only when it differs: `dateModified` equal to `datePublished` is noise in the
    // structured data and tells a crawler nothing.
    ...(modifiedAt === publishedAt ? {} : { modifiedAt }),
    // Not a column. Keywords were a property of the hand-written set; generated pieces
    // carry their topic in `trend_signal.label`, and wiring that through is a join this
    // page does not need yet. An empty list is honest; an invented one is not.
    keywords: [],
    sources: row.sources,
    ...(row.generatedBy === null ? {} : { generatedBy: row.generatedBy }),
    ...(row.reviewedBy === null ? {} : { reviewedBy: row.reviewedBy }),
  };
}

/**
 * The development seed.
 *
 * Two real pieces about the system itself, which is what the site is about (D1). They
 * exist so every serialisation path has something to serialise before the pipeline has
 * published anything.
 */
const SEED: readonly PublishedArticle[] = [
  {
    slug: 'how-this-site-rebuilds-itself',
    title: 'How this site rebuilds itself',
    summary:
      'Eleven surfaces, a contextual bandit, and a set of guardrails whose job is to stop the optimiser from doing something clever and wrong.',
    body: {
      blocks: [
        {
          type: 'paragraph',
          text: 'Every visitor to this page is served one of several versions of it. Which version depends on what has worked for visitors who arrived the same way, on the same kind of device, at the same time of day.',
        },
        { type: 'heading', text: 'What adapts' },
        {
          type: 'list',
          items: [
            'The palette, typography and spacing, as design tokens on the root element',
            'The headline, the sub-headline and the call to action',
            'The order of the sign-up providers',
          ],
        },
        {
          type: 'paragraph',
          text: 'The decision happens in edge middleware before the page renders, so the HTML that leaves the server is already the right one. There is no flash, because a flash is a layout shift, and layout shift is one of the metrics the optimiser is judged on.',
        },
      ],
    },
    publishedAt: '2026-08-01T09:00:00.000Z',
    keywords: ['adaptive design', 'multi-armed bandit', 'web'],
    sources: [
      {
        url: 'https://arxiv.org/abs/1003.0146',
        title: 'A Contextual-Bandit Approach to Personalized News Article Recommendation',
        publisher: 'Li, Chu, Langford, Schapire',
      },
    ],
  },
  {
    slug: 'always-valid-p-values',
    title: 'Why looking at your experiment is allowed',
    summary:
      'A fixed-horizon p-value is only valid if you look once. An adaptive system looks continuously, which is why it needs a test built for that.',
    body: {
      blocks: [
        {
          type: 'paragraph',
          text: 'A classical p-value assumes you decided the sample size in advance and looked exactly once. Peek early, stop when it looks good, and the false-positive rate is no longer the number written on the tin.',
        },
        {
          type: 'paragraph',
          text: 'An adaptive system peeks constantly — that is what adapting is. The fix is a test whose guarantee holds at every stopping time rather than at one, which is what a mixture sequential probability ratio test provides.',
        },
      ],
    },
    publishedAt: '2026-08-12T09:00:00.000Z',
    keywords: ['statistics', 'sequential testing', 'experimentation'],
    sources: [
      {
        url: 'https://arxiv.org/abs/1512.04922',
        title: 'Always Valid Inference: Continuous Monitoring of A/B Tests',
        publisher: 'Johari, Pekelis, Walsh',
      },
    ],
  },
];

/** Exported for the tests, so the fallback's shape is asserted rather than assumed. */
export const SEED_CONTENT = SEED;
