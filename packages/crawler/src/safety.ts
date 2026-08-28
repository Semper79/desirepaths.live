/**
 * Topic safety: what MORPH will not write about on its own.
 *
 * §6.4 of the master spec. This is the gate between "a topic is trending" and "a topic
 * becomes a page", and it is the single most consequential piece of the pipeline, because
 * everything downstream of it is automated. A wrong `allow` here means a generated
 * article about an unfolding tragedy goes live with nobody having read it.
 *
 * THE ASYMMETRY THAT SETS EVERY THRESHOLD
 * A false `block` costs one article. A false `allow` costs the site's credibility, and
 * possibly somebody real. So the classifier is deliberately blunt and deliberately
 * over-triggers: `review` is the default for anything ambiguous, and `review` is cheap —
 * it queues the topic for the operator instead of discarding it.
 *
 * WHY RULES AND NOT A MODEL
 * A model would classify better on average. But this gate has to be auditable — the
 * operator has to be able to ask "why was this blocked" and get an answer that is a rule
 * with a name, not a probability. It also has to be deterministic: the same topic must
 * get the same verdict every run, or the review queue fills with topics that were allowed
 * yesterday and blocked today. A model belongs *after* this gate, narrowing what survives
 * it — never replacing it.
 *
 * WHAT THIS IS NOT
 * Not a content moderation system, and not a claim that the categories below are the only
 * harmful ones. It is a list of subjects where automated publication is inappropriate
 * regardless of how the article turns out.
 *
 * THE ONE CATEGORY THIS CANNOT ENFORCE
 * `docs/COMPLIANCE.md` §5 also lists "anything naming a private individual". Term
 * matching cannot detect that — it needs named-entity recognition plus a judgement about
 * whether the person named is public, and a rule set that tried would either miss most
 * cases or block every article mentioning anybody. It is therefore *not* enforced here,
 * and is instead carried by keeping `SOCIAL_AUTONOMY` at `review`, where a human sees the
 * draft. Naming the gap is the point: a claim in a compliance document that no code
 * implements is worse than an acknowledged limitation.
 */

export type SafetyVerdict = 'allow' | 'review' | 'block';

export interface SafetyCategory {
  readonly id: string;
  /** What the operator sees, verbatim, in the review queue and the hourly report. */
  readonly label: string;
  readonly verdict: Exclude<SafetyVerdict, 'allow'>;
  /** Why this category exists. Quoted in `docs/COMPLIANCE.md`. */
  readonly reason: string;
  readonly terms: readonly string[];
}

/**
 * Matched on whole words, case-insensitively, against title and body.
 *
 * The lists are short on purpose. A long list looks thorough and behaves worse: every
 * added term is another way to block something innocuous, and the operator stops reading
 * the review queue once it fills with noise. These are terms whose presence genuinely
 * changes what the topic is.
 */
export const SAFETY_CATEGORIES: readonly SafetyCategory[] = [
  {
    id: 'electoral',
    label: 'Elections and party politics',
    verdict: 'block',
    reason:
      'Automated political content is regulated in the EU (and elsewhere) and the site has no editorial process that would satisfy those obligations. Not a judgement about the topic — an admission about the publisher.',
    terms: [
      'election',
      'elections',
      'referendum',
      'ballot',
      'candidate',
      'candidates',
      'vote',
      'votes',
      'voting',
      'electoral',
      'parliament',
      'senate',
      'congress',
      'coalition',
      'campaign trail',
    ],
  },
  {
    id: 'tragedy',
    label: 'Violence, disaster and loss of life',
    verdict: 'block',
    reason:
      'Real people are involved and facts change hourly. Nothing generated is worth the risk of being wrong in public about a death.',
    terms: [
      'shooting',
      'stabbing',
      'massacre',
      'terror',
      'terrorist',
      'bombing',
      'earthquake',
      'hurricane',
      'wildfire',
      'crash',
      'casualties',
      'fatalities',
      'dead',
      'killed',
      'missing persons',
      'hostage',
      'war',
      'airstrike',
      'evacuation',
    ],
  },
  {
    id: 'medical',
    label: 'Medical claims and health advice',
    verdict: 'block',
    reason:
      'Generated health advice can be acted on. The site is not qualified to give it, and a disclaimer does not make it safe.',
    terms: [
      'diagnosis',
      'symptoms',
      'treatment',
      'cure',
      'dosage',
      'prescription',
      'vaccine',
      'clinical trial',
      'side effects',
      'therapy',
      'supplement',
      'cancer',
      'outbreak',
      'epidemic',
      'pandemic',
    ],
  },
  {
    id: 'financial',
    label: 'Investment and financial advice',
    verdict: 'block',
    reason:
      'Regulated advice in every jurisdiction the site is readable from, and the failure mode is somebody losing money on a machine-written recommendation.',
    terms: [
      'invest',
      'investment',
      'stocks',
      'shares',
      'portfolio',
      'crypto',
      'cryptocurrency',
      'bitcoin',
      'trading',
      'returns',
      'yield',
      'buy now',
      'price target',
      'forecast',
      'bull run',
    ],
  },
  {
    id: 'minors',
    label: 'Content concerning children',
    verdict: 'block',
    reason:
      'No automated content about identifiable minors, in any framing. There is no version of this that is worth getting wrong.',
    terms: [
      'child',
      'children',
      'minor',
      'minors',
      'teenager',
      'teenagers',
      'schoolgirl',
      'schoolboy',
      'toddler',
      'infant',
    ],
  },
  {
    id: 'adult',
    label: 'Adult content',
    verdict: 'block',
    reason:
      'Out of scope for the site regardless of context, and the terms are unambiguous enough that a rule set handles it without over-triggering.',
    terms: [
      'pornography',
      'porn',
      'explicit content',
      'nudity',
      'sex work',
      'escort',
      'onlyfans',
      'nsfw',
    ],
  },
  {
    id: 'legal',
    label: 'Ongoing legal proceedings',
    verdict: 'block',
    reason:
      'Naming people in connection with allegations is defamation exposure, and reporting restrictions vary by jurisdiction in ways no rule set can encode.',
    terms: [
      'lawsuit',
      'indictment',
      'indicted',
      'convicted',
      'acquitted',
      'allegations',
      'alleged',
      'trial',
      'testimony',
      'plaintiff',
      'defendant',
      'settlement',
      'injunction',
    ],
  },
  {
    id: 'breaking',
    label: 'Unverified breaking news',
    verdict: 'review',
    reason:
      'Not inherently unsafe, but the facts are not settled yet. Held for the operator rather than dropped, because by the time it is verified it may be exactly what to publish.',
    terms: [
      'breaking',
      'developing',
      'unconfirmed',
      'reportedly',
      'sources say',
      'rumour',
      'rumor',
      'speculation',
      'leaked',
    ],
  },
  {
    id: 'identity',
    label: 'Protected characteristics as the subject',
    verdict: 'review',
    reason:
      'A topic can be perfectly legitimate and still be one where a generated framing lands badly. Held for a human read rather than blocked outright.',
    terms: [
      'immigration',
      'immigrant',
      'immigrants',
      'refugee',
      'refugees',
      'religion',
      'religious',
      'ethnic',
      'racial',
      'gender identity',
      'sexuality',
      'abortion',
    ],
  },
];

