import { describe, expect, it } from 'vitest';
import { clamp01, outsideUnitDisc } from '../src/math';

describe('clamp01', () => {
  it('passes through values already in range', () => {
    expect(clamp01(0.37)).toBe(0.37);
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
  });

  it('clamps below zero', () => {
    expect(clamp01(-0.4)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });

  it('clamps above one', () => {
    expect(clamp01(1.0000001)).toBe(1);
    expect(clamp01(Infinity)).toBe(1);
  });
});

describe('outsideUnitDisc', () => {
  it('rejects points on or outside the unit circle', () => {
    expect(outsideUnitDisc(1)).toBe(true);
    expect(outsideUnitDisc(1.7)).toBe(true);
  });

  it('rejects the origin, where the polar transform is undefined', () => {
    expect(outsideUnitDisc(0)).toBe(true);
  });

  it('accepts points strictly inside', () => {
    expect(outsideUnitDisc(0.5)).toBe(false);
  });
});
