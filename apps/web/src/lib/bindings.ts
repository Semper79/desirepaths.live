/**
 * The renderer's access to its Cloudflare bindings.
 *
 * One module, because a binding lookup that throws in the wrong place is the difference
 * between a page that falls back and a page that 500s, and that judgement should be made
 * once rather than at every call site.
 *
 * WHY EVERY ACCESSOR RETURNS `null` RATHER THAN THROWING
 * There are three situations, and only one of them is a fault:
 *
 *   1. Running on Workers with the binding configured — the normal case.
 *   2. Running on a laptop under `next dev` with no Wrangler context at all. Legitimate:
 *      `pnpm dev` has to work without a Cloudflare account, exactly as it worked without
 *      Docker before (see `db.ts`). Here there are no bindings and that is not an error.
 *   3. Running on Workers with a binding missing from `wrangler.jsonc`. A deployment
 *      fault, and the only one of the three that should be loud.
 *
 * This module cannot tell 2 from 3 on its own, so it does not try: it reports absence and
 * lets the caller decide. `db.ts` treats an absent D1 as "serve seed content and warn
 * once"; `assignment-store` treats an absent KV as "no sticky assignment", which is a
 * state it already handled. The loud version of 3 belongs in `/api/ready`, which is where
 * a deployment check looks and where a missing binding should keep the deployment from
 * taking traffic.
 *
 * WHY THE CONTEXT IS FETCHED PER CALL AND NOT MEMOISED
 * On Workers `env` belongs to the request, not to the isolate. Caching the object across
 * requests is the classic way to leak one request's context into another's, and it works
 * perfectly in testing because a single-request test never notices. The lookup is a
 * property read; there is nothing to save.
 */

import type { AnalyticsEngineDataset, D1Database, KVNamespace } from '@cloudflare/workers-types';

/**
 * The bindings this app declares in `wrangler.jsonc`.
 *
 * Optional to a one, because TypeScript should not promise something the platform will
 * only supply if the configuration is right. A required type here would push every
 * absence into a runtime crash the type system had claimed was impossible.
 */
export interface MorphBindings {
  /** Content, the adaptation log, configuration, rollups. D31. */
  readonly DB?: D1Database;
  /** Sticky assignments, keyed on the rotating daily anonymous id. D33. */
  readonly ASSIGNMENTS?: KVNamespace;
  /** The published posterior snapshot, written by the adapt cron. */
  readonly SNAPSHOT?: KVNamespace;
  /** The raw event stream. Sampled, and therefore never a source for a posterior. D33. */
  readonly EVENTS?: AnalyticsEngineDataset;
}

/**
 * The Cloudflare context, or `null` when there is not one.
 *
 * The import is dynamic because `@opennextjs/cloudflare` pulls in Worker-only globals;
 * a static import makes it a hard dependency of every module that transitively touches
 * this one, including the unit tests, which run in Node.
 */
async function cloudflareEnv(): Promise<MorphBindings | null> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    // The async form: the sync one throws outside a request, which includes the static
    // shell pass `next build` runs over every route.
    const context = await getCloudflareContext({ async: true });
    return (context.env as MorphBindings | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The D1 database, or `null` when unbound. */
export async function d1(): Promise<D1Database | null> {
  return (await cloudflareEnv())?.DB ?? null;
}

/** The sticky-assignment namespace, or `null` when unbound. */
export async function assignmentKv(): Promise<KVNamespace | null> {
  return (await cloudflareEnv())?.ASSIGNMENTS ?? null;
}

/** The posterior-snapshot namespace, or `null` when unbound. */
export async function snapshotKv(): Promise<KVNamespace | null> {
  return (await cloudflareEnv())?.SNAPSHOT ?? null;
}

/** The event dataset, or `null` when unbound. */
export async function eventsDataset(): Promise<AnalyticsEngineDataset | null> {
  return (await cloudflareEnv())?.EVENTS ?? null;
}

/**
 * Which bindings are present, for `/api/ready`.
 *
 * A readiness probe is the one place that should be able to tell case 2 from case 3 above,
 * and it can, because it knows whether it is running on Workers: `cloudflareEnv()`
 * returning an object at all means the platform is there and any gap in it is a
 * configuration fault rather than a laptop.
 */
export async function bindingReport(): Promise<{
  readonly onWorkers: boolean;
  readonly missing: readonly string[];
}> {
  const env = await cloudflareEnv();
  if (env === null) return { onWorkers: false, missing: [] };

  const required: readonly (keyof MorphBindings)[] = ['DB', 'ASSIGNMENTS', 'SNAPSHOT', 'EVENTS'];
  return {
    onWorkers: true,
    missing: required.filter((name) => env[name] === undefined),
  };
}
