/**
 * Pointing `@morph/metrics` at this deployment's Analytics Engine dataset.
 *
 * The sink defaults to dropping (`NullSink`), so without this call the renderer records
 * nothing — correct on a laptop, and a silent hole in production. This is the one place
 * that closes it.
 *
 * WHY IT IS CALLED PER REQUEST AND WHY THAT IS NOT WASTEFUL
 * A Worker only has `env` inside a request, so there is no boot hook to install this from.
 * `ensureTelemetry()` is therefore called on the render path, and after the first call it
 * is a boolean check. Re-installing would be harmless anyway — the dataset binding is a
 * property of the deployment, identical for every request the isolate serves, which is the
 * argument `sink.ts` makes for why module-level state is safe for this and not for the
 * Cloudflare context.
 *
 * WHY A FAILURE HERE IS SWALLOWED
 * Everything this does is telemetry. A deployment with no `EVENTS` binding should serve
 * pages and be visibly unmonitored — `/api/ready` reports the missing binding — rather
 * than fail to render because it could not set up its own instrumentation.
 */

import { analyticsEngineSink, installMetricSink } from '@morph/metrics';
import { eventsDataset } from './bindings.js';

let installed = false;

export async function ensureTelemetry(): Promise<void> {
  if (installed) return;

  try {
    const dataset = await eventsDataset();
    if (dataset === null) return;

    installMetricSink(analyticsEngineSink(dataset, 'web'));
    installed = true;
  } catch {
    // Left on the null sink, which counts what it drops.
  }
}

/** Test seam, and the way a case can assert the "never installed" path. */
export function __resetTelemetry(): void {
  installed = false;
}
