import { ImageResponse } from 'next/og';
import { FALLBACK_TOKENS } from '@morph/ui';

/**
 * The favicon, generated rather than committed.
 *
 * Drawn from the same token bag as the site, so the mark and the interface cannot
 * drift apart — and a designer changing the baseline palette changes the icon without
 * anyone having to remember to re-export a PNG.
 *
 * The baseline palette, not the visitor's: a favicon is cached by the browser across
 * visits and shown in a tab strip next to other sites. An adaptive one would be a
 * flickering mark rather than an identity.
 */

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: FALLBACK_TOKENS['--color-bg'],
        color: FALLBACK_TOKENS['--color-accent'],
        fontSize: 24,
        fontWeight: 700,
        borderRadius: 6,
      }}
    >
      D
    </div>,
    size,
  );
}
