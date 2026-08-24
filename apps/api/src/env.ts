/**
 * Environment validation.
 *
 * Parsed once at boot and never read from `process.env` again. A missing or malformed
 * value fails the process immediately with a message naming the variable — which is one
 * alert at deploy time rather than a mystery at 3am when the first request that happens
 * to need it arrives.
 *
 * Defaults exist only for values that are genuinely optional. `ANON_ID_PEPPER` has no
 * default on purpose: a placeholder pepper that silently works in production is a
 * privacy incident with no symptom.
 */

import { z } from 'zod';

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  MORPH_PUBLIC_URL: z.string().url(),
  MORPH_TIMEZONE: z.string().min(1).default('Europe/Rome'),

  ANON_ID_PEPPER: z
    .string()
    .min(
      32,
      'ANON_ID_PEPPER must be at least 32 characters; generate one with `openssl rand -hex 32`',
    )
    .refine((v) => !v.startsWith('replace-with-'), {
      message: 'ANON_ID_PEPPER is still the placeholder from .env.example',
    }),

  REDPANDA_BROKERS: csv.pipe(z.array(z.string()).min(1)),
  REDPANDA_TOPIC_EVENTS: z.string().default('morph.events.v1'),
  REDPANDA_LINGER_MS: z.coerce.number().int().min(0).max(1_000).default(5),
  REDPANDA_BATCH_BYTES: z.coerce.number().int().min(1024).default(65_536),

  PROMETHEUS_METRICS_PORT: z.coerce.number().int().default(9464),

  /** Development only. Reading this as truthy in production is a hard boot failure. */
  MORPH_DEV_BYPASS_CONSENT: z.coerce.number().int().min(0).max(1).default(0),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${detail}\n\nSee .env.example.`);
  }

  const env = parsed.data;

  // A flag that only makes sense in development must not merely be discouraged in
  // production; it must make the process refuse to start.
  if (env.NODE_ENV === 'production' && env.MORPH_DEV_BYPASS_CONSENT === 1) {
    throw new Error('MORPH_DEV_BYPASS_CONSENT must not be set in production.');
  }

  if (env.NODE_ENV === 'production' && !env.MORPH_PUBLIC_URL.startsWith('https://')) {
    throw new Error('MORPH_PUBLIC_URL must use https in production.');
  }

  return env;
}
