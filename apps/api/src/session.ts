/**
 * One Durable Object per session, which closes itself and hands its components on.
 *
 * A session is the right coordination atom for the fold, because a session is the thing
 * being folded: the reward is session-scoped, so nothing can be attributed until the session
 * has ended. This object is what knows that it has.
 *
 * WHY NOT FOLD FROM ANALYTICS ENGINE
 * It would be cheaper, and the SQL API can group by session id over a window. It is also
 * forbidden by D33: Analytics Engine samples, so every count it produced would be an
 * estimate, and an estimate may not enter a Beta. Folding here is what makes the numbers in
 * the counters something the engine is allowed to reason from.
 *
 * WHY NOT ONE OBJECT PER SURFACE DOING ITS OWN FOLDING
 * Every session sees every surface, so each of the eleven surface objects would need a row
 * for every live session — eleven copies of the same bookkeeping, eleven times the writes,
 * and a surface object single-threaded behind traffic it has no reason to see.
 *
 * THE ALARM RULE HERE IS THE OPPOSITE OF THE COUNTERS'
 * `SurfaceCounters` sets its flush alarm only when there is not one already, because
 * `setAlarm` replaces and re-arming on every write would push the flush away for ever. Here
 * replacing is exactly what is wanted: each event *is* activity, so the inactivity deadline
 * should move. Same API, opposite correct usage, which is why both are commented.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  SESSION_TIMEOUT_MS,
  componentsFor,
  emptySession,
  foldEvent,
  type FoldableEvent,
  type SessionState,
} from '@morph/core';
import type { HourlyFold, SurfaceCounters } from './counters.js';
import { hourStartOf } from './counters.js';

/**
 * Re-exported, not redeclared.
 *
 * The number lives in `@morph/core` because the adaptive cycle needs the same one — it
 * decides which hours are settled, and an hour is not final until a session timeout after it
 * ends (D36). Two copies would drift, and the symptom would be a cycle reading an hour whose
 * sessions were still open: a silent under-count of the longest, most engaged ones.
 */
export { SESSION_TIMEOUT_MS } from '@morph/core';

interface Env {
  readonly COUNTERS: DurableObjectNamespace<SurfaceCounters>;
}

