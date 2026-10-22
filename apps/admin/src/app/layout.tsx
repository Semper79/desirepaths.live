/**
 * The console's shell.
 *
 * Styled from the same design tokens as the public site, using the fallback bag rather
 * than an adaptive one — this console must look identical every time it is opened. An
 * operator diagnosing an incident should not have to wonder whether the interface itself
 * changed since the last time they saw it.
 */

import type { ReactNode } from 'react';
import { FALLBACK_TOKENS } from '@morph/ui';
import { siteName } from '../lib/branding';

export const metadata = {
  title: `${siteName()} — operator console`,
  robots: { index: false, follow: false },
};

const shell = Object.entries(FALLBACK_TOKENS)
  .map(([token, value]) => `${token}: ${value}`)
  .join('; ');

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: 'var(--color-bg)',
          color: 'var(--color-text)',
          fontFamily: 'var(--font-body)',
          fontSize: 15,
          lineHeight: 1.5,
        }}
      >
        <div style={{ display: 'none' }} />
        <style>{`:root { ${shell} }`}</style>
        <main style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 24px 96px' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
