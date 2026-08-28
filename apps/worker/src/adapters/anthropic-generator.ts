/**
 * Drafting an article with Claude.
 *
 * The prompt is the interesting part of this file, and it is written against one
 * constraint: the model is not the last line of defence. `jobs/generate.ts` intersects
 * whatever comes back with the sources it offered and discards anything else, so the
 * prompt's job is not to *prevent* an invented citation — it is to make the honest answer
 * ("the sources do not support a piece on this") the easy one, so the rejection path is
 * rare rather than routine.
 *
 * WHY STRUCTURED OUTPUT RATHER THAN "RETURN JSON"
 * `messages.parse` with an output format constrains the response at the API, which is the
 * same discipline the rest of the repo applies at every process boundary. Asking for JSON
 * in prose and parsing it hopefully is how a pipeline ends up with a `JSON.parse` in a
 * try/catch and a retry loop around a model that keeps adding a preamble.
 *
 * WHY A JSON SCHEMA HERE AND ZOD EVERYWHERE ELSE
 * The SDK's `zodOutputFormat` helper requires zod 4; this workspace is on zod 3, and
 * upgrading every package's schemas for one call site is the wrong trade. So the shape
 * goes to the API as a JSON Schema, and the response is validated on the way back with a
 * zod schema declared alongside it. The duplication is real and deliberate — the test
 * asserts the two agree, which is cheaper than a major-version migration.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { z } from 'zod';
import type { ContentGenerator, GeneratedContent, GenerationBrief } from '../ports.js';

/**
 * The shape a draft comes back in.
 *
 * `body` is a list of blocks rather than a string of Markdown: the renderer needs
 * structure it can style with design tokens, and a heading the site can index. Sources are
 * returned as URLs, not as prose citations, so the job can check them mechanically.
 */
const BlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), text: z.string().min(1) }),
  z.object({ type: z.literal('paragraph'), text: z.string().min(1) }),
  z.object({ type: z.literal('list'), items: z.array(z.string().min(1)).min(1) }),
]);

const DraftSchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1),
  blocks: z.array(BlockSchema).min(1),
  /** Exactly the URLs from the supplied list that this draft actually draws on. */
  citedUrls: z.array(z.string()).min(1),
});

export type Draft = z.infer<typeof DraftSchema>;

/** The same shape, as the API wants to receive it. Kept in step by `generator.test.ts`. */
export const DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    blocks: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            properties: { type: { const: 'heading' }, text: { type: 'string' } },
            required: ['type', 'text'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: { type: { const: 'paragraph' }, text: { type: 'string' } },
            required: ['type', 'text'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              type: { const: 'list' },
              items: { type: 'array', items: { type: 'string' } },
            },
            required: ['type', 'items'],
            additionalProperties: false,
          },
        ],
      },
    },
    citedUrls: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'blocks', 'citedUrls'],
  additionalProperties: false,
} as const;

const SYSTEM = `You write short, factual explainers for a publication that is open about
being machine-assisted. Every piece you write is reviewed by a person before it is
published, and your draft is judged on whether it is worth their time.

Rules that are not negotiable:

- Write only what the supplied sources support. If they are thin, write a shorter piece.
- Cite only from the supplied list, using the URLs exactly as given. Never introduce a
  source that is not in the list, and never invent a statistic, quotation or attribution.
- If the sources do not support a piece worth publishing, say so in the summary and return
  the single source that came closest. That is a useful answer, not a failure.
- No speculation about people, no medical or financial advice, no predictions.
- Plain language. No throat-clearing, no "in today's fast-paced world", no rhetorical
  questions as openings.`;

export interface GeneratorConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly maxTokens: number;
}

export function anthropicGenerator(config: GeneratorConfig): ContentGenerator {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    async draft(brief: GenerationBrief): Promise<GeneratedContent> {
      const prompt = promptFor(brief);

      const response = await client.messages.parse({
        model: config.model,
        max_tokens: config.maxTokens,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        output_config: { format: jsonSchemaOutputFormat(DRAFT_JSON_SCHEMA) },
      });

      if (response.parsed_output === null) {
        // The API constrains the format, so this is a refusal or a truncation rather than
        // malformed JSON. Either way it is not something a retry with the same input
        // fixes, so it fails rather than looping.
        throw new Error(
          `The model returned no parseable draft for "${brief.label}" (stop reason: ${response.stop_reason ?? 'unknown'}).`,
        );
      }

      // Parsed again on this side, because the API guarantees the schema and this
      // guarantees the *invariants* — a non-empty title, at least one block, at least one
      // cited URL — which a JSON Schema cannot express as usefully.
      const parsed = DraftSchema.parse(response.parsed_output);

      return {
        title: parsed.title,
        summary: parsed.summary,
        body: { blocks: parsed.blocks },
        citedUrls: parsed.citedUrls,
        model: config.model,
        prompt,
      };
    },
  };
}

/**
 * The prompt, built from the brief.
 *
 * The rationale from the scorer is included deliberately: telling the model *why* this
 * topic was selected — rising fast, lightly covered — gives it the angle, and an explainer
 * written against the reason it was chosen is more useful than one written against the
 * label alone.
 */
export function promptFor(brief: GenerationBrief): string {
  const sources = brief.sources
    .map(
      (source, index) =>
        `${String(index + 1)}. ${source.title}\n   ${source.publisher} — ${source.url}`,
    )
    .join('\n');

  return [
    `Topic: ${brief.label}`,
    `Why it was selected: ${brief.rationale}`,
    '',
    'Headlines in this topic:',
    brief.summary,
    '',
    'Sources you may cite, and the only ones:',
    sources,
    '',
    'Write a short explainer of 300–500 words. Return the URLs you actually drew on in',
    'citedUrls, copied exactly from the list above.',
  ].join('\n');
}
