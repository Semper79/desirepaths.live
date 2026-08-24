/**
 * LinUCB - the contextual layer.
 *
 * WHAT IT ADDS OVER THOMPSON SAMPLING
 * The Beta posteriors in `thompson.ts` learn one number per (variant, coarse bucket).
 * That is robust but wasteful: it cannot know that "phone visitors from TikTok in the
 * evening" and "phone visitors from Instagram in the evening" are similar, so it
 * relearns each from scratch. LinUCB fits a linear model over the full covariate
 * vector, so evidence is shared across contexts and a thin cell borrows strength from
 * its neighbours.
 *
 * WHY DISJOINT LinUCB AND NOT HYBRID
 * Hybrid LinUCB adds shared coefficients across arms, which helps when arms have
 * features of their own. Here the arms are opaque variants with no natural feature
 * representation, so the shared part would model nothing and cost a second matrix.
 *
 * THE IMPLEMENTATION DETAIL THAT MATTERS
 * The textbook algorithm inverts a d x d matrix per arm per decision. At d = 26 and a
 * 5 ms decision budget shared with everything else on the request path, that is not
 * affordable. Instead the inverse is maintained incrementally with the
 * Sherman-Morrison identity, which turns each update into O(d^2) and each score into
 * a single O(d^2) quadratic form. No matrix is inverted on the request path.
 *
 * WHY THE STATE CARRIES BOTH A AND A^-1
 * Exponential forgetting (see `decayArm`) needs `A' = gamma*A + (1 - gamma)*lambda*I`,
 * and there is no cheap exact way to get `A'^-1` from `A^-1` alone - every closed
 * form is an approximation whose error compounds every cycle. Keeping `A` as well
 * costs d^2 extra doubles per arm (5.4 KB at d = 26) and makes the decay exact: the
 * one O(d^3) inversion happens once per decay cycle in a worker, never in a request.
 * Correctness of the thing that lets the system notice the world changed is worth
 * more than five kilobytes.
 */

/**
 * Read a typed-array cell as a definite number.
 *
 * `noUncheckedIndexedAccess` is on repo-wide and it is right for application code,
 * but inside a numeric kernel where every index is provably in range by construction
 * it would mean a `?? 0` on every access - which is both noise and a branch that can
 * never be taken, silently eroding the branch-coverage guarantee this package makes.
 * One documented cast in one place is the smaller cost.
 */
const at = (a: Float64Array, i: number): number => a[i] as number;

export interface LinUcbArmState {
  /** Row-major d x d design matrix, A = lambda*I + sum(x x^T). */
  readonly a: Float64Array;
  /** Row-major d x d inverse of `a`, maintained incrementally. */
  readonly aInv: Float64Array;
  /** d-vector of accumulated reward-weighted features. */
  readonly b: Float64Array;
  readonly dim: number;
  readonly lambda: number;
  readonly updates: number;
}

export interface LinUcbScore {
  /** Point estimate of expected reward, theta . x. */
  readonly mean: number;
  /** Width of the confidence bound, alpha * sqrt(x^T A^-1 x). */
  readonly bonus: number;
  /** mean + bonus. The quantity actually maximised. */
  readonly ucb: number;
}

/**
 * Create an arm.
 *
 * `lambda` is the ridge parameter; A starts at lambda * I. It is not decoration:
 * with lambda = 0 the first update produces a singular matrix and every subsequent
 * score is NaN. It also encodes the prior belief that coefficients are near zero,
 * which is the right belief before any data has arrived.
 */
export function createArm(dim: number, lambda = 1): LinUcbArmState {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RangeError(`dim must be a positive integer, got ${String(dim)}`);
  }
  if (!(lambda > 0)) throw new RangeError(`lambda must be positive, got ${String(lambda)}`);

  const a = new Float64Array(dim * dim);
  const aInv = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i += 1) {
    a[i * dim + i] = lambda;
    aInv[i * dim + i] = 1 / lambda;
  }
  return { a, aInv, b: new Float64Array(dim), dim, lambda, updates: 0 };
}

/** y = M x. */
function multiply(m: Float64Array, x: readonly number[], dim: number): Float64Array {
  const out = new Float64Array(dim);
  for (let i = 0; i < dim; i += 1) {
    let sum = 0;
    const row = i * dim;
    for (let j = 0; j < dim; j += 1) {
      sum += at(m, row + j) * (x[j] as number);
    }
    out[i] = sum;
  }
  return out;
}

