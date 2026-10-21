/**
 * A stand-in for `cloudflare:workers`, for the Node-pool tests only.
 *
 * WHY THIS EXISTS
 * `worker.ts` re-exports `SurfaceCounters` because wrangler resolves a Durable Object class
 * by name from the Worker's entry module — without that line the binding exists and every
 * call to it fails at runtime. That re-export pulls `cloudflare:workers` into the module
 * graph of anything importing the handler, including `test/ingest.test.ts`, which runs on
 * Node where the module does not exist.
 *
 * WHY A STUB IS HONEST HERE AND WOULD NOT BE IN THE OTHER PROJECT
 * Nothing in the Node project constructs a Durable Object. Those tests drive
 * `worker.fetch`, which touches the ingest path and never the counters — the env stub
 * throws if it is reached, and no test reaches it. So this base class is never extended at
 * runtime in this project; it only has to exist for the import to resolve.
 *
 * The real class is tested against the real runtime in `test/workers/counters.test.ts`,
 * under `@cloudflare/vitest-pool-workers`, where storage, alarms and request serialisation
 * are the genuine implementations. The split is deliberate: mock the thing that is never
 * used, never the thing under test.
 *
 * Deleting this and running the Node tests is a quick way to confirm the above — the
 * failure is immediate and names this module.
 */

/** Matches the shape `extends` needs, and nothing more. */
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: Env,
  ) {}
}
