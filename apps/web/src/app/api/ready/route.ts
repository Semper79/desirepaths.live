/**
 * Readiness. Checks what the deployment genuinely cannot serve without.
 *
 * A missing pepper is deliberately *not* ready: the site would render, but every visitor
 * would be un-identified and the adaptive layer silently inert. Failing the probe surfaces
 * a misconfiguration at deploy time rather than as a flat line on a dashboard a week later.
 *
 * A missing data controller is not ready either, and for a different kind of reason (D4).
 * The pepper is a quality failure; the controller is a lawful-basis failure. `/privacy`
 * renders an honest notice in that state and the collector refuses every beacon, so the
 * site is not measuring anybody — but it should also not be taking traffic as though it
 * were finished.
 *
 * WHY THE BINDINGS ARE REPORTED BUT DO NOT FAIL THE PROBE
 * `bindingReport()` can tell a laptop from a misconfigured Worker, and on Workers a
 * missing binding is a deployment fault. It is reported rather than fatal because the
 * degradation is honest in each case: no D1 means seed content with a warning, no KV means
 * assignments are not sticky, no METRICS means the deployment is visibly unmonitored.
 * None of those is a site that should be taken out of rotation, and a probe that fails on
 * all of them would make the two above indistinguishable from an unbound dataset.
 */

import { missingControllerFields } from '@morph/core';
import { bindingReport } from '../../../lib/bindings.js';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const missing = [
    ...((process.env['ANON_ID_PEPPER'] ?? '').length >= 32 ? [] : ['ANON_ID_PEPPER']),
    ...((process.env['MORPH_PUBLIC_URL'] ?? '').length > 0 ? [] : ['MORPH_PUBLIC_URL']),
    ...missingControllerFields({
      MORPH_CONTROLLER_NAME: process.env['MORPH_CONTROLLER_NAME'],
      MORPH_CONTROLLER_ADDRESS: process.env['MORPH_CONTROLLER_ADDRESS'],
      MORPH_CONTROLLER_EMAIL: process.env['MORPH_CONTROLLER_EMAIL'],
      MORPH_CONTROLLER_DPO_EMAIL: process.env['MORPH_CONTROLLER_DPO_EMAIL'],
    }),
  ];

  const bindings = await bindingReport();
  const ready = missing.length === 0;

  return Response.json({ ready, missing, bindings }, { status: ready ? 200 : 503 });
}
