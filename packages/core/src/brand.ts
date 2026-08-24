/**
 * Branded primitives.
 *
 * A `number` that means "a probability" and a `number` that means "milliseconds"
 * are not the same type, and the compiler is the cheapest place to find out they
 * were swapped. Branding costs one cast at the boundary and buys back an entire
 * class of bug that is otherwise only findable in production statistics.
 *
 * The brand is erased at runtime: these are zero-cost.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** A real number in [0, 1]. Probabilities, rates, normalised scores. */
export type UnitInterval = Brand<number, 'UnitInterval'>;

/** A non-negative count of things that happened. */
export type Count = Brand<number, 'Count'>;

/** Milliseconds. Never seconds. If a value is in seconds it says so in its name. */
export type Millis = Brand<number, 'Millis'>;

/** Identifier of an adaptable surface, e.g. `hero.headline`. */
export type SurfaceId = Brand<string, 'SurfaceId'>;

/** Identifier of a variant within a surface, e.g. `hero.headline#7`. */
export type VariantId = Brand<string, 'VariantId'>;

/** Discretised covariate cell used for Thompson sampling, e.g. `phone|social|1`. */
export type ContextBucket = Brand<string, 'ContextBucket'>;

export class BrandError extends Error {
  constructor(
    readonly kind: string,
    readonly received: unknown,
  ) {
    super(`Invalid ${kind}: ${String(received)}`);
    this.name = 'BrandError';
  }
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * Assert a value into [0, 1].
 *
 * Deliberately throws rather than clamping. A probability outside [0, 1] means an
 * upstream calculation is wrong, and silently clamping it would hide a broken
 * posterior update behind plausible-looking output for weeks.
 */
export function unitInterval(value: number): UnitInterval {
  if (!isFiniteNumber(value) || value < 0 || value > 1) {
    throw new BrandError('UnitInterval', value);
  }
  return value as UnitInterval;
}

/** Clamp into [0, 1]. Use only where the input is measurement noise, never where it is arithmetic. */
export function clampUnit(value: number): UnitInterval {
  if (!isFiniteNumber(value)) throw new BrandError('UnitInterval', value);
  if (value < 0) return 0 as UnitInterval;
  if (value > 1) return 1 as UnitInterval;
  return value as UnitInterval;
}

export function count(value: number): Count {
  if (!Number.isInteger(value) || value < 0) throw new BrandError('Count', value);
  return value as Count;
}

export function millis(value: number): Millis {
  if (!isFiniteNumber(value) || value < 0) throw new BrandError('Millis', value);
  return value as Millis;
}

/**
 * Surface ids are dotted lower-kebab segments: `hero.headline`, `signup.providers_order`.
 * The shape is enforced because these strings end up as ClickHouse LowCardinality
 * dictionary keys and as CSS custom-property name fragments; a stray character
 * there is a silent data-quality problem, not a crash.
 */
const SURFACE_ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/;

export function surfaceId(value: string): SurfaceId {
  if (!SURFACE_ID_RE.test(value)) throw new BrandError('SurfaceId', value);
  return value as SurfaceId;
}

/** Variant ids are `<surfaceId>#<slug>`, so a variant is always traceable to its surface. */
const VARIANT_ID_RE = /^[a-z][a-z0-9_.]*#[a-z0-9][a-z0-9_-]*$/;

export function variantId(value: string): VariantId {
  if (!VARIANT_ID_RE.test(value)) throw new BrandError('VariantId', value);
  return value as VariantId;
}

export function contextBucket(value: string): ContextBucket {
  if (value.length === 0 || value.length > 64) throw new BrandError('ContextBucket', value);
  return value as ContextBucket;
}