/**
 * Gauss-Jordan inversion with partial pivoting.
 *
 * Only ever called from `decayArm`, once per arm per decay cycle. Partial pivoting
 * is not optional even though the matrices here are positive definite: without it,
 * a design matrix with a tiny leading diagonal entry - which happens whenever a
 * feature is rare in the observed traffic - loses several digits of precision.
 */
export function invert(matrix: Float64Array, dim: number): Float64Array {
  const m = new Float64Array(matrix);
  const inv = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i += 1) inv[i * dim + i] = 1;

  for (let col = 0; col < dim; col += 1) {
    let pivotRow = col;
    let pivotValue = Math.abs(at(m, col * dim + col));
    for (let row = col + 1; row < dim; row += 1) {
      const candidate = Math.abs(at(m, row * dim + col));
      if (candidate > pivotValue) {
        pivotValue = candidate;
        pivotRow = row;
      }
    }

    if (pivotValue < 1e-12) {
      throw new RangeError(`Matrix is singular to working precision at column ${String(col)}.`);
    }

    if (pivotRow !== col) {
      for (let k = 0; k < dim; k += 1) {
        const tmpM = at(m, col * dim + k);
        m[col * dim + k] = at(m, pivotRow * dim + k);
        m[pivotRow * dim + k] = tmpM;
        const tmpI = at(inv, col * dim + k);
        inv[col * dim + k] = at(inv, pivotRow * dim + k);
        inv[pivotRow * dim + k] = tmpI;
      }
    }

    const pivot = at(m, col * dim + col);
    for (let k = 0; k < dim; k += 1) {
      m[col * dim + k] = at(m, col * dim + k) / pivot;
      inv[col * dim + k] = at(inv, col * dim + k) / pivot;
    }

    for (let row = 0; row < dim; row += 1) {
      if (row === col) continue;
      const factor = at(m, row * dim + col);
      if (factor === 0) continue;
      for (let k = 0; k < dim; k += 1) {
        m[row * dim + k] = at(m, row * dim + k) - factor * at(m, col * dim + k);
        inv[row * dim + k] = at(inv, row * dim + k) - factor * at(inv, col * dim + k);
      }
    }
  }

  return inv;
}

/**
 * Rank-1 update: A <- A + x x^T, with the inverse maintained by Sherman-Morrison
 *
 *     (A + x x^T)^-1 = A^-1 - (A^-1 x)(x^T A^-1) / (1 + x^T A^-1 x)
 *
 * and b <- b + reward * x.
 *
 * Returns a new state rather than mutating, so a caller can score a hypothetical
 * update without corrupting the live model - which the simulation harness does on
 * every step.
 */
export function updateArm(
  state: LinUcbArmState,
  features: readonly number[],
  reward: number,
): LinUcbArmState {
  const { dim } = state;
  if (features.length !== dim) {
    throw new RangeError(
      `feature vector has length ${String(features.length)}, expected ${String(dim)}`,
    );
  }

  const aInvX = multiply(state.aInv, features, dim);

  let xtAinvX = 0;
  for (let i = 0; i < dim; i += 1) xtAinvX += (features[i] as number) * at(aInvX, i);

  const denominator = 1 + xtAinvX;
  const nextAInv = new Float64Array(state.aInv);
  const nextA = new Float64Array(state.a);
  for (let i = 0; i < dim; i += 1) {
    const rowFactor = at(aInvX, i) / denominator;
    const row = i * dim;
    const xi = features[i] as number;
    for (let j = 0; j < dim; j += 1) {
      nextAInv[row + j] = at(state.aInv, row + j) - rowFactor * at(aInvX, j);
      nextA[row + j] = at(state.a, row + j) + xi * (features[j] as number);
    }
  }

  const nextB = new Float64Array(state.b);
  for (let i = 0; i < dim; i += 1) nextB[i] = at(state.b, i) + reward * (features[i] as number);

  return {
    a: nextA,
    aInv: nextAInv,
    b: nextB,
    dim,
    lambda: state.lambda,
    updates: state.updates + 1,
  };
}

