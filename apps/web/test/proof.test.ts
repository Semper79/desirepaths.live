/**
 * The evidence page's numbers.
 *
 * This is the only page that makes public, checkable claims about how well the system
 * works — which makes it the one place where an overstatement is not a bug but a
 * credibility problem. The tests below are mostly about *not* claiming things: not calling
 * a coin flip settled, not reporting an infinite improvement, not describing evidence that
 * does not exist.
 */

import { describe, expect, it } from 'vitest';
import { SURFACES, SURFACE_KEYS } from '@morph/core';
import type { Arm } from '@morph/adaptive';
import { format, headline, proofFrom } from '../src/lib/proof.js';

const found = SURFACE_KEYS.find((key) => SURFACES[key].variants.length > 1);
if (found === undefined) throw new Error('no surface has more than one variant');
const SURFACE: string = found;

const OTHER = SURFACE_KEYS.find((key) => key !== found);
if (OTHER === undefined) throw new Error('the registry has only one surface');
const SECOND: string = OTHER;

/** Arms at chosen reward rates, with enough evidence to be conclusive. */
function arms(rates: readonly number[], impressions = 20_000): readonly Arm[] {
  return rates.map((rate, index) => ({
    variantId: `v${String(index)}`,
    alpha: rate * impressions,
    beta: (1 - rate) * impressions,
    impressions,
  }));
}

describe('proofFrom', () => {
  it('calls a decisive result settled', () => {
    const proof = proofFrom({ [SURFACE]: arms([0.4, 0.1]) }, 1_000, true);

    expect(proof.settled).toHaveLength(1);
    expect(proof.settled[0]?.winner).toBe('v0');
    expect(proof.settled[0]?.marginOverWorst).toBeCloseTo(3, 1);
  });

  it('refuses to call a coin flip settled', () => {
    // The failure that would matter most. A page claiming a settled result on a 50/50
    // split is not an exaggeration, it is a false statement about a statistical test —
    // and the whole value of publishing these numbers is that they can be checked.
    const proof = proofFrom({ [SURFACE]: arms([0.3, 0.3], 200) }, 1_000, true);

    expect(proof.settled).toHaveLength(0);
    expect(proof.stillDeciding).toHaveLength(1);
    expect(proof.stillDeciding[0]?.challengerChance).toBeGreaterThan(0.05);
  });

  it('uses the same 5% bar the engine retires on', () => {
    // A display threshold looser than the engine's would describe a different system:
    // the page would call something settled that the guardrails would not act on.
    const clear = proofFrom({ [SURFACE]: arms([0.32, 0.28], 50_000) }, 1_000, true);

    expect(clear.settled.length + clear.stillDeciding.length).toBe(1);
    const row = [...clear.settled, ...clear.stillDeciding][0];
    expect(row === undefined ? 1 : row.challengerChance).toBeLessThan(0.5);
  });

  it('never reports an infinite improvement', () => {
    // A worst arm at or near zero would make the ratio explode, and "+∞%" on a public
    // page is not a claim — it is a division that got away.
    const proof = proofFrom({ [SURFACE]: arms([0.4, 0.00002]) }, 1_000, true);
    const row = [...proof.settled, ...proof.stillDeciding][0];

    expect(Number.isFinite(row?.marginOverWorst ?? 0)).toBe(true);
  });

  it('survives an arm that is not a distribution', () => {
    // `parseSnapshot` already rejects these, and this filters them again. The redundancy
    // is the point: `lnGamma` throws on a non-positive parameter, so one malformed entry
    // in a shared Redis key would be a 500 on the most shareable page the site has.
    const broken: readonly Arm[] = [
      { variantId: 'ok', alpha: 400, beta: 600, impressions: 1_000 },
      { variantId: 'zero', alpha: 0, beta: 600, impressions: 1_000 },
      { variantId: 'nan', alpha: Number.NaN, beta: 600, impressions: 1_000 },
    ];

    const proof = proofFrom({ [SURFACE]: broken }, 1_000, true);

    // One usable arm left, so this is not a comparison and must not be reported as one.
    expect(proof.notYetMeasured).toContain(SURFACE);
    expect(proof.settled).toHaveLength(0);
  });

  it('counts a surface with one live variant as unmeasured, not as a finding', () => {
    // One option is not a result. Reporting it would pad the page with decisions nobody
    // made, which is exactly the kind of inflation that makes a numbers page worthless.
    const proof = proofFrom({ [SURFACE]: arms([0.4]) }, 1_000, true);

    expect(proof.settled).toHaveLength(0);
    expect(proof.stillDeciding).toHaveLength(0);
    expect(proof.notYetMeasured).toContain(SURFACE);
  });

  it('accounts for every surface exactly once', () => {
    const proof = proofFrom({ [SURFACE]: arms([0.4, 0.1]) }, 1_000, true);
    const total = proof.settled.length + proof.stillDeciding.length + proof.notYetMeasured.length;

    expect(total).toBe(SURFACE_KEYS.length);
  });

  it('leads with the most convincing finding', () => {
    // A reader scanning the page should meet the strongest thing the site knows, not
    // whichever surface sorts first alphabetically.
    const proof = proofFrom(
      { [SURFACE]: arms([0.2, 0.15]), [SECOND]: arms([0.4, 0.05]) },
      1_000,
      true,
    );

    expect(proof.settled.length).toBeGreaterThanOrEqual(2);
    expect(proof.settled[0]?.key).toBe(SECOND);
  });

  it('reports an honest interval rather than a point estimate', () => {
    const proof = proofFrom({ [SURFACE]: arms([0.4, 0.1]) }, 1_000, true);
    const row = proof.settled[0];

    expect(row?.interval[0]).toBeLessThan(row?.reward ?? 0);
    expect(row?.interval[1]).toBeGreaterThan(row?.reward ?? 1);
  });
});

describe('headline', () => {
  it('says nothing has been measured when nothing has', () => {
    // The empty state is the one most likely to be seen, since it is what every visitor
    // gets before the first cycle. Inventing a plausible number here would be the single
    // most damaging thing this page could do.
    expect(headline(proofFrom({}, 0, true))).toContain('not measured anything yet');
  });

  it('distinguishes gathering evidence from having settled none', () => {
    const gathering = headline(proofFrom({ [SURFACE]: arms([0.3, 0.3], 200) }, 1_000, true));

    expect(gathering).toContain('has not settled');
  });

  it('quotes the largest real difference once there is one', () => {
    const proof = proofFrom({ [SURFACE]: arms([0.4, 0.1]) }, 1_000, true);

    expect(headline(proof)).toContain('300%');
    expect(headline(proof)).toContain('40.0k');
  });
});

describe('format', () => {
  it('is compact enough for a social card', () => {
    expect(format(940)).toBe('940');
    expect(format(12_400)).toBe('12.4k');
    expect(format(2_300_000)).toBe('2.3M');
  });
});
