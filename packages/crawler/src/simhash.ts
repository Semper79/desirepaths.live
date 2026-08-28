/**
 * SimHash — near-duplicate detection.
 *
 * The trend pipeline sees the same story from forty sources within an hour: the same
 * wire copy, the same press release, the same paragraph with a different headline. If
 * those all count as separate documents, momentum measures syndication rather than
 * interest, and the cluster that wins is whichever story had the widest distribution
 * list. Deduplication is what makes the momentum score mean anything.
 *
 * WHY SIMHASH AND NOT AN EMBEDDING COMPARISON
 * Embeddings are better at "these say the same thing in different words", and the
 * clustering stage uses them for exactly that. SimHash answers a narrower question —
 * "is this the same text with a byte or two changed" — and answers it in a 64-bit
 * integer comparison instead of a 768-dimensional dot product. At the volume the
 * crawler ingests, the cheap filter has to run first: it removes the overwhelming
 * majority of duplicates before anything expensive is computed on them.
 *
 * WHY 64 BITS AND A HAMMING DISTANCE OF 3
 * The standard from the Charikar/Manku line of work, and it holds up: at 64 bits, a
 * distance of 3 catches reformatted and lightly-edited copies while almost never
 * colliding two genuinely different documents. Raising it starts merging distinct
 * stories about the same subject, which is the clustering stage's job, not this one's.
 */

const HASH_BITS = 64n;
const MASK = (1n << HASH_BITS) - 1n;

/** FNV-1a, 64-bit. Not cryptographic, and does not need to be: only well-distributed. */
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

export function hash64(input: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < input.length; i += 1) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK;
  }
  return h;
}

/**
 * Break text into overlapping word shingles.
 *
 * Shingles rather than single words, because a bag of words has no order: "dog bites
 * man" and "man bites dog" would hash identically. Three words is the usual compromise —
 * long enough to carry order, short enough that an edit only disturbs a few shingles.
 */
export function shingles(text: string, size = 3): readonly string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length === 0) return [];
  // A document shorter than one shingle still needs a fingerprint, or every short
  // document hashes to zero and they all look identical to each other.
  if (words.length < size) return [words.join(' ')];

  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += 1) {
    out.push(words.slice(i, i + size).join(' '));
  }
  return out;
}

/**
 * The SimHash of a document.
 *
 * Each shingle votes on every bit: +1 if the bit is set in its hash, -1 if not. The
 * fingerprint takes the sign of each column. That is what makes the result *locality
 * sensitive* — changing a few shingles changes a few votes, and only the columns that
 * were nearly tied flip.
 */
export function simhash(text: string, shingleSize = 3): bigint {
  const grams = shingles(text, shingleSize);
  if (grams.length === 0) return 0n;

  const votes = new Array<number>(Number(HASH_BITS)).fill(0);

  for (const gram of grams) {
    const h = hash64(gram);
    for (let bit = 0; bit < Number(HASH_BITS); bit += 1) {
      votes[bit] = (votes[bit] ?? 0) + (((h >> BigInt(bit)) & 1n) === 1n ? 1 : -1);
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < Number(HASH_BITS); bit += 1) {
    // A tie resolves to 0. Arbitrary but consistent, which is all that matters: the
    // same input must always produce the same fingerprint.
    if ((votes[bit] ?? 0) > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

/** Number of differing bits. */
export function hammingDistance(a: bigint, b: bigint): number {
  let diff = (a ^ b) & MASK;
  let count = 0;
  while (diff !== 0n) {
    diff &= diff - 1n; // clears the lowest set bit
    count += 1;
  }
  return count;
}

/** The threshold at which two documents are the same story rather than two stories. */
export const NEAR_DUPLICATE_DISTANCE = 3;

export function isNearDuplicate(
  a: bigint,
  b: bigint,
  maxDistance = NEAR_DUPLICATE_DISTANCE,
): boolean {
  return hammingDistance(a, b) <= maxDistance;
}

/** Stored as a decimal string, to survive JSON and a Postgres `numeric(20,0)`. */
export function toStorage(fingerprint: bigint): string {
  return fingerprint.toString();
}

export function fromStorage(value: string): bigint {
  return BigInt(value) & MASK;
}

export interface Deduplicated<T> {
  readonly kept: readonly T[];
  /** What was dropped, and which document it duplicated — the report says why. */
  readonly dropped: readonly { readonly item: T; readonly duplicateOf: T }[];
}

/**
 * Drop near-duplicates from a batch, keeping the first occurrence.
 *
 * Linear against the kept set rather than against everything, which is quadratic in the
 * worst case and fine at an hourly batch of a few thousand. At a scale where it is not,
 * the standard answer is banding — index each fingerprint by several 16-bit chunks and
 * compare only within a band — and it belongs here, behind the same interface.
 *
 * "First occurrence" is deliberate and needs the caller's cooperation: pass documents
 * in the order you would rather keep them. The pipeline sorts by source preference, so
 * an original outranks the syndication of it.
 */
export function deduplicate<T>(
  items: readonly T[],
  fingerprintOf: (item: T) => bigint,
  maxDistance = NEAR_DUPLICATE_DISTANCE,
): Deduplicated<T> {
  const kept: T[] = [];
  const keptPrints: bigint[] = [];
  const dropped: { item: T; duplicateOf: T }[] = [];

  for (const item of items) {
    const print = fingerprintOf(item);
    const index = keptPrints.findIndex((existing) => isNearDuplicate(existing, print, maxDistance));

    if (index >= 0) {
      dropped.push({ item, duplicateOf: kept[index] as T });
      continue;
    }

    kept.push(item);
    keptPrints.push(print);
  }

  return { kept, dropped };
}
