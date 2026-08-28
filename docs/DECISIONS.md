# Open decisions

Section 9.5 of the brief: "A list of every open decision you need me to make, with your
recommendation for each."

Each entry states the decision, why it cannot be deferred indefinitely, the options,
and a recommendation with its reasoning. Where a decision was already forced by
building Phases 0–2, it is marked **Taken** with the rationale, so it can be revisited
deliberately rather than discovered by accident.

Decisions are grouped by when they bite. Nothing in "Blocking Phase 3" can be worked
around; everything else has a defensible default already implemented.

---

## Blocking Phase 3 (the public site)

### D1 — What is MORPH actually about?

The adaptive machinery is content-agnostic, but the site is not. Every headline, every
trend-scoring weight and every safety rule depends on what the site is _for_, and the
"audience interest vector" that scores trend clusters cannot be bootstrapped without a
starting position.

| Option                                                                                                         | Consequence                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Meta-product**: the site is about itself — a public, live demonstration of a website that rebuilds itself | Strongest launch story, zero content dependency, naturally viral among the technical audience. Ceiling on total addressable audience. |
| B. Vertical publication (e.g. emerging technology and internet culture)                                        | Larger audience, real SEO/AEO surface, but needs sustained editorial judgement and competes with established publishers.              |
| C. Utility with an adaptive shell (a tool that happens to adapt)                                               | Highest retention, but the adaptive engine becomes decoration rather than the product.                                                |

**Recommendation: A, with a path to B.** The hand-authored variants in
`packages/core/src/surfaces/registry.ts` are written for A — "This page is not the same
page it was", "Watch it learn". A is the only option where the product and its own
marketing are the same artefact, which at zero traffic is worth more than a larger
theoretical audience. Section 3's trend pipeline then feeds a `/trending` section that
is _about_ what the web finds interesting, which is B arriving gradually and with
evidence rather than as an editorial bet on day one.

**What I need:** confirmation, or a one-paragraph description of the subject if not A.

---

### D2 — Domain and brand name

Needed for OAuth callback registration, the crawler's User-Agent contact URL, ACME
certificate issuance and every platform's app review. Several of those have multi-day
turnarounds, so this blocks more than it looks like it does.

**Recommendation:** register the domain before Phase 4 begins. Provider app review
(TikTok and Meta in particular) takes days to weeks and cannot start without a live
privacy policy at a stable URL.

**What I need:** the domain.

---

### D3 — Hosting and jurisdiction

| Option                                         | Notes                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Hetzner CCX23, Falkenstein (DE)**         | The brief's own suggestion. 8 vCPU / 32 GB, ~€49/mo, EU jurisdiction, no US transfer question.                             |
| B. Hetzner CCX33 (16 vCPU / 64 GB)             | ~€100/mo. Buys roughly 3× the headroom on ClickHouse merges, which `infra/SCALING.md` identifies as the second bottleneck. |
| C. Managed (Neon + ClickHouse Cloud + Upstash) | 4–8× the cost at this scale, far less operational work, and the compliance story becomes a list of sub-processors.         |

**Recommendation: A.** The load-test target is 5,000 req/s on ingest; a single CCX23
handles that with the async-insert configuration already in the compose file. Moving to
B is a one-line change with no migration. Choosing C at launch means paying for elastic
scale before the traffic that would justify it exists.

**What I need:** confirmation, plus who holds the account (this matters for GDPR
controller identification).

---

### D4 — Legal identity of the data controller

Not deferrable: `docs/PRIVACY.md` must name a controller and a contact address, and it
must be published before the first visitor is measured. A sole trader, an SRL and a
foreign entity have materially different obligations.

**Recommendation:** name the operating entity, or the individual if there is no company
yet. If EU-based with no establishment elsewhere, no Article 27 representative is
needed. If processing scales past "regular and systematic monitoring on a large scale" —
which 5M events/day plausibly is — a DPO becomes a live question; see `docs/PRIVACY.md`.

**What I need:** legal entity name, registered address, and a contact email for
data-subject requests.

---

## Blocking Phase 4 (sign-up)

### D5 — Which OAuth providers ship at launch

Ten providers are specified. Each one is a developer account, an app review, a set of
callback URLs and a maintenance surface — and the adaptive provider-ordering surface
needs _fewer_ options than you might expect to work well, because each one has to earn
its own evidence.

