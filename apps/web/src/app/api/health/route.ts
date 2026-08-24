/**
 * Liveness. Touches no dependency, on purpose — see `apps/api/src/routes/health.ts`
 * for the reasoning, which is identical here.
 */

export const dynamic = 'force-dynamic';

const startedAt = Date.now();

export function GET(): Response {
  return Response.json({
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
}
