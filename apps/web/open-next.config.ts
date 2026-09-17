/**
 * OpenNext's Cloudflare adapter configuration (D32).
 *
 * Deliberately close to the default. Every override here is a place where Next's own
 * behaviour has been replaced by something Cloudflare-specific, and each one is a thing
 * that can diverge from what `next build` produced — which is exactly the brittleness
 * Cloudflare cites when recommending vinext instead. Keeping the surface small is how that
 * risk is kept small.
 *
 * NO INCREMENTAL CACHE, AND THAT IS ON PURPOSE
 * OpenNext can back ISR with R2 or KV. This site has nothing to put in it: every route that
 * matters is `force-dynamic`, because the whole point is that the page is resolved per
 * visitor from the posterior snapshot. Configuring a cache here would add a component that
 * never holds anything, and the first person to debug a stale page would spend an hour on
 * it before discovering it was never in the path.
 *
 * The one real cache is the in-process snapshot copy in `lib/snapshot.ts`, which is not
 * Next's to manage.
 */

import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig();
