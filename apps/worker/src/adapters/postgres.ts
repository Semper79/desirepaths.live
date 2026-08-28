/**
 * The ports, over Postgres.
 *
 * Deliberately thin: each method is one query and no thinking. Everything worth testing
 * is on the other side of the seam, in `src/jobs/`, where it is exercised against the
 * in-memory fakes without a database.
 *
 * ⚠ NOT COVERED BY THE TEST SUITE. These functions need a live Postgres with the schema
 * and pgvector loaded, which the repository does not have on a developer machine without
 * Docker. They are excluded from coverage for the same reason `apps/api/src/lib/producer.ts`
 * is, and the honest consequence is that a mistake in a query here is caught by
 * integration testing or by production, not by `pnpm test`. Keeping them free of
 * conditionals is what makes that acceptable: there is no branch here to get wrong, only
 * a query to read.
 *
 * WHY MILLISECONDS AT THE PORT AND `Date` IN THE COLUMN
 * Every job takes time as a number, because that is what makes them testable without a
 * clock. Postgres wants a timestamp. The conversion happens here, once per direction, so
 * neither side has to know about the other's convention.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gte, isNull, isNotNull, lt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { content, crawlDocument, crawlSource, trendSignal } from '@morph/core/db';
import { fromStoredVerdict, toStoredVerdict } from '@morph/core';
import type {
  ContentDraft,
  ContentRepository,
  CrawlSource,
  DocumentRepository,
  EmbeddedDocument,
  SourceKind,
  SourceRepository,
  StoredCluster,
  StoredDocument,
  TrendRepository,
  TrendSignalRecord,
} from '../ports.js';

export type Database = PostgresJsDatabase;

const toDate = (ms: number): Date => new Date(ms);
const toMs = (value: Date | null): number | null => (value === null ? null : value.getTime());

export function sourceRepository(db: Database): SourceRepository {
  return {
    async due(now, limit) {
      const rows = await db
        .select()
        .from(crawlSource)
        .where(
          and(
            eq(crawlSource.enabled, true),
            // Never fetched, or last fetched longer ago than its own crawl delay. The
            // delay is also enforced by the scheduler at request time; this only keeps
            // the queue from handing out work that would immediately be deferred.
            sql`(${crawlSource.lastFetchedAt} IS NULL OR ${crawlSource.lastFetchedAt} < ${toDate(now)}::timestamptz - (${crawlSource.crawlDelayMs} || ' milliseconds')::interval)`,
          ),
        )
        .orderBy(asc(sql`${crawlSource.lastFetchedAt} NULLS FIRST`))
        .limit(limit);

      return rows.map((row): CrawlSource => ({
        id: row.id,
        kind: row.kind as SourceKind,
        host: row.host,
        url: row.url,
        etag: row.etag,
        lastModified: row.lastModified,
        lastFetchedAt: toMs(row.lastFetchedAt),
      }));
    },

    async recordFetch(sourceId, outcome) {
      await db
        .update(crawlSource)
        .set({
          lastFetchedAt: toDate(outcome.at),
          lastStatus: outcome.status,
          ...(outcome.etag === undefined ? {} : { etag: outcome.etag }),
          ...(outcome.lastModified === undefined ? {} : { lastModified: outcome.lastModified }),
          consecutiveFailures: outcome.failed ? sql`${crawlSource.consecutiveFailures} + 1` : 0,
        })
        .where(eq(crawlSource.id, sourceId));
    },

    async recordRobots(sourceId, allowed, at) {
      await db
        .update(crawlSource)
        .set({ robotsAllows: allowed, robotsCheckedAt: toDate(at) })
        .where(eq(crawlSource.id, sourceId));
    },
  };
}

export function documentRepository(db: Database): DocumentRepository {
  const toDocument = (row: typeof crawlDocument.$inferSelect): StoredDocument => ({
    id: row.id,
    sourceId: row.sourceId,
    url: row.url,
    title: row.title ?? '',
    excerpt: row.excerpt ?? '',
    simhash: row.simhash,
    lang: row.lang,
    publishedAt: toMs(row.publishedAt),
    fetchedAt: row.fetchedAt.getTime(),
    embedding: row.embedding,
    clusterId: row.clusterId,
  });

  return {
    async recentFingerprints(since) {
      const rows = await db
        .select({ simhash: crawlDocument.simhash })
        .from(crawlDocument)
        .where(gte(crawlDocument.fetchedAt, toDate(since)));

      return rows.map((row) => row.simhash);
    },

    async upsert(document) {
      const [row] = await db
        .insert(crawlDocument)
        .values({
          sourceId: document.sourceId,
          url: document.url,
          title: document.title,
          excerpt: document.excerpt,
          simhash: document.simhash,
          lang: document.lang,
          publishedAt: document.publishedAt === null ? null : toDate(document.publishedAt),
          fetchedAt: toDate(document.fetchedAt),
        })
        // The URL is unique, and re-seeing one is the normal case rather than an error:
        // a feed lists the same item for days. `DO UPDATE` on a no-op column is what makes
        // `RETURNING` produce the existing row instead of nothing.
        .onConflictDoUpdate({
          target: crawlDocument.url,
          set: { title: document.title },
        })
        .returning();

      if (row === undefined) throw new Error(`Upsert returned no row for ${document.url}`);
      return toDocument(row);
    },

    async withoutEmbedding(limit) {
      const rows = await db
        .select()
        .from(crawlDocument)
        .where(isNull(crawlDocument.embedding))
        .orderBy(asc(crawlDocument.fetchedAt))
        .limit(limit);

      return rows.map(toDocument);
    },

    async setEmbedding(documentId, embedding) {
      await db
        .update(crawlDocument)
        .set({ embedding: [...embedding] })
        .where(eq(crawlDocument.id, documentId));
    },

    async unclustered(since, limit) {
      const rows = await db
        .select()
        .from(crawlDocument)
        .where(
          and(
            isNotNull(crawlDocument.embedding),
            isNull(crawlDocument.clusterId),
            gte(crawlDocument.fetchedAt, toDate(since)),
          ),
        )
        .orderBy(asc(crawlDocument.fetchedAt))
        .limit(limit);

      return rows.map(toDocument).filter((d): d is EmbeddedDocument => d.embedding !== null);
    },

    async setCluster(documentId, clusterId) {
      await db.update(crawlDocument).set({ clusterId }).where(eq(crawlDocument.id, documentId));
    },

    async forCluster(clusterId, limit) {
      const rows = await db
        .select()
        .from(crawlDocument)
        .where(eq(crawlDocument.clusterId, clusterId))
        .orderBy(desc(crawlDocument.fetchedAt))
        .limit(limit);

      return rows.map(toDocument);
    },

    async hourlyCounts(clusterId, now, hours) {
      // Bucketed by whole hours back from `now`, and zero-filled: a gap means "nobody
      // mentioned it that hour", which is exactly the information the acceleration term
      // needs. Returning only the non-empty buckets would make a fading topic look flat.
      const since = toDate(now - hours * 3_600_000);

      const rows = await db
        .select({
          bucket: sql<number>`floor(extract(epoch from (${toDate(now)}::timestamptz - ${crawlDocument.fetchedAt})) / 3600)::int`,
          count: sql<number>`count(*)::int`,
        })
        .from(crawlDocument)
        .where(and(eq(crawlDocument.clusterId, clusterId), gte(crawlDocument.fetchedAt, since)))
        .groupBy(sql`1`);

      const counts = new Array<number>(hours).fill(0);
      for (const row of rows) {
        // Bucket 0 is the most recent hour; the scorer reads oldest-first.
        const index = hours - 1 - row.bucket;
        if (index >= 0 && index < hours) counts[index] = row.count;
      }
      return counts;
    },

    async distinctSources(clusterId) {
      const [row] = await db
        .select({ count: sql<number>`count(distinct ${crawlDocument.sourceId})::int` })
        .from(crawlDocument)
        .where(eq(crawlDocument.clusterId, clusterId));

      return row?.count ?? 0;
    },

    async deleteOlderThan(cutoff) {
      const deleted = await db
        .delete(crawlDocument)
        .where(lt(crawlDocument.fetchedAt, toDate(cutoff)))
        .returning({ id: crawlDocument.id });

      return deleted.length;
    },
  };
}

export function trendRepository(db: Database): TrendRepository {
  const toRecord = (row: typeof trendSignal.$inferSelect): TrendSignalRecord => ({
    id: row.id,
    label: row.label,
    centroid: row.centroid ?? [],
    documentCount: row.documentCount,
    momentum: row.momentum,
    audienceFit: row.audienceFit,
    saturation: row.saturation,
    durability: row.durability,
    safetyVerdict: fromStoredVerdict(row.safetyVerdict),
    safetyReason: row.safetyReason,
    safetyCategories: row.safetyCategories ?? [],
    firstSeenAt: row.firstSeenAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    actedOnAt: toMs(row.actedOnAt),
  });

  return {
    async activeClusters(since) {
      const signals = await db
        .select()
        .from(trendSignal)
        .where(gte(trendSignal.lastSeenAt, toDate(since)));

      // Member ids in one query rather than one per cluster. Bounded by the retention
      // window; see the note on `TrendRepository.activeClusters` for when this stops
      // being the right shape.
      const members = await db
        .select({ id: crawlDocument.id, clusterId: crawlDocument.clusterId })
        .from(crawlDocument)
        .where(isNotNull(crawlDocument.clusterId));

      const byCluster = new Map<string, string[]>();
      for (const member of members) {
        if (member.clusterId === null) continue;
        const list = byCluster.get(member.clusterId);
        if (list === undefined) byCluster.set(member.clusterId, [member.id]);
        else list.push(member.id);
      }

      return signals.map((row): StoredCluster => ({
        id: row.id,
        centroid: row.centroid ?? [],
        memberIds: byCluster.get(row.id) ?? [],
        label: row.label,
        firstSeenAt: row.firstSeenAt.getTime(),
      }));
    },

    nextClusterId() {
      // Generated here rather than by the database, because `assignToClusters` needs the
      // id before the row exists — a document can join a cluster created moments earlier
      // in the same batch.
      return randomUUID();
    },

    async save(record) {
      await db
        .insert(trendSignal)
        .values({
          id: record.id,
          label: record.label,
          centroid: [...record.centroid],
          documentCount: record.documentCount,
          momentum: record.momentum,
          audienceFit: record.audienceFit,
          saturation: record.saturation,
          durability: record.durability,
          safetyVerdict: toStoredVerdict(record.safetyVerdict),
          safetyReason: record.safetyReason,
          safetyCategories: [...record.safetyCategories],
          firstSeenAt: toDate(record.firstSeenAt),
          lastSeenAt: toDate(record.lastSeenAt),
          actedOnAt: record.actedOnAt === null ? null : toDate(record.actedOnAt),
        })
        .onConflictDoUpdate({
          target: trendSignal.id,
          set: {
            centroid: [...record.centroid],
            documentCount: record.documentCount,
            momentum: record.momentum,
            audienceFit: record.audienceFit,
            saturation: record.saturation,
            durability: record.durability,
            safetyVerdict: toStoredVerdict(record.safetyVerdict),
            safetyReason: record.safetyReason,
            safetyCategories: [...record.safetyCategories],
            lastSeenAt: toDate(record.lastSeenAt),
          },
        });
    },

    async byId(id) {
      const [row] = await db.select().from(trendSignal).where(eq(trendSignal.id, id)).limit(1);
      return row === undefined ? null : toRecord(row);
    },

    async awaitingContent(limit) {
      const rows = await db
        .select()
        .from(trendSignal)
        .where(
          and(
            eq(trendSignal.safetyVerdict, toStoredVerdict('allow')),
            isNull(trendSignal.actedOnAt),
          ),
        )
        // Ordered by momentum, which the index covers. The composite score is recomputed
        // in the job from the stored components, because it is not a column — see
        // `combine()` in @morph/crawler for why it lives in one place.
        .orderBy(desc(trendSignal.momentum))
        .limit(limit);

      return rows.map(toRecord);
    },

    async markActedOn(signalId, at) {
      await db
        .update(trendSignal)
        .set({ actedOnAt: toDate(at) })
        .where(eq(trendSignal.id, signalId));
    },
  };
}

export function contentRepository(db: Database): ContentRepository {
  return {
    async slugExists(slug) {
      const [row] = await db
        .select({ id: content.id })
        .from(content)
        .where(eq(content.slug, slug))
        .limit(1);

      return row !== undefined;
    },

    async createDraft(draft: ContentDraft, at) {
      const [row] = await db
        .insert(content)
        .values({
          slug: draft.slug,
          kind: draft.kind,
          title: draft.title,
          summary: draft.summary,
          body: draft.body,
          // Never anything else from this path. `content_generated_needs_review` enforces
          // it too; both exist so that neither has to be the only thing standing there.
          status: 'draft',
          trendSignalId: draft.trendSignalId,
          sources: [...draft.sources],
          generatedBy: draft.generatedBy,
          generationPrompt: draft.generationPrompt,
          createdAt: toDate(at),
          updatedAt: toDate(at),
        })
        .returning({ id: content.id });

      if (row === undefined) throw new Error(`Insert returned no row for slug ${draft.slug}`);
      return { id: row.id };
    },
  };
}
