/**
 * `pnpm sim` - run the convergence harness and print the result.
 *
 * This exists so the proof is something a human can look at, not only something CI
 * asserts. When a change to the engine makes the numbers worse, the diff in this
 * output is the fastest way to see how.
 */

import { simulate, STANDARD_WORLD } from './index.js';

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function report(title: string, result: ReturnType<typeof simulate>): void {
  const lines = [
    ``,
    `=== ${title} ===`,
    `steps                 ${String(result.steps)}`,
    `cumulative regret     ${result.cumulativeRegret.toFixed(1)}`,
    `terminal regret rate  ${result.terminalRegretRate.toFixed(5)}  (per impression, last 20%)`,
    `terminal best share   ${pct(result.terminalBestShare)}`,
    `champion              ${result.championVariantId}`,
    `true best (marginal)  ${result.trueBestVariantId}`,
    `adaptive reward       ${pct(result.meanRewardAdaptive)}`,
    `holdout reward        ${pct(result.meanRewardHoldout)}`,
    `measured lift         ${pct(result.relativeLift)}`,
    `impressions           ${Object.entries(result.impressionsByVariant)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('  ')}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

report('standard world', simulate(STANDARD_WORLD));

report(
  'non-stationary world (truth rotates at 60%)',
  simulate({ ...STANDARD_WORLD, steps: 40_000, shiftAtStep: 24_000 }),
);
