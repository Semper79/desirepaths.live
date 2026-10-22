/**
 * What `cloudflare:test`'s `env` holds in this project.
 *
 * The pool populates `env` from `wrangler.jsonc` at runtime but the types cannot know that,
 * so the bindings a test actually uses are declared here. Only `COUNTERS`: the other
 * bindings exist in the running Worker and no test under `test/workers` touches them, and
 * declaring a binding nobody uses is an invitation to reach for it without thinking about
 * whether workerd is the right place to test it.
 */

import type { SurfaceCounters } from '../../src/counters';
import type { SessionAggregate } from '../../src/session';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    readonly COUNTERS: DurableObjectNamespace<SurfaceCounters>;
    readonly SESSIONS: DurableObjectNamespace<SessionAggregate>;
  }
}
