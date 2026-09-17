/**
 * Parsing a sticky assignment back out of KV.
 *
 * This runs on every returning visitor and its failure mode is invisible from the page:
 * an assignment with a missing surface would be served as if it were complete, and the
 * events attributed to it would land on whatever the gap happened to resolve to. So the
 * parse is strict, and this is where that strictness is pinned down.
 */

import { describe, expect, it } from 'vitest';
import { BASELINE_ASSIGNMENT, SURFACE_KEYS } from '@morph/core';

import { parseAssignment } from '../src/lib/kv-assignment-store.js';

const stored = JSON.stringify(BASELINE_ASSIGNMENT);

/**
 * One real surface key.
 *
 * Read through a check rather than indexed directly: `noUncheckedIndexedAccess` is on, and
 * a registry that somehow had no surfaces should fail here loudly rather than produce
 * `undefined` and quietly test nothing.
 */
const [aSurface] = SURFACE_KEYS;
if (aSurface === undefined) throw new Error('the surface registry is empty');

describe('parseAssignment', () => {
  it('reads back an assignment it wrote', () => {
    expect(parseAssignment(stored)).toEqual(BASELINE_ASSIGNMENT);
  });

  it('rejects an assignment missing a surface rather than filling the gap', () => {
    // The tempting repair is to substitute the baseline. That would convert "this visitor
    // saw a variant we can no longer name" into "this visitor saw the baseline", and the
    // events would then be counted as evidence *for* the baseline. Discarding costs one
    // visitor's stickiness; repairing corrupts a posterior.
    // Built without the key rather than by deleting it: same result, and it keeps the
    // fixture a plain object literal that reads as what it is.
    const complete = JSON.parse(stored) as Record<string, unknown>;
    const partial = Object.fromEntries(
      Object.entries(complete).filter(([surface]) => surface !== aSurface),
    );

    expect(parseAssignment(JSON.stringify(partial))).toBeNull();
  });

  it('rejects a surface whose variant is not a usable string', () => {
    for (const bad of [null, 42, '', {}]) {
      const broken = JSON.parse(stored) as Record<string, unknown>;
      broken[aSurface] = bad;
      expect(parseAssignment(JSON.stringify(broken))).toBeNull();
    }
  });

  it('survives a value that is not an assignment at all', () => {
    // Redis is a shared keyspace and a key can be clobbered by anything. A throw here
    // would be a 500 on a returning visitor.
    expect(parseAssignment('not json')).toBeNull();
    expect(parseAssignment('null')).toBeNull();
    expect(parseAssignment('[]')).toBeNull();
    expect(parseAssignment('"a string"')).toBeNull();
    expect(parseAssignment('{}')).toBeNull();
  });

  it('ignores extra keys, so an older writer stays readable', () => {
    // A surface removed from the registry leaves its key in stored assignments for up to
    // thirty days. Those are still perfectly good assignments for the surfaces that
    // remain, and refusing them would re-roll every returning visitor on deploy.
    const withExtra = { ...BASELINE_ASSIGNMENT, 'surface.removed': 'surface.removed#a' };

    expect(parseAssignment(JSON.stringify(withExtra))).toEqual(BASELINE_ASSIGNMENT);
  });
});
