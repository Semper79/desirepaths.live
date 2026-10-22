import type { NextConfig } from 'next';

/**
 * The console's Next configuration.
 *
 * Mirrors `apps/web`'s handling of workspace packages — they export TypeScript rather than
 * build output, so Next compiles them, and the bundler has to resolve an extensionless
 * relative import to a `.ts` file. See that file's D38 note for why the `webpack()` hook
 * both configs used to carry is gone, and why `resolveExtensions` replaces it.
 */
const config: NextConfig = {
  reactStrictMode: true,

  transpilePackages: ['@morph/core', '@morph/adaptive', '@morph/ui'],

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },

  /**
   * Never indexed, under any circumstances.
   *
   * The public site opts in to indexing through `MORPH_INDEXABLE`. This one has no opt-in
   * because there is no configuration under which an operator console should appear in a
   * search result.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },

  poweredByHeader: false,
};

export default config;
