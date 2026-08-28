import type { NextConfig } from 'next';

/**
 * Next.js configuration.
 *
 * `transpilePackages` is what makes the internal-source package pattern work: the
 * workspace packages export TypeScript rather than build output, and Next compiles
 * them as part of the app. It removes an entire class of build-ordering problem from
 * a monorepo that never publishes to npm.
 */
const config: NextConfig = {
  reactStrictMode: true,

  transpilePackages: ['@morph/core', '@morph/adaptive', '@morph/seo', '@morph/ui'],

  /**
   * Resolve `./thing.js` to `./thing.ts`.
   *
   * The workspace packages write ESM-correct relative imports with a `.js` extension,
   * which is what Node requires and what makes them consumable outside a bundler.
   * Webpack does not make that substitution on its own, so it has to be told — the
   * alternative is stripping the extensions from the source, which would trade a
   * three-line config for a package that no longer runs under plain Node.
   */
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

  // The adaptive shell is dynamic by definition; everything else should be static or
  // revalidated. Partial prerendering is what lets one page be both.
  experimental: {
    optimizePackageImports: ['@morph/core', '@morph/ui'],
  },

  /**
   * Send the beacon to the collector in local development.
   *
   * In production Caddy routes `/i` to `apps/api`; locally there is no Caddy, so the
   * beacon would POST to the Next server and get a 404. Rather than teaching the client
   * a different URL for development — which would mean the thing being tested is not
   * the thing that ships — the rewrite reproduces what the edge does.
   *
   * Development only. In production this must not exist: a rewrite that quietly proxies
   * to a hard-coded localhost port is a failure waiting for the first deploy where the
   * collector is somewhere else.
   */
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    const collector = process.env.MORPH_COLLECTOR_URL ?? 'http://localhost:3001';
    return [{ source: '/i', destination: `${collector}/i` }];
  },

  // Security headers duplicated from the Caddyfile on purpose: in local development
  // there is no Caddy, and a CSP that only exists in production is a CSP nobody
  // develops against and everybody fights on the day of the deploy.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ];
  },

  // A generated image is a cache entry, not a build artefact.
  images: { formats: ['image/avif', 'image/webp'] },

  poweredByHeader: false,
};

export default config;
