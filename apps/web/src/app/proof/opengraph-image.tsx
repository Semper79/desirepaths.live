/**
 * The social card for the evidence page, generated from the live numbers.
 *
 * A static card says the same thing in January and in June. This one carries whatever the
 * site currently knows — how many of its own decisions it has settled, and the largest
 * difference it found — so every share is a different, current, checkable claim rather
 * than a logo.
 *
 * That is the whole growth mechanic in one image. Somebody posts a link, the card says
 * "settled 6 of its own design decisions from 240k measured visits", and the interesting
 * part is visible before anyone clicks.
 */

import { ImageResponse } from 'next/og';
import { FALLBACK_TOKENS } from '@morph/ui';
import { currentSnapshot } from '../../lib/resolve.js';
import { proofFrom, format } from '../../lib/proof.js';
import { siteIdentity } from '../../lib/site.js';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'What this site has worked out about itself, from its own measured traffic';

/**
 * Regenerated at most every five minutes.
 *
 * The numbers change hourly, so a shorter window would spend rendering on an image nobody
 * has requested twice. Longer, and a card shared right after a cycle would quote the
 * previous one — which is not wrong, but is less interesting than it could be.
 */
export const revalidate = 300;

export default async function ProofCard(): Promise<ImageResponse> {
  const site = siteIdentity();
  const snapshot = await currentSnapshot();
  const proof = proofFrom(snapshot.arms, snapshot.generatedAt, snapshot.adaptationEnabled);

  const best = proof.settled[0];
  const hero = best === undefined ? null : `+${String(Math.round(best.marginOverWorst * 100))}%`;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 72,
        background: FALLBACK_TOKENS['--color-bg'],
        color: FALLBACK_TOKENS['--color-text'],
      }}
    >
      <div
        style={{
          display: 'flex',
          fontSize: 26,
          letterSpacing: 4,
          color: FALLBACK_TOKENS['--color-accent'],
        }}
      >
        {site.name.toUpperCase()} · EVIDENCE
      </div>

      {hero === null ? (
        <div style={{ display: 'flex', fontSize: 62, lineHeight: 1.08, letterSpacing: '-0.02em' }}>
          Measuring itself. Nothing settled yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 132,
              lineHeight: 1,
              letterSpacing: '-0.04em',
              color: FALLBACK_TOKENS['--color-accent'],
            }}
          >
            {hero}
          </div>
          <div style={{ display: 'flex', fontSize: 40, lineHeight: 1.2, marginTop: 12 }}>
            the largest difference this site found in its own design
          </div>
        </div>
      )}

      <div
        style={{
          display: 'flex',
          fontSize: 26,
          color: FALLBACK_TOKENS['--color-text-muted'],
        }}
      >
        {proof.settled.length} decisions settled · {format(proof.totalImpressions)} measured visits
        · a 5% holdout it is measured against
      </div>
    </div>,
    size,
  );
}
