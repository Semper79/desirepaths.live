import type { NextConfig } from 'next';

/**
 * The console's Next configuration.
 *
 * Mirrors `apps/web`'s handling of workspace packages — they export TypeScript rather than
 * build output, so Next compiles them, and webpack has to be told that a `./thing.js`
 * import resolves to `./thing.ts`.
 */
const config: NextConfig = {
  reactStrictMode: true,

  transpilePackages: ['@morph/core', '@morph/adaptive', '@morph/ui'],

  webpack(config: { resolve?: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve ??= {};
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

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
