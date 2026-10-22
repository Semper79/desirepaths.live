import type { NextConfig } from 'next';

/**
 * Next.js configuration.
 *
 * `transpilePackages` is what makes the internal-source package pattern work: the
 * workspace packages export TypeScript rather than build output, and Next compiles
 * them as part of the app. It removes an entire class of build-ordering problem from
 * a monorepo that never publishes to npm.
 *
 * WHY THERE IS NO WEBPACK HOOK HERE ANY MORE (D38)
 * Next 16 builds with Turbopack, and Turbopack ignored the `webpack()` hook this file used
 * to carry — including the `extensionAlias` that mapped `./thing.js` onto `./thing.ts`.
 * The symptom was a wall of "Export renderRss doesn't exist in target module" against
 * packages whose exports plainly do exist and which typecheck fine: Turbopack resolved
 * `./feed.js` literally, found nothing, and reported a missing file as a missing export.
 *
 * The build was pinned to `--webpack` to get the alias honoured. That bought a working
 * build and nothing else, against a bundler Next is in the process of removing. The
 * extensions are gone from the packages' own sources instead, which is what `CLAUDE.md`
 * said the real fix was: they were there to keep the packages runnable under plain Node,
 * and after the Cloudflare port nothing runs them that way — every consumer is a bundler
 * or tsx. `resolveExtensions` below is what resolves them now.
 */
const config: NextConfig = {
  reactStrictMode: true,

  transpilePackages: [
    '@morph/core',
    '@morph/adaptive',
    '@morph/seo',
    '@morph/ui',
    '@morph/metrics',
  ],

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
    const collector = process.env['MORPH_COLLECTOR_URL'] ?? 'http://localhost:3001';
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

  /**
   * Image optimisation off, because nothing uses it and it costs a native module.
   *
   * This used to configure `formats: ['image/avif', 'image/webp']`, which enables Next's
   * optimiser — and on Next 16 that pulls `sharp` into the bundle. `sharp` ships `.node`
   * binaries, esbuild has no loader for those, and the Worker build failed on a win32
   * binary that could never have run on Workers anyway.
   *
   * There is no `next/image` anywhere in this app, and no `ImageResponse` route either —
   * `icon` and `opengraph-image` were removed because `next/og` resolves its fallback
   * font at module scope and the file it looks for is not in the package (docs/ROADMAP.md).
   * So the optimiser was configured and never used. Turning it off removes a native
   * dependency from a runtime that cannot execute one. If this site ever does need an
   * image resized, that is Cloudflare Images, not a module compiled for the build machine.
   */
  images: { unoptimized: true },

  /**
   * Keeps `sharp` out of Next's own server bundle — and is NOT what keeps it out of the
   * Worker.
   *
   * Worth stating plainly, because this line reads like the fix and was tried as one. The
   * Worker bundle is produced by OpenNext's own esbuild pass, which does not consult a
   * Next setting: it resolved `sharp` out of `next/dist/server/image-optimizer` and died
   * on the `.node` binary with this exactly as it stands.
   *
   * What works is upstream of the build. `ignoredOptionalDependencies` in the root
   * manifest stops sharp being installed for Next at all, and the `hoist-pattern`
   * exclusions in `.npmrc` stop miniflare's own copy — a regular dependency, so not
   * ignorable — being hoisted into the virtual store's shared directory, which sits on
   * Next's resolution path. Remove either and this line will not save the deploy.
   */
  serverExternalPackages: ['sharp'],

  poweredByHeader: false,
};

export default config;