**Recommendation: launch with five** — Google, Apple, Discord, TikTok, and passkeys —
plus email magic link as the no-social path. Rationale: Google and Apple cover the
mainstream and the iOS default; Discord and TikTok are where the target audience
actually is; passkeys are the fastest path for returning visitors and a genuine
differentiator. X, Reddit, Twitch, Spotify and Instagram are all declared in
`.env.example` and simply stay unset — the registry handles absent providers by
removing them from the variant space, so adding one later is a credential, not a
release.

**What I need:** agreement, or a different five.

---

### D6 — Does the site require sign-up to be useful?

This decides whether the composite reward's 40% sign-up weight is measuring value or
measuring a wall.

| Option                                                         | Consequence                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Fully open, sign-up adds personalisation and the digest** | Best for SEO/AEO and for the trend pipeline's value; sign-up rate will be low (1–3%) and the optimiser has to work hard for every point. |
| B. Metered (n free pieces, then sign-up)                       | Higher conversion, materially worse organic acquisition, and it makes the site adversarial in a way that contradicts its own pitch.      |

**Recommendation: A.** Organic search and AI-answer citation are named in section 6 as the
largest sustainable acquisition channels, and a wall is the single most reliable way to
lose both. A 2% sign-up rate on large traffic beats 8% on small traffic, and the
holdout-lift measurement stays honest either way.

---

## Blocking Phase 5 (crawling and content)

### D16 — Which embedding provider

The pipeline's clustering, audience fit and topic scoring all run on 768-dimension
embeddings, and there is no default that is both free and meaningful. The worker ships a
`deterministic` provider that hashes text into the right shape with no semantic content
whatsoever — it exists so the pipeline can be run end to end on a laptop, and
`refineEnv` refuses to boot with it in production, because a deployment using it would
cluster by hash collision and score topics from noise while appearing perfectly healthy.

Anthropic does not offer an embeddings endpoint, so this is a second vendor either way.

| Option                                                      | Notes                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Voyage (`voyage-3-lite`)**                             | 512 or 1024 dimensions natively, cheap, good retrieval quality, one API key. `EMBEDDING_DIMENSIONS` and the `vector(768)` column would change to match. |
| B. A self-hosted open model behind an OpenAI-compatible API | No third-party data flow, which matters for the EU posture; costs a GPU or slow CPU inference, and one more service to operate.                         |
| C. OpenAI `text-embedding-3-small` at 768 dimensions        | Matches the column exactly, widely used; a US processor in the pipeline, which `docs/PRIVACY.md` would have to name.                                    |

**Recommendation: A**, and change the column to the provider's native width rather than
truncating to 768 — a truncated embedding is a worse embedding for no benefit. B is the
better long-term answer if the volume justifies the GPU, and the adapter is already
written against an OpenAI-compatible shape so switching is a configuration change.

**What I need:** the provider, and confirmation that a second processor in the pipeline
is acceptable (it belongs in `docs/PRIVACY.md` either way — the crawler only ever sends
it text that was already public).

---

### D7 — Which sources, concretely

Section 3 gives a preference order, not a list. Every source needs a robots review, a ToS
review and, for the API sources, a credential. X API v2 in particular now costs real
money for anything beyond trivial volume.

**Recommendation for launch:** Hacker News API, Reddit API, GitHub Trending, Wikipedia
pageviews, YouTube Data API, plus RSS/Atom from a curated list of 40–60 publications.
All are free or cheap, all have documented terms, none needs paid access. Defer X API
until there is evidence the audience is there — at current pricing it is the most
expensive source per unit of signal by a wide margin.

**What I need:** approval of the list, and whether to budget for X API.

---

### D8 — How much autonomy over published content

`SOCIAL_AUTONOMY` defaults to `review`, and `content.status` cannot reach `published`
for generated content without a `reviewed_at` timestamp — enforced by a database CHECK
constraint, not by application code.

**Recommendation:** stay at `review` for at least the first month, then consider `auto`
for one narrow, templated content type only (the trend digest), keeping long-form
permanently in review. The asymmetry is the reason: a good piece published an hour
earlier is worth very little; a bad piece published without review can end the project.

---

## Already taken, revisit deliberately

### D9 — Exponential forgetting on the posteriors — **Taken**

The convergence harness showed that the exploration floor alone does not let the engine
recover when the best variant changes: terminal best share fell to 2% and stayed there,
because a posterior built from 20,000 observations cannot be moved by 2% of traffic.
Exponential forgetting (`decayPosterior`, `decayArm`) brings recovery to 93% and cuts
terminal regret by an order of magnitude.

