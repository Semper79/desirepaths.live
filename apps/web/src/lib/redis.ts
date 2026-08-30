/**
 * The renderer's one Redis connection.
 *
 * Two things need it — the posterior snapshot and the sticky assignment store — and they
 * share a client rather than opening one each. Not for the sake of tidiness: a Next
 * instance under load holding two connections that both reconnect independently produces
 * two error streams and two sets of timers for one outage, and the second connection buys
 * nothing because both do a single command per request at most.
 *
 * WHY THESE OPTIONS
 * The renderer would always rather answer with what it has than wait. Every timeout here
 * is short and every failure is survivable: a missing snapshot means baselines, a missing
 * sticky assignment means the visitor is re-rolled. Neither is an error page.
 *
 * `enableOfflineQueue` stays on, deliberately. Turning it off makes commands fail
 * instantly, which sounds ideal until you notice it also fails the *first* command after
 * boot — the one that triggers the connection — so nothing would ever be read on the first
 * attempt. Queuing it and bounding the wait is the combination that works.
 */

import Redis from 'ioredis';

let client: Redis | null = null;

/** `null` when no `REDIS_URL` is configured, which is a supported state, not a broken one. */
export function redis(): Redis | null {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url.length === 0) return null;

  if (client === null) {
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
      commandTimeout: 500,
      lazyConnect: true,
    });

    // Required, not optional politeness. An ioredis client with no error listener emits an
    // unhandled EventEmitter error event on every failed reconnect — which Node treats as
    // a throw, from a background timer, with no request to attribute it to. Found by
    // pointing this at a dead port and watching the log.
    //
    // Swallowed rather than logged per event: a Redis that is down produces one of these
    // every retry interval for as long as it is down, and a renderer whose log fills with
    // them buries whatever else is happening. The outage is already visible where it
    // matters — the snapshot stops advancing and the freshness term on the page falls.
    client.on('error', () => {});
  }

  return client;
}

/** Test seam. Drops the memoised client so a case can change `REDIS_URL`. */
export function __resetRedis(): void {
  client = null;
}
