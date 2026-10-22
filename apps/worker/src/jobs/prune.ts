/**
 * The prune job: enforcing the retention window.
 *
 * `crawl_document` is described in the schema as "a 30-day cache, not an archive". Until
 * this job existed, that was a comment. The distinction matters in two directions:
 *
 * **Privacy.** `docs/PRIVACY.md` commits to bounded retention, and a commitment with no
 * job behind it is the kind of thing that is discovered during an audit rather than
 * during development.
 *
 * **Correctness.** The clustering stage compares against clusters "active since" a
 * window. If documents accumulate forever, `activeClusters` grows without bound, every
 * new document is compared against every topic the site has ever seen, and the run time
 * degrades quietly until an hourly job stops finishing within the hour.
 *
 * The signal outlives the text on purpose: `trend_signal` rows keep their scores, their
 * history and their labels after the documents that produced them are gone. Momentum is
 * computed from counts already recorded, not by re-reading the corpus, so a pruned topic
 * keeps its history — it simply stops accumulating new evidence.
 */

import type { Clock, DocumentRepository, Logger } from '../ports';
import type { PruneJob } from '../queues';

export interface PruneDeps {
  readonly documents: DocumentRepository;
  readonly now: Clock;
  readonly log: Logger;
}

export interface PruneOutcome {
  readonly cutoff: number;
  readonly deleted: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runPrune(deps: PruneDeps, job: PruneJob): Promise<PruneOutcome> {
  const now = deps.now();
  const cutoff = now - job.retentionDays * DAY_MS;

  const deleted = await deps.documents.deleteOlderThan(cutoff);

  // At info rather than debug: an operator should be able to see from the report that
  // retention ran and how much it removed, because "the retention job has silently done
  // nothing for six weeks" looks exactly like "there was nothing to remove".
  deps.log.info('prune.batch', {
    retentionDays: job.retentionDays,
    cutoff: new Date(cutoff).toISOString(),
    deleted,
    durationMs: deps.now() - now,
  });

  return { cutoff, deleted };
}