The cost is real: forgetting bounds the effective sample size, so the engine is
permanently slightly less certain than it could be, and needs a larger true effect to
act. Default `gamma = 0.98` at the hourly cadence is about two days of memory. Both
behaviours are asserted in `packages/adaptive/test/sim.test.ts` so the mechanism cannot
be removed without the test explaining why it exists.

### D10 — `cta.copy` and `cta.style` are two surfaces, not one — **Taken**

The brief writes this as `copy × (pill / block / underline / floating)`. As one surface
that is 32 variants needing 32,000 impressions for a single round of evidence. As two
surfaces the marginals are learned independently and the interaction is still reachable
through the contextual layer. Revisit if the report shows a champion pair that neither
marginal predicts.

### D11 — Reward components are stored, the reward is not — **Taken**

ClickHouse stores signups, engaged sessions, scroll sum, returns, shares and bounces;
`packages/adaptive/src/reward.ts` applies the live weights. A weight change therefore
takes effect on the next decision with no backfill, and history stays comparable
forever. `rewardVersion` is stamped on every adaptation-log entry so two epochs are
never silently compared.

### D12 — Surface ids are validated but not branded in the type — **Taken**

A branded key cannot index a mapped record type, and `SURFACES['theme.palette']`
resolving to its exact surface type is worth more than a brand on a value nothing else
consumes. The runtime shape check still runs in `defineSurface`.

### D13 — ClickHouse consumes Redpanda directly — **Taken**

The Kafka engine table plus a materialised view replaces a hand-written consumer that
would have to reimplement offset management, batching and back-pressure. All enrichment
that needs request context (IP hashing, geo, bot scoring, consent) already happens in the
edge collector, so nothing downstream of the buffer needs application logic. Revisit if
enrichment ever has to happen after the buffer; the `events` table is unchanged either
way.

### D14 — Incremental nearest-centroid clustering, not HDBSCAN — **Taken**

The brief names HDBSCAN, and on a static corpus it is the better algorithm: it finds
clusters of varying density and labels the rest as noise without being told how many to
look for. Two things make it the wrong fit.

**Cluster identity does not survive a re-run.** HDBSCAN reclusters everything on every
run, and nothing ties this hour's cluster 7 to last hour's. A `trend_signal` whose id
changes every hour cannot accumulate a momentum history — and momentum over time is the
entire point of the pipeline. Incremental assignment against the clusters already in the
database keeps ids stable by construction.

**It would be the package's only native dependency**, to solve a problem the simpler
algorithm solves adequately.

The cost, stated plainly: cluster quality depends on arrival order, and an early
outlier can anchor a cluster somewhere unhelpful. Three mitigations — a running-mean
centroid update rather than a midpoint (so one arrival cannot move a 40-member cluster
halfway), periodic re-centroiding over the members still inside the retention window, and
a `cohesion()` measure that reports a cluster which has drifted into covering two topics.
Splitting is reported to the operator rather than done automatically, because a split
discards the momentum history that justified the whole design.

Revisit if the report shows clusters whose cohesion is routinely below the join threshold.

### D15 — The safety classifier is rules, not a model — **Taken**

A model would classify better on average. Three properties beat average accuracy here.

**Auditability.** The operator has to be able to ask "why was this blocked" and get a rule
with a name, not a probability. `assessSafety` returns every category that fired and the
exact terms that fired it, so a bad rule is visible and fixable.

**Determinism.** The same topic must get the same verdict on every run, or the review
queue fills with topics that were allowed yesterday and blocked today.

**The asymmetry.** A false block costs one article; a false allow costs the site's
credibility and possibly somebody real. The rules are deliberately blunt and
over-trigger, and `review` — which queues rather than discards — is the default for
anything ambiguous.

A model belongs _after_ this gate, narrowing what survives it. Never replacing it.

**The gap this leaves, named:** `docs/COMPLIANCE.md` §5 also lists "anything naming a
private individual". Term matching cannot detect that — it needs named-entity recognition
plus a judgement about whether the person is public — so it is **not** enforced in code.
It is carried by `SOCIAL_AUTONOMY` staying at `review`, where a human sees the draft. A
claim in a compliance document that no code implements is worse than an acknowledged
limitation.

---

### D17 — Two vocabularies for one safety verdict, mapped rather than merged — **Taken**

