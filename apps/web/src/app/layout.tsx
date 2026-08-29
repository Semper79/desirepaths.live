/**
 * The root layout — where the site becomes adapted.
 *
 * Three things happen here, in this order, before a single byte is sent:
 *
 *  1. The assignment is resolved from the headers middleware set.
 *  2. The variants' design tokens are composed into one bag and written onto the
 *     `<html>` element as inline custom properties.
 *  3. The page renders against those tokens.
 *
 * That ordering is the entire no-flash guarantee. The tokens arrive in the initial
 * HTML, so the first paint is already correct: there is no client-side theme
 * application, no `useEffect` swap, and therefore no Cumulative Layout Shift from the
 * adaptive layer. A site that adapts by re-rendering on the client would fail the CLS
 * budget the optimiser is itself judged against — the adaptation would degrade the
 * metric it exists to improve.
 */

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { tokensToStyleAttribute } from '@morph/core';
import { graph, organisation, pageMeta, serialiseJsonLd, website } from '@morph/seo';
import { assignmentForRequest } from '../lib/resolve.js';
import { tokensFor } from '../lib/render.js';
import { isIndexable, siteIdentity } from '../lib/site.js';
import { Beacon } from '../components/beacon.js';
import { ConsentGate } from '../components/consent-gate.js';
import './globals.css';

export function generateMetadata(): Metadata {
  const site = siteIdentity();
  const meta = pageMeta({
    origin: site.origin,
    siteName: site.name,
    path: '/',
    title: 'Desire Path — a website that rebuilds itself',
    description: site.description,
    ...(isIndexable() ? {} : { noindex: true }),
  });

  return {
    metadataBase: new URL(site.origin),
    title: { default: meta.title, template: `%s — ${site.name}` },
    description: site.description,
    alternates: {
      canonical: meta.canonical,
      types: {
        'application/rss+xml': `${site.origin}/feed.xml`,
        'application/atom+xml': `${site.origin}/atom.xml`,
      },
    },
    robots: isIndexable()
      ? { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 }
      : { index: false, follow: true },
  };
}

export default async function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const requestHeaders = await headers();
  const resolved = await assignmentForRequest(requestHeaders);
  const tokens = tokensFor(resolved.assignment);

  const site = siteIdentity();
  const structuredData = serialiseJsonLd(graph([organisation(site), website(site)]));

  return (
    <html lang="en">
      <head>
        {/*
          The adaptive layer, in one declaration block in the initial HTML.

          A `<style>` element rather than a `style` attribute on `<html>`: React's
          style object has no type for custom properties, and every way of forcing one
          in involves a cast this repository bans for good reasons. This form also
          routes through `tokensToStyleAttribute`, which re-validates every token
          against the allowlist before it becomes CSS text — the one place a generated
          variant could otherwise reach the page unchecked.

          It is in `<head>`, so it is parsed before the body paints. No flash.
        */}
        <style dangerouslySetInnerHTML={{ __html: `:root{${tokensToStyleAttribute(tokens)}}` }} />
        {/*
          One script tag per page. Entities reference each other by @id inside a
          @graph, which split documents cannot do.
        */}
        <script
          type="application/ld+json"
          // The payload is escaped by `serialiseJsonLd`: HTML ends a script element at
          // the first `</script`, even inside a JSON string, and this page carries
          // model-generated titles.
          dangerouslySetInnerHTML={{ __html: structuredData }}
        />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
        <ConsentGate />
        {/*
          The assignment, exposed to the client so the beacon can attribute events to
          exactly what was rendered. Not a secret: it is what the visitor is looking at.
        */}
        <script
          type="application/json"
          id="morph-assignment"
          dangerouslySetInnerHTML={{
            __html: serialiseJsonLd({
              surfaces: Object.keys(resolved.assignment),
              variants: Object.values(resolved.assignment),
              assignmentHash: resolved.hash,
              holdout: resolved.isHoldout ? 1 : 0,
              measurable: resolved.measurable,
            }),
          }}
        />
        {/* Attaches no listener without consent, and none at all for a crawler. */}
        <Beacon />
      </body>
    </html>
  );
}
