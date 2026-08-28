import { describe, expect, it } from 'vitest';
import {
  bodyWordCount,
  ContentBodySchema,
  parseContentBody,
  type ContentBody,
} from '../src/content.js';

const BODY: ContentBody = {
  blocks: [
    { type: 'heading', text: 'What adapts' },
    { type: 'paragraph', text: 'Two sentences that say something.' },
    { type: 'list', items: ['the palette', 'the headline'] },
  ],
};

describe('the body shape', () => {
  it('accepts the three block types', () => {
    expect(ContentBodySchema.parse(BODY)).toEqual(BODY);
  });

  it('rejects an unknown block type rather than passing it to a renderer', () => {
    expect(() => ContentBodySchema.parse({ blocks: [{ type: 'video', src: 'x' }] })).toThrow();
  });

  it('rejects an empty paragraph and an empty list', () => {
    expect(() => ContentBodySchema.parse({ blocks: [{ type: 'paragraph', text: '' }] })).toThrow();
    expect(() => ContentBodySchema.parse({ blocks: [{ type: 'list', items: [] }] })).toThrow();
  });

  it('accepts a body with no blocks, which is a thin page and not an error', () => {
    expect(ContentBodySchema.parse({ blocks: [] })).toEqual({ blocks: [] });
  });
});

describe('reading a body out of a jsonb column', () => {
  it('returns what was stored when it is valid', () => {
    expect(parseContentBody(BODY)).toEqual(BODY);
  });

  /**
   * A single malformed row must not take down the page that renders it. The page degrades
   * to its title, summary and sources — separate columns, and the parts a reader most
   * needs — rather than 500ing on a URL search engines have already indexed.
   */
  it('degrades to no blocks rather than throwing', () => {
    expect(parseContentBody(null)).toEqual({ blocks: [] });
    expect(parseContentBody('a markdown string from an older generator')).toEqual({ blocks: [] });
    expect(parseContentBody({ blocks: [{ type: 'video' }] })).toEqual({ blocks: [] });
    expect(parseContentBody({})).toEqual({ blocks: [] });
  });
});

describe('word count', () => {
  it('counts across every block type', () => {
    expect(bodyWordCount(BODY)).toBe(2 + 5 + 4);
  });

  it('is 0 for an empty body', () => {
    expect(bodyWordCount({ blocks: [] })).toBe(0);
  });
});