The Postgres `safety_verdict` enum spells the three states `safe` / `needs_review` /
`rejected`; the classifier returns `allow` / `review` / `block`. Discovered while writing
the worker's repositories, which would not compile against either name.

Merging them means a migration: the enum is used by two tables and the
`outbound_auto_requires_safe_template` CHECK constraint names `'safe'` in SQL. Leaving each
consumer to translate means a `'safe'` compared against an `'allow'` that never matches and
never errors.

So: both names are declared in `packages/core/src/safety.ts` with the mapping between
them, `@morph/crawler` imports the classifier type from there rather than declaring its
own, and every crossing goes through `toStoredVerdict` / `fromStoredVerdict`. The test
asserts the mapping's range against `safetyVerdictEnum.enumValues`, so adding a fourth
state to the database without extending the mapping fails the suite rather than an INSERT.

Revisit when a migration is being written for another reason; folding this in then costs
nothing.

### D18 — One crawl worker, and the lease that assumes it — **Taken**

`PolitenessScheduler` holds its per-host leases in process memory. That is correct for one
process at any concurrency, and wrong for two: each replica believes it holds the only
lease for a host, and "one concurrent request per host" — the first line of
`docs/COMPLIANCE.md` §2 — silently stops being true.

The crawl queue's concurrency is therefore pinned to 1, asserted by a test, and the
constraint is written at the top of `jobs/crawl.ts` and in the composition root. Scaling
the crawler horizontally needs the lease moved to Redis first.

This is a real ceiling on crawl throughput, and it is the right one to accept for now: at
8 requests per second globally, one process is nowhere near saturated, and a compliance
guarantee that depends on nobody scaling a deployment is not a guarantee.

### D19 — The audience vector is a deliberate feedback loop, with its gain turned down — **Taken**

`audienceFit` scores a candidate topic by its resemblance to the pages readers already
engaged with. That is a feedback loop by construction: write about what worked, measure
what worked, write about that. Left alone it narrows the site until it is producing
variations on its own best month.

It is still the right term to have. It is the only part of the trend score that is about
_this site_ rather than about the web — momentum, saturation and durability would rank
identically for anybody — so removing it means writing for a generic reader.

Four things bound it, and they are the design:

- **It is 30% of the composite, not all of it.** A rising, uncrowded topic can win on the
  other three terms alone.
- **The centroid is the whole above-median half**, not the best few. A single runaway page
  moves it a little; it cannot capture it.
- **A 30-day window.** A topic that stops working stops counting within a month.
- **When it cannot be computed it is dropped, not defaulted.** Below the floors the term
  is removed and the remaining weights renormalise, so a cold start does not lock the site
  onto its first three pages.

Revisit if the report shows the published set converging — the measurable symptom would be
the cohesion of the contributing pages' vectors rising run over run.

### D20 — Engagement is keyed on `page_path`, not `content_id` — **Taken**

`events.content_id` exists in the contract and the collector forwards it, but the site does
not emit it: `apps/web` renders content from a hand-written list with no ids. An aggregate
keyed on it would be correct and empty.

`page_path` is what the beacon actually sends, and `/t/{slug}` maps to `content.slug`,
which is unique. The mapping is exact, and the aggregate filters to `/t/` so the home page
and the privacy policy — engaged with for reasons that say nothing about topic interest —
never enter the computation.

When pages start carrying their content id, this key stays correct and nothing needs to
change. The cost is one unresolvable case, and it is reported rather than silent: a path
with engagement and no matching content row is counted and logged, and a rising count
there means the path filter is wrong.

---

## Deferred, but worth naming now

- **APCA vs WCAG 2.2 for the contrast gate.** `apcaLc` is implemented and recorded as an
  advisory score; the gate is the WCAG 2.2 ratio because that is the normative
  obligation. One-line switch when WCAG 3 lands.
- **Personalised adaptation.** Everything shipped so far runs on aggregate anonymous
  data under legitimate interest. Per-visitor adaptation needs explicit
  `personalisation` consent and a genuine DPIA. Recommend deferring past launch.
- **Embedding model for the trend pipeline.** `crawl_document.embedding` is 768
  dimensions, which fits most open sentence-transformer models. Committing to a specific
  one is a Phase 5 decision; changing it later means a re-embed of the 30-day corpus,
  which is a few hours of compute, not a migration.
- **Multi-region.** `infra/SCALING.md` covers it. Not before the single node is
  measurably saturated.
