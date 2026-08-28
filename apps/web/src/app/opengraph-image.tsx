import { ImageResponse } from 'next/og';
import { FALLBACK_TOKENS } from '@morph/ui';

/**
 * The social card.
 *
 * Generated from the baseline tokens, for the same reason the icon is: a share card is
 * fetched once by a platform and cached for weeks, so it belongs to the site's identity
 * rather than to one visitor's adaptation. Making it adaptive would mean a platform
 * caching whichever variant its crawler happened to draw — which is the same failure
 * the crawler rule exists to prevent, one layer out.
 *
 * `alt` matters more here than it looks: it is what a screen reader announces when the
 * card is shared into a timeline, and the default of "" would announce nothing.
 */

export const alt = 'MORPH — a website that rebuilds itself around measured visitor behaviour';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage(): ImageResponse {
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
      <div style={{ display: 'flex', fontSize: 28, color: FALLBACK_TOKENS['--color-accent'] }}>
        MORPH
      </div>
      <div style={{ display: 'flex', fontSize: 76, lineHeight: 1.05, letterSpacing: '-0.02em' }}>
        A website that rebuilds itself around you.
      </div>
      <div style={{ display: 'flex', fontSize: 26, color: FALLBACK_TOKENS['--color-text-muted'] }}>
        Eleven adaptive surfaces · a 5% holdout · reported hourly
      </div>
    </div>,
    size,
  );
}
