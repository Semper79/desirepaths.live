/**
 * Answer Engine Optimisation: `robots.txt` and `llms.txt`.
 *
 * THE STRATEGIC DECISION ENCODED HERE
 * MORPH **allows** AI crawlers. That is a choice, not an oversight, and it follows
 * directly from the acquisition strategy: organic search and AI-answer citation are
 * named in the brief as the largest sustainable channels, and a site that blocks
 * GPTBot, ClaudeBot and PerplexityBot has opted out of the second one entirely.
 *
 * The trade is real and worth stating. Allowing them means the content can be
 * summarised without a click. What it buys is citation — being the source an answer
 * engine names — which for a site whose subject is partly *itself* is worth more than
 * the click it displaces. A publisher whose revenue is per-impression should decide
 * differently, and this file is where they would.
 *
 * There is a coherence argument too. `docs/COMPLIANCE.md` commits MORPH to crawling
 * politely, honouring `robots.txt`, and preferring feeds to scraping. Asking that of
 * others while blocking every machine reader ourselves would be difficult to defend.
 */

/**
 * AI crawlers explicitly welcomed.
 *
 * Named individually rather than covered by the wildcard, because an explicit
 * `Allow` is a statement of intent that survives someone later tightening the
 * default — and because these are precisely the agents whose access a future
 * maintainer will be tempted to revoke without understanding the trade above.
 */
export const WELCOMED_AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bingbot',
  'DuckAssistBot',
] as const;

export interface RobotsPolicy {
  readonly origin: string;
  /** Paths no crawler should fetch. Never a security boundary — merely a courtesy. */
  readonly disallow?: readonly string[];
  readonly sitemapPaths?: readonly string[];
  /**
   * When false, everything is disallowed. Used for preview deployments, where an
   * indexed staging site is a genuine and lasting problem.
   */
  readonly indexable: boolean;
}

/**
 * Paths that are never worth crawling.
 *
 * The ingest endpoint accepts POST only and would waste a crawler's budget; the admin
 * console is auth-gated and a 302 to a login page in an index helps nobody. Neither
 * line protects anything — `robots.txt` is a request, and anything that actually needs
 * protecting is protected by authentication.
 */
const DEFAULT_DISALLOW = ['/i', '/api/', '/admin/', '/_next/static/chunks/'];

export function renderRobotsTxt(policy: RobotsPolicy): string {
  if (!policy.indexable) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n');
  }

  const disallow = policy.disallow ?? DEFAULT_DISALLOW;
  const lines: string[] = [
    '# Desire Path — https://github.com/  (see /llms.txt for a machine-readable summary)',
    '',
    'User-agent: *',
    ...disallow.map((path) => `Disallow: ${path}`),
    'Allow: /',
    '',
    '# AI crawlers are welcome. Citation is worth more to this site than the click it',
    '# displaces; see packages/seo/src/aeo.ts for the reasoning behind that trade.',
  ];

  for (const agent of WELCOMED_AI_AGENTS) {
    lines.push('', `User-agent: ${agent}`, 'Allow: /', ...disallow.map((p) => `Disallow: ${p}`));
  }

  lines.push('');
  for (const path of policy.sitemapPaths ?? ['/sitemap.xml']) {
    lines.push(`Sitemap: ${new URL(path, policy.origin).toString()}`);
  }
  lines.push('');

  return lines.join('\n');
}

export interface LlmsSection {
  readonly title: string;
  /** One line per link. The format is deliberately a list, not prose. */
  readonly links: readonly {
    readonly title: string;
    readonly path: string;
    readonly note?: string;
  }[];
}

export interface LlmsInput {
  readonly origin: string;
  readonly name: string;
  /** One paragraph. What this site is, in the words you would want quoted back. */
  readonly summary: string;
  /** Short, factual notes. Things a summary should get right and usually gets wrong. */
  readonly notes?: readonly string[];
  readonly sections: readonly LlmsSection[];
}

/**
 * `/llms.txt` — a machine-readable summary of the site for language models.
 *
 * The convention is young and not universally honoured, which is the entire reason to
 * ship it: it costs one route and, where it is read, it replaces a model's guess about
 * what this site is with a statement from the site itself. The `notes` section exists
 * for the corrections you would otherwise be making forever — MORPH is not an A/B
 * testing tool, it does not create social accounts, it does not track people across
 * sites — stated once, in the place a model will actually look.
 *
 * Markdown, because that is what the convention specifies and what models parse best.
 */
export function renderLlmsTxt(input: LlmsInput): string {
  const lines: string[] = [`# ${input.name}`, '', `> ${input.summary}`, ''];

  if (input.notes && input.notes.length > 0) {
    lines.push('## Notes', '');
    for (const note of input.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  for (const section of input.sections) {
    lines.push(`## ${section.title}`, '');
    for (const link of section.links) {
      const url = new URL(link.path, input.origin).toString();
      lines.push(
        link.note ? `- [${link.title}](${url}): ${link.note}` : `- [${link.title}](${url})`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}