export interface SafetyAssessment {
  readonly verdict: SafetyVerdict;
  /** Every category that fired, not just the decisive one — the operator sees all of it. */
  readonly matches: readonly {
    readonly categoryId: string;
    readonly label: string;
    readonly verdict: Exclude<SafetyVerdict, 'allow'>;
    readonly reason: string;
    /** The exact terms that fired, so a bad rule is visible and fixable. */
    readonly terms: readonly string[];
  }[];
  /** One line for the report and the audit record. */
  readonly summary: string;
}

/**
 * Whole-word, case-insensitive, accent-insensitive matching.
 *
 * Whole-word matters more than it looks: substring matching puts `war` inside `warm`,
 * `award` and `software`, and a classifier that blocks every article containing the word
 * "software" is a classifier the operator turns off.
 *
 * Multi-word terms are matched as phrases with flexible whitespace, so "sources say" also
 * catches "sources  say" and a line break between the two words.
 */
export function containsTerm(haystack: string, term: string): boolean {
  const normalised = normalise(haystack);
  const pattern = term
    .split(/\s+/)
    .map((word) => escapeRegExp(normalise(word)))
    .join('\\s+');

  return new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'u').test(normalised);
}

function normalise(value: string): string {
  // Decompose then strip combining marks, so "réfugiés" matches "refugies". Without this,
  // the classifier is quietly English-only while claiming otherwise.
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Assess a topic.
 *
 * `block` beats `review` beats `allow`: one blocking category is enough, however many
 * others were clean. There is no scoring and no threshold here on purpose — a topic being
 * "only slightly about" an ongoing trial is not a reason to publish about it.
 */
export function assessSafety(input: {
  readonly title: string;
  readonly text: string;
}): SafetyAssessment {
  const haystack = `${input.title}\n${input.text}`;
  const matches: SafetyAssessment['matches'][number][] = [];

  for (const category of SAFETY_CATEGORIES) {
    const hits = category.terms.filter((term) => containsTerm(haystack, term));
    if (hits.length === 0) continue;

    matches.push({
      categoryId: category.id,
      label: category.label,
      verdict: category.verdict,
      reason: category.reason,
      terms: hits,
    });
  }

  const blocking = matches.filter((m) => m.verdict === 'block');
  const verdict: SafetyVerdict =
    blocking.length > 0 ? 'block' : matches.length > 0 ? 'review' : 'allow';

  return { verdict, matches, summary: summarise(verdict, matches) };
}

function summarise(verdict: SafetyVerdict, matches: SafetyAssessment['matches']): string {
  if (verdict === 'allow') return 'No safety category matched.';

  const decisive = matches.filter((m) => m.verdict === (verdict === 'block' ? 'block' : 'review'));
  const labels = decisive.map((m) => m.label).join('; ');

  return verdict === 'block'
    ? `Blocked from automated publication: ${labels}.`
    : `Held for operator review: ${labels}.`;
}

/**
 * The check the generation worker calls before enqueuing anything.
 *
 * Separate from `assessSafety` so the call site reads as the decision it is making, and
 * so nobody has to remember which verdicts are publishable.
 */
export function mayGenerateAutomatically(assessment: SafetyAssessment): boolean {
  return assessment.verdict === 'allow';
}
