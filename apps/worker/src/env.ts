/**
 * Environment validation for the worker.
 *
 * Parsed once at boot, never read from `process.env` again. The same discipline as
 * `apps/api`: a missing value is one alert at deploy time rather than a mystery at 3am
 * when the first job that happens to need it runs.
 *
 * The one rule that is more than validation is `refineEnv` below. A deterministic
 * embedding provider is genuinely useful in development — it needs no key, no network and
 * no GPU, and it makes the clustering stage exercisable end to end. It is also completely
 * meaningless as a semantic embedding, so a deployment that started with it would cluster
 * documents by hash collision and score topics from noise, and nothing would look broken.
 * That is precisely the failure that has to be impossible rather than discouraged.
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
  MORPH_TIMEZONE: z.string().min(1).default('Europe/Rome'),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(3003),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /** Behaviour lives in ClickHouse; the audience job is the only worker read of it. */
  CLICKHOUSE_URL: z.string().url().default('http://localhost:8123'),
  CLICKHOUSE_DATABASE: z.string().min(1).default('morph'),
  CLICKHOUSE_USER: z.string().min(1).default('default'),
  CLICKHOUSE_PASSWORD: z.string().default(''),

  CRAWLER_USER_AGENT: z
    .string()
    .min(1)
    // §4.1 and docs/COMPLIANCE.md: a crawler a webmaster cannot identify is a crawler a
    // webmaster blocks, and rightly. The contact URL is not decoration.
    .refine((v) => /\+https?:\/\//.test(v), {
      message: 'CRAWLER_USER_AGENT must contain a contact URL, e.g. MorphBot/0.1 (+https://…/bot)',
    }),
  CRAWLER_GLOBAL_QPS: z.coerce.number().int().min(1).max(100).default(8),
  CRAWLER_DEFAULT_CRAWL_DELAY_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
  CRAWLER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  CRAWLER_DENYLIST: csv.default(''),

  /**
   * `deterministic` is a development stand-in and is rejected in production by
   * `refineEnv`. The others name a real provider whose key must also be present.
   */
  EMBEDDING_PROVIDER: z
    .enum(['deterministic', 'voyage', 'openai-compatible'])
    .default('deterministic'),
  EMBEDDING_MODEL: z.string().default('voyage-3-lite'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4_096).default(768),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL_GENERATION: z.string().default('claude-opus-5'),

  /**
   * Autonomy over published content (D8). The worker never publishes regardless — this
   * exists so a future step cannot be added that does, without the value being changed
   * deliberately and visibly.
   */
  SOCIAL_AUTONOMY: z.enum(['off', 'review', 'auto']).default('review'),
});

export type Env = z.infer<typeof EnvSchema>;

export interface EnvProblem {
  readonly variable: string;
  readonly message: string;
}

/**
 * The rules a schema cannot express, because they are about combinations.
 *
 * Returned rather than thrown so every problem is reported at once. Fixing one variable,
 * restarting, and discovering the next one is a bad deploy experience and, more to the
 * point, three restarts of a worker mid-crawl.
 */
export function refineEnv(env: Env): readonly EnvProblem[] {
  const problems: EnvProblem[] = [];

  if (env.NODE_ENV === 'production' && env.EMBEDDING_PROVIDER === 'deterministic') {
    problems.push({
      variable: 'EMBEDDING_PROVIDER',
      message:
        'The deterministic provider is a development stand-in with no semantic meaning. In production it would cluster documents by hash collision and score topics from noise, with nothing appearing broken. Set a real provider.',
    });
  }

  if (env.EMBEDDING_PROVIDER !== 'deterministic' && (env.EMBEDDING_API_KEY ?? '') === '') {
    problems.push({
      variable: 'EMBEDDING_API_KEY',
      message: `EMBEDDING_PROVIDER is "${env.EMBEDDING_PROVIDER}" but no key is set.`,
    });
  }

  if (env.EMBEDDING_PROVIDER === 'openai-compatible' && env.EMBEDDING_BASE_URL === undefined) {
    problems.push({
      variable: 'EMBEDDING_BASE_URL',
      message: 'An OpenAI-compatible provider needs the base URL of the service to call.',
    });
  }

  if ((env.ANTHROPIC_API_KEY ?? '') === '') {
    // A warning would be wrong: the generate queue is scheduled, so it would run, fail,
    // retry and fail again twice a day forever, and the only symptom would be in a log.
    problems.push({
      variable: 'ANTHROPIC_API_KEY',
      message: 'The generate job cannot run without it, and it is scheduled.',
    });
  }

  if (env.SOCIAL_AUTONOMY === 'auto') {
    problems.push({
      variable: 'SOCIAL_AUTONOMY',
      message:
        'Set to "auto" while the safety classifier cannot detect content naming a private individual (D15). That gap is carried by human review, so review is not optional.',
    });
  }

  return problems;
}

export function loadEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const parsed = EnvSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid worker environment:\n  ${detail}`);
  }

  const problems = refineEnv(parsed.data);
  if (problems.length > 0) {
    const detail = problems.map((p) => `${p.variable}: ${p.message}`).join('\n  ');
    throw new Error(`Invalid worker environment:\n  ${detail}`);
  }

  return parsed.data;
}
