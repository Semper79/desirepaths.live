/**
 * The shape of a piece of content.
 *
 * Two processes need to agree on this and they never run together: the worker writes a
 * body into a `jsonb` column, and the web app reads it back weeks later, from a different
 * deploy. §Conventions — anything crossing a process boundary is parsed, never cast — and
 * a `jsonb` column is exactly such a boundary, with the added property that whatever is
 * in there was written by whichever version of the generator happened to be running.
 *
 * WHY BLOCKS AND NOT MARKDOWN
 * A Markdown string would be simpler to store and worse everywhere else. The renderer
 * needs structure it can style with the design tokens the adaptive engine chose; the SEO
 * layer needs headings it can index; and rendering model-authored Markdown means either
 * shipping a parser to the client or trusting `dangerouslySetInnerHTML` with text a
 * language model wrote. Blocks are inert data that React renders as elements.
 *
 * WHY THE UNION IS SMALL
 * Three block types cover an explainer. Every additional one is a case the renderer must
 * handle, a shape the generator can get wrong, and a thing to migrate later. Adding one
 * when a piece actually needs it is cheap; removing one that generated content has
 * already used is not.
 */

import { z } from 'zod';

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().min(1) }),
  z.object({ type: z.literal('paragraph'), text: z.string().min(1) }),
  z.object({ type: z.literal('list'), items: z.array(z.string().min(1)).min(1) }),
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const ContentBodySchema = z.object({
  blocks: z.array(ContentBlockSchema),
});

export type ContentBody = z.infer<typeof ContentBodySchema>;

/**
 * A source, as stored on `content.sources` and rendered on the page.
 *
 * Not optional anywhere: `content_published_needs_sources` makes an empty list impossible
 * for a published row, and §7.3 makes attribution mandatory. The type says so too, so the
 * constraint is not the only thing standing there.
 */
export const ContentSourceSchema = z.object({
  url: z.string(),
  title: z.string(),
  publisher: z.string(),
});

export type ContentSource = z.infer<typeof ContentSourceSchema>;

/**
 * Read a body out of a `jsonb` column.
 *
 * Returns an empty block list rather than throwing on a shape it does not recognise. The
 * reasoning is specific to where this is called: a single malformed row must not take
 * down the page that renders it, and the page degrades to its title, summary and sources
 * — which are separate columns and are the parts a reader most needs. A throw here would
 * turn one bad generation into a 500 on a URL that search engines have already indexed.
 *
 * The malformed case is reported by the caller, not swallowed silently.
 */
export function parseContentBody(value: unknown): ContentBody {
  const result = ContentBodySchema.safeParse(value);
  return result.success ? result.data : { blocks: [] };
}

/** Rough length, for the reading-time estimate and for spotting a truncated generation. */
export function bodyWordCount(body: ContentBody): number {
  return body.blocks.reduce((total, block) => {
    const text = block.type === 'list' ? block.items.join(' ') : block.text;
    const trimmed = text.trim();
    return total + (trimmed === '' ? 0 : trimmed.split(/\s+/).length);
  }, 0);
}
