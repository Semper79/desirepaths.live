/**
 * JSON-LD structured data.
 *
 * Two audiences, and they want different things:
 *
 *  - **Search engines** want entities and relationships: what is this page, who made
 *    it, when, what does it link to.
 *  - **Answer engines** want the same entities plus something they can quote. An LLM
 *    summarising a page reaches for the structured summary before the prose, and an
 *    `Article` with a real `abstract` and a resolvable `isBasedOn` gets cited with
 *    attribution far more often than one without.
 *
 * `isBasedOn` is doing double duty. It is the schema.org way to say "this piece draws
 * on these sources", and it is also how the mandatory source attribution from section 3
 * of the brief becomes machine-readable rather than a line of prose a model may or may
 * not carry through. The compliance requirement and the citation strategy turn out to
 * be the same field.
 */

import { escapeJsonLd } from './embed.js';

export interface Thing {
  readonly '@type': string;
  readonly [key: string]: unknown;
}

/**
 * A reference to an entity defined elsewhere in the same `@graph`.
 *
 * A bare `@id` is the JSON-LD idiom for "the thing I already described". Repeating
 * `@type` alongside it is not wrong, but it invites a second, subtly different copy of
 * the entity to grow next to the first — which is precisely what `@graph` exists to
 * prevent.
 */
export interface NodeReference {
  readonly '@id': string;
}

export interface SiteIdentity {
  /** Absolute origin, no trailing slash. */
  readonly origin: string;
  readonly name: string;
  readonly description: string;
  /** Absolute URL of a square logo, at least 112x112. */
  readonly logoUrl: string;
  /** Profiles the operator actually controls. Never a page they merely appear on. */
  readonly sameAs?: readonly string[];
}

/** Stable node ids, so `@graph` entries reference each other instead of repeating. */
const ids = (origin: string) => ({
  organisation: `${origin}/#organisation`,
  website: `${origin}/#website`,
});

export function organisation(site: SiteIdentity): Thing {
  const id = ids(site.origin);
  return {
    '@type': 'Organization',
    '@id': id.organisation,
    name: site.name,
    url: `${site.origin}/`,
    description: site.description,
    logo: { '@type': 'ImageObject', url: site.logoUrl },
    ...(site.sameAs && site.sameAs.length > 0 ? { sameAs: [...site.sameAs] } : {}),
  };
}

export function website(site: SiteIdentity): Thing {
  const id = ids(site.origin);
  return {
    '@type': 'WebSite',
    '@id': id.website,
    name: site.name,
    url: `${site.origin}/`,
    description: site.description,
    publisher: { '@id': id.organisation },
    inLanguage: 'en',
  };
}

export interface SourceReference {
  readonly url: string;
  readonly title: string;
  readonly publisher: string;
}

export interface ArticleInput {
  readonly headline: string;
  readonly description: string;
  readonly slug: string;
  readonly publishedAt: string;
  readonly modifiedAt?: string;
  readonly imageUrl?: string;
  /** Mandatory. A generated piece with no sources does not get published (section 3). */
  readonly sources: readonly SourceReference[];
  /** Model that produced it, when it was generated rather than written. */
  readonly generatedBy?: string;
  readonly reviewedBy?: string;
  readonly wordCount?: number;
  readonly keywords?: readonly string[];
}

/**
 * An article, with its provenance stated rather than implied.
 *
 * MORPH publishes machine-generated content, and pretending otherwise in structured
 * data is both dishonest and, increasingly, a ranking risk. `creativeWorkStatus` and
 * the explicit `Person`/`SoftwareApplication` author pair say plainly what made this
 * and who signed it off. A reviewer is named when there is one, because "reviewed by a
 * human" is a claim that needs a human attached to it.
 */
export function article(site: SiteIdentity, input: ArticleInput): Thing {
  const id = ids(site.origin);
  const url = `${site.origin}/t/${input.slug}`;

  const author: Thing | NodeReference = input.generatedBy
    ? {
        '@type': 'SoftwareApplication',
        name: input.generatedBy,
        applicationCategory: 'GenerativeAI',
      }
    : { '@id': id.organisation };

  return {
    '@type': 'Article',
    '@id': `${url}#article`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    headline: input.headline,
    description: input.description,
    abstract: input.description,
    url,
    datePublished: input.publishedAt,
    dateModified: input.modifiedAt ?? input.publishedAt,
    author,
    publisher: { '@id': id.organisation },
    isPartOf: { '@id': id.website },
    inLanguage: 'en',
    ...(input.imageUrl ? { image: input.imageUrl } : {}),
    ...(input.wordCount ? { wordCount: input.wordCount } : {}),
    ...(input.keywords && input.keywords.length > 0 ? { keywords: [...input.keywords] } : {}),
    ...(input.generatedBy
      ? {
          creativeWorkStatus: input.reviewedBy ? 'Published' : 'Draft',
          disambiguatingDescription: input.reviewedBy
            ? 'Machine-generated and reviewed by a human editor before publication.'
            : 'Machine-generated.',
        }
      : {}),
    ...(input.reviewedBy ? { reviewedBy: { '@type': 'Person', name: input.reviewedBy } } : {}),
    isBasedOn: input.sources.map((source) => ({
      '@type': 'CreativeWork',
      url: source.url,
      name: source.title,
      publisher: { '@type': 'Organization', name: source.publisher },
    })),
  };
}

export interface BreadcrumbStep {
  readonly name: string;
  readonly url: string;
}

export function breadcrumbs(steps: readonly BreadcrumbStep[]): Thing {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: steps.map((step, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: step.name,
      item: step.url,
    })),
  };
}

export interface QuestionAnswer {
  readonly question: string;
  readonly answer: string;
}

/**
 * FAQ markup — the highest-leverage AEO surface there is.
 *
 * An answer engine asked a question that matches one of these can quote the answer
 * verbatim with attribution. The constraint that makes it work is that the answer must
 * stand alone: no "as described above", no pronoun whose referent is elsewhere on the
 * page. A quoted answer arrives with none of its context.
 */
export function faq(items: readonly QuestionAnswer[]): Thing {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}

/**
 * Assemble a `@graph` document.
 *
 * One script tag per page rather than several: entities reference each other by `@id`,
 * and split documents cannot. Consumers that support only one block get everything.
 */
export function graph(nodes: readonly Thing[]): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@graph': [...nodes] };
}

/**
 * Serialise a graph for embedding in `<script type="application/ld+json">`.
 *
 * The escaping is not optional. Structured data on this site includes model-generated
 * titles and excerpts; a title containing `</script>` would otherwise close the tag and
 * turn generated content into executable markup. See `embed.ts`.
 */
export function serialiseJsonLd(document: Record<string, unknown>): string {
  return escapeJsonLd(JSON.stringify(document));
}