/**
 * Exponential forgetting for the contextual model.
 *
 * The Beta posteriors are not the only thing that ossifies. The design matrix grows
 * without bound too, and a fully-determined `A` produces a confidence bonus near zero
 * in every context: the model stops being able to notice that it is wrong. The
 * simulation harness shows exactly this - with no forgetting, a world whose best arm
 * changes leaves the learner stuck on the previous winner indefinitely.
 *
 *     A' = gamma * A + (1 - gamma) * lambda * I
 *     b' = gamma * b
 *
 * The ridge floor is preserved exactly, so `A'` can never become singular, and a
 * fresh arm (A = lambda*I) is a fixed point - decaying an arm that has learned
 * nothing changes nothing.
 */
export function decayArm(state: LinUcbArmState, gamma = 0.98): LinUcbArmState {
  if (!(gamma > 0 && gamma <= 1)) {
    throw new RangeError(`decay gamma must be in (0, 1], got ${String(gamma)}`);
  }

  const { dim, lambda } = state;
  const nextA = new Float64Array(dim * dim);
  for (let i = 0; i < dim; i += 1) {
    for (let j = 0; j < dim; j += 1) {
      const idx = i * dim + j;
      const ridge = i === j ? (1 - gamma) * lambda : 0;
      nextA[idx] = gamma * at(state.a, idx) + ridge;
    }
  }

  const nextB = new Float64Array(dim);
  for (let i = 0; i < dim; i += 1) nextB[i] = gamma * at(state.b, i);

  return {
    a: nextA,
    aInv: invert(nextA, dim),
    b: nextB,
    dim,
    lambda,
    updates: Math.round(state.updates * gamma),
  };
}

/**
 * Score an arm in a context.
 *
 * `alpha` controls exploration. The theoretical value from the regret bound is
 * 1 + sqrt(ln(2/delta)/2), which for delta = 0.05 is about 1.36. In production that
 * is usually too exploratory for a site with a business attached, so the default here
 * is lower and the exploration floor in `guardrails.ts` guarantees exploration never
 * reaches zero regardless.
 */
export function scoreArm(
  state: LinUcbArmState,
  features: readonly number[],
  alpha = 0.6,
): LinUcbScore {
  const { dim } = state;
  if (features.length !== dim) {
    throw new RangeError(
      `feature vector has length ${String(features.length)}, expected ${String(dim)}`,
    );
  }

  const aInvB = multiply(state.aInv, [...state.b], dim);
  let mean = 0;
  for (let i = 0; i < dim; i += 1) mean += at(aInvB, i) * (features[i] as number);

  const aInvX = multiply(state.aInv, features, dim);
  let quad = 0;
  for (let i = 0; i < dim; i += 1) quad += (features[i] as number) * at(aInvX, i);

  // Floating-point error can drive a quadratic form very slightly negative when the
  // matrix is near-singular. sqrt of that is NaN, and one NaN in a score array makes
  // every comparison false and the argmax silently return the first element.
  const bonus = alpha * Math.sqrt(quad > 0 ? quad : 0);

  return { mean, bonus, ucb: mean + bonus };
}

/** Serialisable form, for the Redis posterior cache. */
export interface SerialisedArm {
  readonly dim: number;
  readonly lambda: number;
  readonly updates: number;
  readonly a: readonly number[];
  readonly aInv: readonly number[];
  readonly b: readonly number[];
}

export function serialiseArm(state: LinUcbArmState): SerialisedArm {
  return {
    dim: state.dim,
    lambda: state.lambda,
    updates: state.updates,
    a: Array.from(state.a),
    aInv: Array.from(state.aInv),
    b: Array.from(state.b),
  };
}

export function deserialiseArm(data: SerialisedArm): LinUcbArmState {
  if (
    data.a.length !== data.dim * data.dim ||
    data.aInv.length !== data.dim * data.dim ||
    data.b.length !== data.dim
  ) {
    throw new RangeError('Serialised LinUCB arm has inconsistent dimensions.');
  }
  return {
    a: Float64Array.from(data.a),
    aInv: Float64Array.from(data.aInv),
    b: Float64Array.from(data.b),
    dim: data.dim,
    lambda: data.lambda,
    updates: data.updates,
  };
}
