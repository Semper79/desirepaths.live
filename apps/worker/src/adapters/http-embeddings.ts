/**
 * Embeddings over HTTP.
 *
 * Two providers, one request shape. Voyage and the OpenAI-compatible services differ in
 * the endpoint path and in where the vectors sit in the response, and in nothing else that
 * matters here — so the difference is two small functions rather than two adapters.
 *
 * WHY THE RESPONSE IS PARSED AND NOT CAST
 * §Conventions: anything crossing a process boundary is parsed. An embedding response is
 * a particularly good argument for it — a provider returning `{"data": [{"embedding":
 * null}]}` on a partial failure would otherwise reach pgvector as a null and fail three
 * stages later, with the provider's error message long gone.
 *
 * WHY THE ORDER IS RESTORED EXPLICITLY
 * Both APIs return an index with each vector and both are documented as returning them in
 * order — but `embedDocuments` relies on positional correspondence to know which vector
 * belongs to which document, and "documented as" is not the same as "guaranteed". Sorting
 * by the index the provider itself supplied costs nothing and removes the possibility.
 */

import { z } from 'zod';
import type { EmbeddingProvider } from '../ports';

const VoyageResponse = z.object({
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.number()) })),
});

const OpenAiResponse = z.object({
  data: z.array(z.object({ index: z.number().int().min(0), embedding: z.array(z.number()) })),
});

export interface HttpEmbeddingConfig {
  readonly provider: 'voyage' | 'openai-compatible';
  readonly model: string;
  readonly dimensions: number;
  readonly apiKey: string;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export function httpEmbeddings(config: HttpEmbeddingConfig): EmbeddingProvider {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  const url =
    config.provider === 'voyage'
      ? VOYAGE_URL
      : `${(config.baseUrl ?? '').replace(/\/+$/, '')}/embeddings`;

  return {
    name: `${config.provider}:${config.model}`,
    dimensions: config.dimensions,

    async embed(texts) {
      if (texts.length === 0) return [];

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await doFetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(
            config.provider === 'voyage'
              ? { model: config.model, input: texts, input_type: 'document' }
              : { model: config.model, input: texts },
          ),
          signal: controller.signal,
        });

        if (!response.ok) {
          // The body is included because embedding providers put the useful part of the
          // failure there — a too-long input, a rate limit, an unknown model — and a bare
          // status code sends whoever is on call to the wrong place.
          const detail = (await response.text()).slice(0, 500);
          throw new Error(`Embedding request failed: HTTP ${String(response.status)} — ${detail}`);
        }

        const schema = config.provider === 'voyage' ? VoyageResponse : OpenAiResponse;
        const parsed = schema.parse(await response.json());

        return [...parsed.data].sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
