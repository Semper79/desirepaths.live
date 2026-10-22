import { describe, expect, it } from 'vitest';
import { DRAFT_JSON_SCHEMA, promptFor } from '../src/adapters/anthropic-generator';
import type { GenerationBrief } from '../src/ports';

const BRIEF: GenerationBrief = {
  label: 'Incremental clustering',
  summary: 'Library keeps cluster ids stable; Why identity matters for trend tracking',
  rationale: 'Selected with a composite score of 0.71, momentum 0.80',
  sources: [
    { url: 'https://a.example/one', title: 'Stable identifiers', publisher: 'a.example' },
    { url: 'https://b.example/two', title: 'Why ids matter', publisher: 'b.example' },
  ],
};

describe('the prompt', () => {
  it('lists every source with its URL exactly as it will be checked', () => {
    const prompt = promptFor(BRIEF);

    for (const source of BRIEF.sources) {
      expect(prompt).toContain(source.url);
      expect(prompt).toContain(source.title);
      expect(prompt).toContain(source.publisher);
    }
  });

  /**
   * Telling the model *why* a topic was selected gives it the angle. An explainer written
   * against "rising fast, lightly covered" is more useful than one written against a label.
   */
  it('carries the scorer rationale into the prompt', () => {
    expect(promptFor(BRIEF)).toContain('composite score of 0.71');
  });

  it('states that the list is exhaustive', () => {
    expect(promptFor(BRIEF)).toMatch(/the only ones/i);
  });

  it('is deterministic, so the recorded prompt matches what was sent', () => {
    expect(promptFor(BRIEF)).toBe(promptFor(BRIEF));
  });
});

/**
 * The JSON Schema goes to the API and the zod schema validates what comes back. They are
 * declared separately because the SDK's zod helper needs zod 4 and this workspace is on
 * zod 3 — so the duplication is deliberate, and this is the test that keeps it honest.
 */
describe('the two schema declarations agree', () => {
  it('requires the same top-level fields', () => {
    expect([...DRAFT_JSON_SCHEMA.required].sort()).toEqual([
      'blocks',
      'citedUrls',
      'summary',
      'title',
    ]);
  });

  it('declares the same block variants', () => {
    const variants = DRAFT_JSON_SCHEMA.properties.blocks.items.anyOf.map(
      (variant) => variant.properties.type.const,
    );
    expect([...variants].sort()).toEqual(['heading', 'list', 'paragraph']);
  });

  it('forbids extra properties, so a stray field is a schema error not silent data', () => {
    expect(DRAFT_JSON_SCHEMA.additionalProperties).toBe(false);
    for (const variant of DRAFT_JSON_SCHEMA.properties.blocks.items.anyOf) {
      expect(variant.additionalProperties).toBe(false);
    }
  });
});