export class SessionAggregate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    void ctx.blockConcurrencyWhile(async () => {
      this.ensureSchema();
      await Promise.resolve();
    });
  }

  /**
   * Merge a beacon's events for this session.
   *
   * Takes the whole batch because a beacon is one flush from one session, so this is one
   * request per beacon rather than one per event — the difference between roughly a million
   * object requests a day at the design target and five million.
   *
   * The state is written before the alarm is moved. If the write succeeds and the process
   * dies before the alarm is set, the session closes late rather than losing its events;
   * the other order would lose them while looking fine.
   */
  async record(events: readonly FoldableEvent[]): Promise<void> {
    if (events.length === 0) return;

    const state = events.reduce(foldEvent, this.load());
    this.store(state);

    // Replaces any existing alarm, which is the point: every event is activity and the
    // deadline moves with it.
    await this.ctx.storage.setAlarm(Date.now() + SESSION_TIMEOUT_MS);
  }

  /**
   * The session has been idle long enough to be over.
   *
   * Folds it, hands the components to the surface counters, and deletes itself. Deleting is
   * what keeps the object count bounded: a session object exists for the length of a
   * session plus the timeout, not for ever.
   *
   * WHY THE STORAGE IS CLEARED LAST
   * If the fan-out throws, the state stays and the alarm is re-armed, so the next attempt
   * has the same events to work from. The counters' `record` is additive, so a retry after a
   * partial fan-out would double-count the surfaces that already landed — which is the one
   * failure this ordering cannot prevent, and is why it is named in D36 rather than hidden
   * behind a comment claiming it is safe.
   */
  override async alarm(): Promise<void> {
    const state = this.load();
    const components = componentsFor(state);

    if (components.length === 0) {
      // Nothing attributable — a bot, a session that never saw a pageview, or one whose
      // assignment changed. The events were still recorded in Analytics Engine by the
      // collector; what is dropped is only the contribution to the posteriors.
      await this.ctx.storage.deleteAll();
      return;
    }

    // `startedAt`, not `endedAt`: an hour's traffic is the sessions that began in it, and a
    // session's hour should not move as it continues.
    const hourStart = hourStartOf(state.startedAt);

    // Grouped so a session that saw eleven surfaces makes eleven calls rather than one per
    // surface-variant pair.
    const bySurface = new Map<string, HourlyFold[]>();
    for (const row of components) {
      const folds = bySurface.get(row.surfaceId) ?? [];
      folds.push({ ...row, hourStart });
      bySurface.set(row.surfaceId, folds);
    }

    await Promise.all(
      [...bySurface].map(async ([surfaceId, folds]) => {
        // `idFromName` + `get` rather than `getByName`: the one-call form is not in every
        // workerd build, including the one the test pool ships. Both address the same
        // object, deterministically, from the surface id.
        const stub = this.env.COUNTERS.get(this.env.COUNTERS.idFromName(surfaceId));
        await stub.record(folds);
      }),
    );

    await this.ctx.storage.deleteAll();
  }

  /** Exposed for the tests, and for an operator inspecting a live session. */
  state(): SessionState {
    return this.load();
  }

  /**
   * Create the table if it is not there.
   *
   * Called from the constructor and again from `store`, which is not belt-and-braces:
   * `alarm` ends with `deleteAll()`, and that removes the schema along with the row. The
   * constructor does not run again afterwards — the object instance is still alive — so a
   * beacon arriving after the session closed would hit "no such table: fold" and the
   * collector would answer 503.
   *
   * That is not a hypothetical. An offline queue replays events minutes or hours late, which
   * is exactly the case `ingestLagMs`'s long tail exists to describe, and thirty minutes is
   * well inside it. Found by a test asserting the object cleaned up after itself, which
   * failed on the *next* read rather than on the delete.
   *
   * One extra statement per beacon, against a write that already serialises the whole fold.
   */
  private ensureSchema(): void {
    // One row, one session. A table rather than the key-value API because the state is read
    // and rewritten on every beacon, and a single row keeps that one statement.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS fold (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL
      )
    `);
  }

  private load(): SessionState {
    // A missing table is a closed session being read again, which is an empty session
    // rather than an error. Checked through `sqlite_master` instead of catching, so a real
    // SQL fault still surfaces as one.
    const exists = this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'fold'`)
      .one().n;
    if (exists === 0) return emptySession();

    const row = this.ctx.storage.sql
      .exec<{ state: string }>(`SELECT state FROM fold WHERE id = 1`)
      .toArray()[0];

    if (row === undefined) return emptySession();

    // Written by `store` below and by nothing else, so this is not a trust boundary — but a
    // corrupt row would otherwise take the whole session down on every beacon, and an empty
    // session losing its history is a better outcome than an object that can never accept
    // another event.
    try {
      return JSON.parse(row.state) as SessionState;
    } catch {
      return emptySession();
    }
  }

  private store(state: SessionState): void {
    // `emptySession` uses ±Infinity as the min/max identity, and `JSON.stringify` turns
    // those into `null`. A null `startedAt` would read back as not-Infinity, so the next
    // event would believe it was not the first and would skip setting the session's
    // context — putting it in the wrong posterior cell, silently.
    //
    // It cannot happen today, because `record` returns early on an empty batch and so this
    // only ever sees a state with at least one event merged. That is an invariant rather
    // than a coincidence, so it is asserted: a future caller that breaks it gets an
    // exception instead of a session in the wrong cell.
    if (!Number.isFinite(state.startedAt) || !Number.isFinite(state.endedAt)) {
      throw new Error('refusing to store a session with no events merged');
    }

    this.ensureSchema();
    this.ctx.storage.sql.exec(
      `INSERT INTO fold (id, state) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state`,
      JSON.stringify(state),
    );
  }
}
