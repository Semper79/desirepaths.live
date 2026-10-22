/**
 * A development embedding provider that needs no key, no network and no GPU.
 *
 * WHAT IT IS FOR
 * Running the pipeline end to end on a laptop. Without it, every stage after `crawl` is
 * unreachable in development, which means the clustering and scoring code would only ever
 * be exercised by unit tests — and the interesting failures in a pipeline are the ones
 * that happen when the stages are connected.
 *
 * WHAT IT IS NOT
 * An embedding. There is no semantic meaning in the output at all: two articles about the
 * same subject are as far apart as two about different ones, unless they share literal
 * tokens. It is a hashing trick — the "hashing vector" of classical text classification —
 * which gives the right shape, the right magnitude, and stable output for stable input,
 * and nothing else.
 *
 * `refineEnv` refuses to boot with this provider in production, because a deployment
 * using it would cluster by hash collision and score topics from noise while looking
 * completely healthy. That is the whole reason this file names its own limitation twice.
 */

import { hash64, shingles } from '@morph/crawler';
import type { EmbeddingProvider } from '../ports';

export const DETERMINISTIC_PROVIDER_NAME = 'deterministic-hashing (development only)';

/**
 * Project text into a fixed-width vector by hashing its shingles into buckets.
 *
 * Signed buckets — each shingle also picks a sign from a separate bit of its hash — so
 * that unrelated documents are near-orthogonal rather than uniformly positive, which is
 * what makes cosine similarity behave like a similarity rather than like a length
 * comparison.
 */
export function hashingVector(text: string, dimensions: number): readonly number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const grams = shingles(text, 2);

  for (const gram of grams) {
    const h = hash64(gram);
    const bucket = Number(h % BigInt(dimensions));
    const sign = (h >> 63n) & 1n ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }

  // Normalised to unit length, because everything downstream compares by cosine and an
  // unnormalised vector makes a long document look "more similar" to everything.
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector;

  return vector.map((value) => value / norm);
}

export function deterministicEmbeddings(dimensions: number): EmbeddingProvider {
  return {
    name: DETERMINISTIC_PROVIDER_NAME,
    dimensions,
    embed: (texts) => Promise.resolve(texts.map((text) => hashingVector(text, dimensions))),
  };
}
