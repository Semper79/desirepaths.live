/**
 * The embed job: documents in, vectors out.
 *
 * The cheapest stage and the one everything downstream depends on. Clustering compares
 * embeddings, audience fit is a cosine similarity against one, and a document without an
 * embedding is invisible to both — so this queue running behind does not degrade the
 * pipeline gracefully, it stops it.
 *
 * WHY THE WIDTH IS CHECKED HERE
 * `crawl_document.embedding` is declared `vector(768)`. A provider returning 1,024
 * dimensions fails inside pgvector with an error naming neither the document nor the
 * provider, at a point where the batch is half-written. Checking at the boundary turns
 * that into one clear failure before anything is stored — §Conventions, the boundary is
 * where things are validated.
 *
 * WHY A PARTIAL BATCH IS A SUCCESS
 * One document whose text the provider rejects must not cost the other sixty-three. Each
 * vector is written as it is validated, and the job reports what it skipped rather than
 * throwing — a job that fails the whole batch on one bad row is a job that never drains
 * a queue containing one bad row.
 */

import type {
  Clock,
  DocumentRepository,
  EmbeddingProvider,
  Logger,
  StoredDocument,
} from '../ports';
import type { EmbedJob } from '../queues';

export interface EmbedDeps {
  readonly documents: DocumentRepository;
  readonly embeddings: EmbeddingProvider;
  readonly now: Clock;
  readonly log: Logger;
}

export interface EmbedOutcome {
  readonly attempted: number;
  readonly embedded: number;
  readonly skipped: number;
}

/**
 * What gets embedded.
 *
 * Title first and repeated nowhere: the title carries the most signal per token, and the
 * excerpt disambiguates two articles with similar headlines. Capped, because an
 * embedding of ten thousand words is an embedding of nothing in particular.
 */
export const EMBED_TEXT_LIMIT = 1_500;

export function embeddingText(document: StoredDocument): string {
  return `${document.title}\n\n${document.excerpt}`.slice(0, EMBED_TEXT_LIMIT).trim();
}

export async function runEmbed(deps: EmbedDeps, job: EmbedJob): Promise<EmbedOutcome> {
  const startedAt = deps.now();
  const pending = await deps.documents.withoutEmbedding(job.batchSize);

  if (pending.length === 0) {
    return { attempted: 0, embedded: 0, skipped: 0 };
  }

  // Documents with nothing to embed are excluded before the call rather than sent and
  // discarded: an empty string is a wasted request, and some providers reject it.
  const usable = pending.filter((document) => embeddingText(document) !== '');
  const emptyCount = pending.length - usable.length;

  if (emptyCount > 0) {
    deps.log.warn('embed.empty-text', { count: emptyCount });
  }

  if (usable.length === 0) {
    return { attempted: pending.length, embedded: 0, skipped: pending.length };
  }

  const vectors = await deps.embeddings.embed(usable.map(embeddingText));

  if (vectors.length !== usable.length) {
    // Positional correspondence is the entire contract: a provider returning a different
    // number of vectors gives no way to know which document each belongs to, and writing
    // them in order would silently attach the wrong meaning to every document after the
    // gap. Failing loudly is the only safe response.
    throw new Error(
      `Embedding provider ${deps.embeddings.name} returned ${String(vectors.length)} vectors for ${String(usable.length)} documents.`,
    );
  }

  let embedded = 0;
  let skipped = emptyCount;

  for (const [index, document] of usable.entries()) {
    const vector = vectors[index];

    if (vector === undefined || vector.length !== deps.embeddings.dimensions) {
      deps.log.warn('embed.wrong-width', {
        documentId: document.id,
        expected: deps.embeddings.dimensions,
        received: vector?.length ?? 0,
      });
      skipped += 1;
      continue;
    }

    if (vector.some((value) => !Number.isFinite(value))) {
      // A NaN reaches pgvector, is stored, and then makes every cosine distance involving
      // that row NaN — which is not an error anywhere, just a document that never matches
      // and never explains why.
      deps.log.warn('embed.non-finite', { documentId: document.id });
      skipped += 1;
      continue;
    }

    await deps.documents.setEmbedding(document.id, vector);
    embedded += 1;
  }

  deps.log.info('embed.batch', {
    attempted: pending.length,
    embedded,
    skipped,
    provider: deps.embeddings.name,
    durationMs: deps.now() - startedAt,
  });

  return { attempted: pending.length, embedded, skipped };
}
