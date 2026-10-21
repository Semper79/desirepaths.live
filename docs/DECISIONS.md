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

### D2 — Domain and brand name — **Taken: Desire Path**

Needed for OAuth callback registration, the crawler's User-Agent contact URL, ACME
certificate issuance and every platform's app review. Several of those have multi-day
turnarounds, so this blocks more than it looks like it does.

**Recommendation:** register the domain before Phase 4 begins. Provider app review
(TikTok and Meta in particular) takes days to weeks and cannot start without a live
privacy policy at a stable URL.

**What I need, still:** the domain itself. There is no defensible default here — a name
is a brand decision, and inventing one would put a placeholder into OAuth callbacks, the
crawler’s contact URL and every certificate.

---

**Decided:** `desirepath.live`, with `desirepaths.live` held defensively. Both registered.

A _desire path_ is the trail worn into grass where people actually walk, ignoring the paved
route. Urban planners study them; some architects wait for them to appear before laying any
path at all. That is the methodology, not a metaphor for it — the site reshapes itself along
the routes visitors actually take rather than the ones the designer intended, which is what
a contextual bandit over eleven surfaces does.

**Why the concept and not a coined word.** The term is already known and liked by exactly
the people this has to reach: designers, product managers and developers all recognise it,
and it carries affection none of them has for an invented syllable. The name arrives with
equity instead of needing to build it.

**Why `.live` and not `.com`.** Roughly eighty candidate strings were checked against RDAP
across five rounds — real words, pure coinages, compounds. **Not one evocative name had a
free `.com`.** The choice was never .com-versus-.live; it was an engaging name on .live or a
descriptive phrase on .com (`showsitswork.com` was the best of those, and was free). The
engaging name won because the site's job is to be worth telling someone about.

**What was checked before buying.** RDAP against the authoritative registries for
availability, and a web search for existing commercial use. That second step is the one that
mattered: it eliminated **Fluxel** (in use by a building-intelligence platform, a fintech,
and a French company), **Mercurial** (an established version control system used by Meta,
Mozilla and W3C), **Plainsight** (a computer-vision AI company), **Anneal** (an engineering
platform in Belfast), and **Trimtab** (the Buckminster Fuller Institute's newsletter). Every
one of those would have been found later and more expensively.

**Still outstanding:** a trade mark search. Registers were not checked — TMview across EUIPO
plus the national registers, and UIBM for the home market, in classes 9, 35 and 42. The risk
on a name made of two common English words is low, because such marks are weakly
registrable in the first place, but low is not verified.

**The two names.** The product is Desire Path. The repository, the `@morph/*` package
namespace, the `MORPH_*` environment variables and the database stay MORPH — the codename
this was built under. Renaming those is a migration with a downtime window that buys nothing
a visitor can see. The rule is written at the top of `apps/web/src/lib/site.ts`: a comment
describing the system may say MORPH; a string a person reads says Desire Path.

### D3 — Hosting and jurisdiction — ~~**Taken: A**~~ **Superseded by D31**

> The operator needs this on Cloudflare, so there is no Hetzner box and the reasoning below
> is kept only because the jurisdiction half of it still applies and is now harder. A single
> server in Falkenstein made "where does the data live" a one-word answer. Cloudflare's edge
> does not: a visitor's request is processed at whichever PoP is nearest, which can be
> outside the EU. What the ingest Worker actually does with it is the mitigation and it is a
> real one — the IP is hashed inside the request and never stored — but `docs/PRIVACY.md`
> has to say so in those terms rather than by naming a datacentre. D1 and Durable Objects
> support EU jurisdiction constraints; that is a configuration decision this port has not
> made yet, and it belongs with D4.

| Option                                         | Notes                                                                                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **A. Hetzner CCX23, Falkenstein (DE)**         | The brief's own suggestion. 8 vCPU / 32 GB, ~€49/mo, EU jurisdiction, no US transfer question.                             |
| B. Hetzner CCX33 (16 vCPU / 64 GB)             | ~€100/mo. Buys roughly 3× the headroom on ClickHouse merges, which `infra/SCALING.md` identifies as the second bottleneck. |
| C. Managed (Neon + ClickHouse Cloud + Upstash) | 4–8× the cost at this scale, far less operational work, and the compliance story becomes a list of sub-processors.         |

**Recommendation: A.** The load-test target is 5,000 req/s on ingest; a single CCX23
handles that with the async-insert configuration already in the compose file. Moving to
B is a one-line change with no migration. Choosing C at launch means paying for elastic
scale before the traffic that would justify it exists.

**Decided:** A — Hetzner CCX23, Falkenstein. Who holds the account is part of D4, and the
answer there is what `docs/PRIVACY.md` names as controller.

---

### D4 — Legal identity of the data controller — **Enforced; three facts still needed**

> **What changed.** The decision is still the operator's, but it no longer blocks building
> and it can no longer be forgotten. `packages/core/src/controller.ts` reads the identity
> from three variables and returns `null` for anything partial, and both services act on
> that: the collector refuses every beacon with 503, `/ready` refuses the deployment and
> names the missing variables, and `/privacy` tells the visitor that nothing is being
> recorded — which is true, because of the first two.
>
> This is the treatment `apps/worker/src/env.ts` already gives the deterministic embedding
> provider: a component that is meaningless in production is made impossible rather than
> discouraged. The earlier state was worse than either, because a privacy page with a gap
> in it looks finished.
>
> **Nothing is invented.** There is no default, no example and no fallback anywhere in the
> path. A plausible-looking controller in a privacy notice is a false legal record, and a
> false legal record is worse than a missing one — so the absence is rendered as an
> absence, in words, on the public page.
>
> **What this unblocks.** The renderer can be deployed now. Art. 13 engages on processing,
> not on serving pages, so a staging deployment with the collector absent measures nobody
> and needs none of this. `infra/cloudflare/README.md` has that as a two-step launch.
>
> **One thing that has a deadline.** D1 takes `--jurisdiction eu` only at creation; there
> is no command that moves an existing database. The database has not been created yet, so
> this is free today and a migration the day after launch. It belongs with this decision
> rather than after it — see `docs/PRIVACY.md` §0.

Not deferrable: `docs/PRIVACY.md` must name a controller and a contact address, and it
must be published before the first visitor is measured. A sole trader, an SRL and a
foreign entity have materially different obligations.

**Recommendation:** name the operating entity, or the individual if there is no company
yet. If EU-based with no establishment elsewhere, no Article 27 representative is
needed. If processing scales past "regular and systematic monitoring on a large scale" —
which 5M events/day plausibly is — a DPO becomes a live question; see `docs/PRIVACY.md`.

**What I need, still:** legal entity name, registered address, and a contact email for
data-subject requests. `docs/PRIVACY.md` cannot be published without them, and it must be
published before the first visitor is measured.

---

## Blocking Phase 4 (sign-up)

### D5 — Which OAuth providers ship at launch — **Taken: the recommended five**

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

**Decided:** the recommended set. Google, Apple, Discord and TikTok, plus passkeys, plus
email magic link as the no-social path. X, Reddit, Twitch, Spotify and Instagram stay
declared and unset.

**What that requires before the first sign-up:** four developer accounts, four sets of
callback URLs — which need the domain in D2 — and Apple's is the slow one: a paid
Developer Program membership, a Services ID, and a key rather than a secret, with the
client secret being a JWT that expires and has to be regenerated. Budget for that being
the long pole, not the code.

Passkeys need no vendor at all, which is part of why they are in the list; they also
cannot be the _only_ option, because a visitor on a borrowed machine has no authenticator
to offer. That is what the magic link is for.

The provider _ordering_ is an adaptive surface and is already declared in the registry, so
the bandit will be choosing which of the five to show first, per context, from the day
there is traffic. Five is enough for that to converge in a useful timeframe; ten would
have spread the evidence too thin to learn anything before the arms were stale.

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

### D16 — Which embedding provider — **Taken: A**

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

**Decided:** A — Voyage. `EMBEDDING_PROVIDER=voyage` is now the documented production
setting, and `docs/PRIVACY.md` gains Voyage as a processor. The crawler only ever sends
it text that was already public, so no visitor data leaves for it.

**One thing deliberately not yet written:** the column width. The schema is `vector(768)`
in three places and the chosen model does not emit 768. Rather than bake a number into a
migration from memory, `EMBEDDING_DIMENSIONS` stays the single source of truth and the
migration is written once the exact model and its native width are confirmed against
Voyage’s current documentation. A truncated embedding is a worse embedding for no
benefit, so the column moves to the model rather than the model to the column.

---

### D7 — Which sources, concretely — **Taken**

Section 3 gives a preference order, not a list. Every source needs a robots review, a ToS
review and, for the API sources, a credential. X API v2 in particular now costs real
money for anything beyond trivial volume.

**Recommendation for launch:** Hacker News API, Reddit API, GitHub Trending, Wikipedia
pageviews, YouTube Data API, plus RSS/Atom from a curated list of 40–60 publications.
All are free or cheap, all have documented terms, none needs paid access. Defer X API
until there is evidence the audience is there — at current pricing it is the most
expensive source per unit of signal by a wide margin.

**Decided:** the recommended list, X API deferred. Hacker News, Reddit, GitHub Trending,
Wikipedia pageviews, YouTube Data API, plus 40–60 curated RSS/Atom feeds.

**What that still requires before a single fetch:** each source needs a row in
`crawl_source` with `tos_reviewed_at` set, and that review is a human reading terms — the
column exists precisely so the compliance position is checkable by a query rather than
asserted. The API sources also need credentials.

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

### D21 — The bot long-polls rather than taking a webhook — **Taken**

A webhook needs a public HTTPS URL with a valid certificate, which needs the domain in D2.
Long polling needs nothing: it works from a laptop, from behind a NAT, and from a machine
that has no inbound route at all.

At one operator's message volume the difference in latency is about a second, and the cost
is one held HTTP connection. When there is a domain, moving to a webhook changes
`adapters/telegram-api.ts` and nothing above it — the dispatcher already takes an update
as `unknown` and does not know where it came from.

The offset is the acknowledgement, which shapes the loop: asking for updates after N is
what tells Telegram the ones before N were handled. So updates are processed one at a time
and the offset advances afterwards — a crash re-delivers rather than drops. Enqueuing them
for later would mean an update Telegram believes was delivered and nothing has.

### D22 — Approving is held to the `/promote` bar, not the chat bar — **Taken**

Commands are authorised in two tiers: the right chat is enough to read, and a named user
is required to change anything. An inline keyboard sits somewhere in between — it is
visible to everyone in the chat, and tapping it is a mutating action.

So a callback is authorised as though it were `/promote`: the right chat _and_ a named
operator. Anyone else in the chat can see the queue and gets a toast saying the decision
is not theirs to make.

Two properties follow, and both are asserted:

**Approving is idempotent.** The update is `WHERE status IN ('draft', 'pending_review')`,
so a second tap — the normal case, because the button stays on screen — matches no row and
reports "already decided" rather than acting twice. Checking and then updating would be the
same logic with a race in it.

**Approving names a reviewer.** The Telegram user id goes into `content.reviewed_by`, and
`content_generated_needs_review` refuses the row without it. Publishing anonymously is a
constraint violation, not a shortcut.

### D23 — The report compares against the same hour last week, and against nothing else — **Taken**

A site with daily and weekly seasonality has a 03:00 that is always quiet and a Sunday
that is not a Tuesday. "Down 60% on last hour" at 09:00 on a Monday is a statement about
breakfast, and an operator who reads a few of those stops reading the rest.

So every comparison in the report — traffic, each source, each country, each page, each
funnel step, the anomaly alert — is against the same hour seven days earlier. The queries
are written as "one hour, by timestamp" rather than "this hour versus last", which is what
lets the same query serve both sides of the comparison.

Three consequences worth stating:

**A zero baseline produces no comparison at all.** A page that did not exist last week has
no honest percentage change, and every plausible convention — 0, 1, ∞ — reads as a
measurement in a sentence a human will repeat. `deltaOrNull` returns null.

**The funnel is compared in points, not percent.** "Conversion fell 3 points" is a sentence
about the funnel; "conversion fell 12%" is a sentence about a percentage, and the two get
confused every single time.

**The anomaly test needs three weeks before it has an opinion**, and declines entirely when
the baseline has no variance — otherwise a site so quiet that every week's 04:00 had
exactly zero sessions would report its first ever visitor as an infinite anomaly.

### D24 — Two sections say "not yet recorded" rather than guessing — **Taken**

The report has nine sections and two of them cannot be filled honestly yet.

**The live theme.** The assignment is chosen per visitor at the edge, so "the live theme"
is only meaningful as the current champion of each design surface — which needs the
adaptation aggregation job. Naming a variant that was true for one visitor would be worse
than naming nothing.

**The holdout's p-value.** The always-valid test lives in `@morph/adaptive` and runs on the
engine's own state, not on a report's snapshot. Until it is fed, the report says "not
conclusive", which is both true and the safe direction — a fixed-horizon p-value quoted in
something read every hour is precisely the mistake §2 exists to avoid.

Both are visible as gaps in the report itself rather than as absent sections, because a
section that disappears reads as a failure and a section that says what it does not know
reads as a system that is being honest with you.

### D25 — The model writes a lead, not the report — **Taken**

§5 asks for a report that reads "like a sharp analyst's briefing, not a metrics dump",
composed by an LLM. The obvious reading is that the model writes the report. It does not:
it writes two to four sentences at the top, and the nine deterministic sections follow
underneath, byte for byte as composed.

That is where the value actually is. Nobody needs a model to reformat a table, and a model
that reformats a table is a model that can drop a row from it. Every failure mode of this
design — no key, a rate limit, an outage, a lead that fails verification — produces exactly
the report that would have been sent anyway.

**The invariant is checked, not requested.** `types.ts` has said since Phase 6 that a
number in the report always came from `ReportInput`. A prompt cannot enforce that.
`verifyLead` parses every numeric token in the lead at the precision it was written and
requires some fact to round to it: "1.8k" passes if a fact lands in [1750, 1850), "1.9k"
does not, and a figure nobody measured fails outright. So does arithmetic the model did
itself — sessions plus sign-ups is not a fact, and the check rejects it without needing a
rule about addition.

A rejected lead is dropped silently rather than sent with a caveat, because a caveat is
something a reader learns to skip. The violation is logged, since the failure worth acting
on is a pattern of them rather than one.

**The prompt and the check say the same thing** deliberately. The prompt makes the check
rarely fire; the check is what makes the prompt's failure harmless.

**Sonnet, not the generation model.** Four sentences over text already in front of it,
every hour, with a deterministic fallback. Paying Opus rates for that is paying for
capability the task does not use.

**No lead on a quiet hour.** The brief form is one line whose entire point is that nothing
happened; a model-written paragraph on top of it would be the opposite of what it is for.

Provenance goes in `report_run.composed_by_model` rather than into the message. The report
has one reader, who turned the pass on and knows — but "was this hour's opening written by
a model, and which one" has to stay answerable months later.

### D26 — Escalation reports transitions; the report reports state — **Taken**

Two channels that say different things, rather than the same thing at two cadences.

The escalation job fires when a condition _becomes_ critical and again when it clears. It
never reminds. An operator who has been told ClickHouse is down does not need to be told
every five minutes, and the hourly report already carries the ongoing condition — a
reminder would be a third copy of a fact they have twice.

**Only critical escalates.** A push notification for "three drafts are waiting" is how an
operator learns that push notifications are not worth opening, and then misses the one that
was. Warnings and information wait for the report.

**Recovery is news.** An alert that fires and never resolves teaches the reader that alerts
do not resolve, and the next outage looks identical to the last one still open.

**A failed send is not remembered as sent.** The state is committed only for transitions
whose message actually went out, so an outage nobody was told about is retried five minutes
later rather than silently marked as handled.

**The state is in the process, deliberately.** A restart re-escalates whatever is still
broken — which is right, because a worker that has just come back during an outage is
exactly when the operator's picture is most likely to be stale. The cost is one duplicate
message in a case that already warranted attention.

**What it structurally cannot report: Redis.** The queues run on Redis, so a Redis outage
stops this job along with everything else. It is the one failure the system cannot report
on its own behalf, and catching it needs the external check in
`infra/prometheus/rules/morph.yml`. Saying so in the file is better than implying the
coverage is complete.

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

---

### D27 — The engine reports on itself, in public — **Taken**

Every competitor in adaptive optimisation hides the machine. Optimizely, VWO, AB Tasty,
Kameleoon and Dynamic Yield all run the experiment and tell the visitor nothing — partly
because most of those systems could not survive being looked at.

MORPH shows its working. The home page carries a live reading of how much the engine
actually knows, derived from the same posteriors that chose the page around it, with the
four-way breakdown underneath and a plain-language sentence saying what is holding the
number down.

**What makes it worth anything.** Three rules, each enforced rather than intended:

1. **It is not a surface.** No entry in the registry, rendered outside `sectionOrder`, and
   `thinking-bar.test.ts` asserts both. An optimiser given control of the display of its
   own scorecard would find the framing that keeps people reading and report that instead
   of the truth — and the failure would be invisible, because the bar would look excellent
   throughout.
2. **It can go down.** After a retirement, a rollback, or a snapshot going stale. A bar
   that only climbs is a progress animation, and a visitor who works that out has correctly
   concluded the whole site is theatre. Asserted directly.
3. **Unmeasurable is not zero.** A component that cannot be computed renders as a dash, not
   as 0%. The difference between "this is bad" and "this is unknown" is where dashboards
   start lying.

**What it costs.** At launch it reads 0% — "cold start", "no visits measured yet". That is
the honest number for a site with no traffic, and shipping it anyway is the whole point: a
bar that started at 40% for atmosphere would be worth nothing the day it mattered.

**Two things this surfaced.** The first draft weighted freshness as a fourth component,
which meant a site with no surfaces and no traffic read 15% because its empty snapshot was
recent — a bar paying out for a working cron job. Freshness is now a multiplier that can
only take away. The second: `probabilityGreater` stops converging past roughly a million
pseudo-counts, and exponential forgetting caps those at
`observations_per_cycle / (1 - gamma)` — which at the 5M events/day design target puts a
busy surface inside the failure band. The bar drops such a surface rather than throwing, so
the page renders; the underlying gap is recorded in D28.

---

### D28 — `probabilityGreater` had a ceiling, and the adapt job sat under it — **Taken: fixed**

The regularised incomplete beta in `packages/adaptive/src/beta.ts` throws above roughly
1,000,000 pseudo-counts. It is right to throw — `front` becomes a difference of two enormous
logs and loses its significant digits, and a plausible wrong number there would silently
steer the optimiser. But the ceiling is reachable in production, not in theory: forgetting
caps the pseudo-count at `observations_per_cycle / (1 - gamma)`, fifty hourly cycles at the
default 0.98, and a busy surface at the design target lands in that band.

`sophistication()` already degrades gracefully. `summarise()` in `thompson.ts` does not, and
it is on the hourly report and admin console paths — so at full scale the report job would
throw rather than render.

**The fix:** a normal approximation for the large-parameter regime. When both parameters are
large the Beta converges to a Normal and `P(X > Y)` has a closed form through the normal
difference, which is accurate exactly where the continued fraction fails. It is a change to
the numerical core of a package with a 100% branch-coverage gate, so it wants its own tests
and its own commit rather than riding along with a feature.

**Done.** `probabilityGreater` now routes by concentration, and the thresholds were
measured rather than chosen:

| Regime                                     | Method                                                                            | Measured agreement with the exact quadrature          |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Both posteriors past 200,000 pseudo-counts | Normal difference, `Φ((μ₁-μ₂)/√(σ₁²+σ₂²))`                                        | 3.8e-7 by mass 10,000; 8.6e-5 in the worst skew found |
| One past it                                | The wide one keeps its exact CDF; the narrow one becomes a point mass at its mean | 2.7e-6                                                |
| Neither                                    | The existing quadrature, untouched                                                | exact                                                 |

The middle row is the one worth dwelling on. The obvious move is to apply the normal
difference whenever anything is large, and on the fresh-variant-against-mature-leader
comparison — which the bandit makes constantly — that is **3.7e-2 out**, because Beta(3, 7)
is broad and skewed and nothing like a normal. The point-mass treatment is four orders of
magnitude better on the same case. Both numbers came from running it, not from reasoning
about it.

The switchover sits at 200,000 against a measured failure between 450,000 and 500,000, so
the two methods overlap by more than a factor of two and the agreement above is checkable
rather than asserted.

**What it changed elsewhere.** `sophistication()` had a `catch` that dropped a surface too
concentrated to evaluate. That is now dead code, and in a package gated at 100% branch
coverage dead defensive code fails the build rather than sitting quietly — so the gate
removed it for us. The reading on the home page now measures those surfaces instead of
conservatively excluding them.

**What it did not change.** The convergence harness produces byte-identical numbers: 97.5%
terminal best share, 138.2 cumulative regret, +148.6% lift, and 93.4% after the world
rotates. The simulation never enters the concentrated regime, which is the point — the
behaviour is unchanged everywhere it already worked, and defined where it previously threw.

---

### D29 — The Beta posteriors aggregate across context; only LinUCB sees it — **Taken**

`surface_rewards_hourly` buckets reward components by `context_bucket`, and the adapt job
sums across those buckets before updating anything.

The alternative — one Beta posterior per (surface, variant, context) — is the obvious
design and it starves. Eleven surfaces, three or four variants each, and a context bucket
that is the cross product of device class, referrer class and day-of-week gives cells that
individually see a few dozen impressions a day. Thompson sampling on a cell that thin is
sampling from the prior, and the site would explore for ever while appearing to be
learning.

So the split is: the Beta layer answers "which variant is better overall", on evidence
thick enough to answer it, and the contextual question goes to LinUCB, which takes the full
un-discretised covariate vector and shares strength across contexts through the design
matrix rather than partitioning the data. That division was already stated in
`002_aggregates.sql`; this records it as a decision so the next person to notice the
buckets going unused finds the reason rather than a bug.

**What it costs:** a variant that is excellent on mobile and poor on desktop shows up in
the Beta layer as mediocre, and could be retired before LinUCB has learned to serve it to
the right people. `minImpressionsBeforeRetire` is the mitigation and it is a partial one.
The honest fix is per-context retirement, which needs the per-context posteriors that
cannot be afforded until there is far more traffic — so this is a decision to revisit at
scale, not a settled one.

---

### D30 — `client_errors_hourly`, because the guardrail was checking a number nobody produced — **Taken**

`evaluateHealth` has always checked a client error rate alongside Core Web Vitals, and
until now no aggregate produced one. Wiring the adapt job made that visible: the adapter
would have had to pass a zero, which reads as "no errors" rather than as "not measured",
and a variant throwing an exception in every session would have passed the guardrail
silently.

`client_error` was already a valid event type, so the events were being collected and
simply never rolled up. The new view is ten lines in the same style as `vitals_hourly`,
with sessions as the denominator rather than events — one broken render emits a dozen
exceptions, and a rate above one is not a rate.

The general point is worth keeping: a threshold checked against an absent measurement is
worse than no threshold, because it looks like protection.

---

### D31 — The whole stack moves to Cloudflare — **Taken**

The operator needs this on Cloudflare, from an account that does not exist yet. That was
not the target the architecture was built against: `infra/docker-compose.yml` assumes a
machine with Postgres, ClickHouse, Redis, Redpanda, Caddy, Prometheus and Grafana on it.

**What survives, and why it survives.** `packages/adaptive` has zero runtime dependencies
and performs no I/O — a rule in `CLAUDE.md` from the first commit, justified there as what
keeps decision latency under 5 ms and makes the engine exhaustively testable. It turns out
to be what makes this port a port rather than a rewrite: the bandit runs unmodified on a
Worker. The same holds for the jobs, which are written against `src/ports.ts` with thin
adapters that coverage already excludes. The adapters are replaced; the logic is not.

Concretely: `packages/adaptive`, `packages/core` schemas, `packages/seo`, `packages/ui`,
every page, every zod boundary, and the k6 scripts in `bench/` all survive. The domain
logic of the ingest route and of all four jobs survives.

**The mapping.**

| Today                                  | On Cloudflare                                                               |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Next.js in a container                 | Workers via OpenNext (D32)                                                  |
| Fastify ingest (`apps/api`)            | one Worker; the route logic is unchanged                                    |
| Postgres — content, `adaptation_log`   | D1, via `drizzle-orm/d1`                                                    |
| ClickHouse — raw events, aggregates    | Analytics Engine, plus D1 rollups (D33)                                     |
| Redis — assignment stickiness, buckets | KV for assignments and the snapshot; Durable Objects for the counters (D33) |
| Redpanda                               | Queues                                                                      |
| BullMQ schedulers                      | Cron Triggers                                                               |
| Prometheus + `prom-client`             | dies — see below                                                            |

**What dies, and what that costs.** `packages/metrics` cannot run on a Worker:
`prom-client` requires `node:cluster`, and a Worker has no process to scrape. The nine
`morph_*` metrics and the contract test that pins them to the alert rules go with it, and
the two Grafana dashboards lose their datasource. That is a real loss of work and it is
not recoverable by being clever — the pull model does not exist here. The replacement is
Analytics Engine as the metrics store and Grafana reading it over the SQL API, which is a
different shape: no `histogram_quantile` over Prometheus buckets, no recording rules.

**What it costs in money, stated plainly.** The Workers free plan allows 100,000 requests
per day. The design target in `CLAUDE.md` is 5M events per day — fifty times that — so the
free plan is a launch configuration, not the target configuration. Workers Paid is $5 per
month and includes 10M requests; at the design target the bill is tens of dollars a month,
not thousands, but it is not zero and it scales with traffic in a way a fixed VPS does not.
The honest summary: cheaper than a VPS until roughly 1M events/day, more expensive after.

**What was not considered and why.** Keeping ClickHouse on a managed host and pointing
Workers at it over HTTP would preserve the aggregates exactly. It was rejected because it
reintroduces the thing the operator is trying to avoid — a server to run and pay for — and
because a cross-network read on the adaptive path cannot meet the 5 ms budget.

**Keeping Postgres, which deserved a paragraph and did not get one.**

The first version of this decision argued why ClickHouse could not stay and said nothing
about the equivalent option for Postgres, which left the relational half looking forced
when it was chosen. It was chosen, and here is the argument that should have been here.

Postgres could have stayed. **Hyperdrive** is a first-class Workers binding whose entire
purpose is connection pooling to an external Postgres, and a serverless provider (Neon,
Supabase) means no server to run — so the objection that killed managed ClickHouse does not
apply. That path would have kept every single thing the port gave up: `pgvector`, declarative
partitioning, grant-based immutability on `adaptation_log`, real enums, and no size cap.

It was still the wrong choice for this data, and the deciding fact is how little of it there
is. Measured rather than assumed:

| Table            | Reality                                                       |
| ---------------- | ------------------------------------------------------------- |
| `content`        | dozens of rows, read through a cache on the hot path          |
| `variant`        | dozens                                                        |
| `adaptation_log` | thousands a month                                             |
| `crawl_document` | an excerpt, not the fetched body; ~1 KB a row on a 30-day TTL |

Nothing there comes within two orders of magnitude of D1's 10 GB, and nothing there needs a
join across millions of rows or a second concurrent writer. Against that, Hyperdrive costs a
second vendor, a second bill, a second failure domain, credentials to rotate, and a network
hop off Cloudflare's network on every uncached read.

The one thing Postgres was genuinely better at is vectors — and `pgvector` loses to Vectorize
on its own merits, so the embeddings leave the relational database either way. That is what
makes this clean rather than close: the strongest argument for keeping Postgres evaporates
on inspection.

**What it costs, in one item.** `adaptation_log`'s immutability was a Postgres grant:
`morph_worker` had INSERT and SELECT and not UPDATE or DELETE, and the guarantee belonged to
the platform. D1 has no role system, so it is now a property of the code — no adapter exposes
an update path, and only the retention cron deletes, by date. That is the single loss worth
minding and it is real.

**The window for changing this closes at launch, and that is not a detail.**

Reversing the choice today is nine files: the schema module, the drizzle config, the `core`
export, the generated migration, `apps/web`'s `db.ts` and `bindings.ts`, its
`wrangler.jsonc`, the migration test, and the CI step. Half a day.

Reversing it after the first visitor is a data migration with a downtime window. This is the
same reasoning `docs/PRIVACY.md` §0 applies to `--jurisdiction eu` — free before creation,
expensive after — and it applies here identically. So "we could go back" is true now and
stops being cheap the moment the site has content in it, which means it is not a reason to be
comfortable with the decision. The decision has to stand on the table above.

---

### D32 — OpenNext, not vinext, even though Cloudflare recommends vinext — **Taken**

Cloudflare's own documentation now points new Next.js projects at `vinext`, a Vite plugin
that reimplements the Next.js API surface, and describes the OpenNext adapter as the path
for maintaining an existing application. Taking the recommendation would be the default
choice and it is the wrong one here.

`vinext` reimplements the API surface rather than adapting the output of `next build`. That
buys faster builds and smaller bundles and costs coverage of the long tail — and the
reported gaps include App Router CSS ordering and cascade regressions.

For most sites that is a cosmetic risk. For this one it is the product. MORPH's adaptive
surfaces are CSS custom properties resolved per request: layout, type scale and colour are
what the engine changes, and the changes are what `/proof` publishes evidence about. A
cascade regression here does not misalign a component — it silently decouples the design a
visitor sees from the design the posteriors think was served, which poisons the evidence
rather than breaking the page. The failure would look like a bad experiment result.

So: OpenNext, which adapts real `next build` output and has been tested far longer. Revisit
when `vinext` is no longer described as experimental, and only behind a visual diff of the
resolved custom properties across every surface.

---

### D33 — Exact counters in Durable Objects; Analytics Engine for everything sampled — **Taken**

This is the one that would have been a silent catastrophe.

Analytics Engine downsamples on write and on read when an index receives large volumes,
and exposes the rate as `_sample_interval` so queries can weight by it. Weighted
aggregates recover the right _mean_. They do not recover the right _confidence_.

The bandit's Beta posteriors are pseudo-counts. Feed them a count reconstructed as
`sum(_sample_interval)` and the mean is right while the implied certainty is inflated by
the sampling factor: a variant seen 100 times at 1-in-100 sampling enters the posterior as
10,000 observations. The mSPRT then crosses its boundary on noise, `probabilityGreater`
reports 97%, and the adapt job retires a perfectly good variant with a confident-looking
reason attached. Nothing logs an error. `/proof` publishes it as a settled finding.

This is the same class of failure `apps/worker/src/env.ts` already refuses for the
deterministic embedding provider — a component that is meaningless in production while
nothing appears broken — so it gets the same treatment: made impossible, not discouraged.

**The split.**

- **Durable Objects hold the counters the engine reasons from.** One object per surface,
  SQLite-backed, holding exact impressions and rewards per variant. Surfaces number in the
  tens, writes are batched behind an alarm rather than one per event, and the adapt job
  reads exact integers. No sampling touches the evidence.
- **Analytics Engine holds the event stream** — Core Web Vitals, referrer classes, country,
  device, client errors. Sampling is statistically fine for all of it, and
  `quantileExactWeighted(q, column, _sample_interval)` gives the p75 and p95 that
  `vitals_hourly` currently computes from quantile states.
- **D1 holds content, `adaptation_log`, and hourly rollups.** Analytics Engine keeps data
  for three months and then deletes it rather than rolling it up, so a cron materialises
  the hourly aggregates into D1 inside that window. This is the replacement for the
  materialized views in `infra/clickhouse/init/`, and it is a job that must not silently
  stop: a gap in it is unrecoverable, because the source is gone.

**What it costs.** Durable Object writes are billed and rate-limited — 100,000 SQLite row
writes per day on the free plan — which is what forces the batching. A surface receiving a
burst has its counter flushed on an alarm, so the posteriors can lag the traffic by the
flush interval. That is acceptable: the adapt job runs hourly and `assignment` reads the
published snapshot, neither of which needs a counter current to the second.

**Sticky assignments go to KV, not to Durable Objects, and the difference is the point.**
The first draft of D31 sent them to a Durable Object on the reasoning that KV's eventual
consistency would corrupt attribution. That reasoning was wrong, and the correction is
worth keeping because it is the same distinction this decision is built on.

A stale KV read returns no assignment. The resolver then rolls a fresh one, the page
renders _that_ variant, and the impression is recorded against the variant actually
served. Nothing is mis-attributed. What it costs is measurement noise — one visitor
contributing to two variants — and a page that changes under a returning reader. Both were
already accepted: `assignment-store.ts` has always treated a failed read as "no sticky
assignment", because the alternative is a 500 when a cache blinks.

So the rule is not "Durable Objects are more correct". It is that **staleness is
acceptable wherever the stale answer is indistinguishable from an honest absence, and
unacceptable wherever it enters a number the engine reasons from.** A missing assignment is
an honest absence. A count that is 1% of the truth is not — it is a lie with a plausible
shape. Assignments and the published snapshot go to KV, which is read-optimised, TTL-native
and an order of magnitude cheaper. One Durable Object per visitor would also have meant one
object per rotating daily anonymous id, which is the wrong tool at any price.

**The line that is not negotiable.** If a counter the engine reasons from ever has to come
from a sampled source, it stops being evidence. Sampled numbers may inform, rank and
display; they may not enter a posterior.

---

### D34 — The collector trusts `cf-connecting-ip`, and rate-limits beacons instead of events — **Taken**

Two changes, one forced by the port and one a genuine loosening that should not be
discovered later by reading the code.

**The bug.** `apps/api` read `x-real-ip`, which the Caddyfile filled from `{remote_host}`
— the TCP peer. That was correct behind Caddy and is wrong behind Cloudflare, where the
peer is a Cloudflare PoP. Every visitor arriving through one datacentre would have hashed
to the same anonymous id, and since the rate limiter is keyed on that hash, an entire PoP
would have shared a single 60-token bucket: the collector would have answered 429 to
almost everything under any real traffic, and the analytics would have shown a handful of
impossibly busy visitors.

`cf-connecting-ip` is set by the edge itself and cannot be reached by a client. It is the
only address header here worth believing, and `apps/web/src/middleware.ts` already read it
— the collector was the half that did not. `test/ingest.test.ts` now pins both directions:
a forged `x-real-ip` must not move the identity, and the edge header must.

The country moves the same way, from an `x-country` header Caddy set to `request.cf.country`.
A header a client can send is a claim about identity, and §3's rule is that a client may
report what it observed and never what it is.

**The loosening.** The token bucket was in-process: `{ capacity: 60, refillPerSecond: 2 }`,
charged per _event_, so a batch of forty cost forty tokens. That cannot survive the port.
Isolates are many and short-lived, so in-process state limits nothing; the alternatives
were a Durable Object or Cloudflare's rate limiting binding.

A Durable Object would have preserved the semantics exactly and cost a round trip on the
5,000 req/s path, plus roughly 430M object requests a day. At $0.15 per million that is
about $65 a day to enforce a limit that exists to save money. It was not close.

So: the platform limiter, which counts **calls, not events**, at 120 beacons per minute per
anonymous id. The honest accounting of what that gives up:

|                         | Before     | After                     |
| ----------------------- | ---------- | ------------------------- |
| Sustained               | 2 events/s | 2 beacons/s               |
| Burst                   | 60 events  | 120 beacons in any minute |
| Worst case per identity | 2 events/s | 100 events/s              |

Fifty times looser, because `IngestBatchSchema` caps a beacon at fifty events and a
beacon is now one unit instead of fifty. The cap is what keeps the worst case finite at
all, which makes it load-bearing rather than a tidy validation detail — and it is worth
knowing that relaxing that `.max(50)` would quietly relax this too.

**Why that is acceptable here, and where it would not be.** The limiter is cost and abuse
protection, not measurement protection. What protects the measurements is elsewhere and
unchanged: the bot classifier scores automated traffic at 100 and the aggregates exclude
it, and D33 already forbids anything sampled from entering a posterior. A visitor who
floods inflates an Analytics Engine row count and their own session's numbers; they cannot
move a Beta.

It would not be acceptable if the limiter were the thing standing between one client and
the evidence. It is not, and the day it becomes so this decision has to be reopened.

**The fixed window, which is the other thing lost.** A token bucket has no window edge; a
fixed window hands over a whole fresh budget at the boundary, so a client can send twice
the intended rate across it. `classify.test.ts` used to have a case pinning exactly that
property. It is gone with the implementation, and the platform's behaviour at the boundary
is Cloudflare's to define rather than ours to test.

---

### D35 — How exact the exact counters actually are — **Taken: a correction to D33**

D33 contrasted Durable Object counters, called exact, with Analytics Engine's sampled
estimates. The contrast is the important part and it holds. "Exact" overstated it, and the
overstatement is the kind that matters, because the whole decision rests on a distinction
between two sorts of error.

**Why the counters are not perfectly exact.** A write per folded session would be tens of
millions of row writes a day at the design target — well past the free plan's 100,000 and
into real money on the paid one. So `SurfaceCounters` coalesces counts in memory and
flushes on a ten-second alarm. An eviction between flushes loses up to ten seconds of
counts.

Ten seconds is not an arbitrary number. The flush rate is `surfaces × 86400 / interval`
regardless of traffic — eleven surfaces at ten seconds is roughly 95,000 row writes a day,
just inside the free allowance. Shortening it costs money linearly. Lengthening it widens
the loss window for nothing, since nothing reads the counters more often than hourly.

**Why that is still categorically different from sampling.** The two errors point opposite
ways, and only one of them lies.

Losing a random handful of observations lowers `n` honestly. The posterior widens, the
mSPRT crosses later, `probabilityGreater` returns something closer to a half, and the
engine becomes slightly more cautious than the evidence warrants. The cost is a little
statistical power.

Reconstructing a count as `sum(_sample_interval)` raises `n` dishonestly. The mean is
right and the implied certainty is inflated by the sampling factor: a variant seen 100
times at 1-in-100 enters the posterior as 10,000 observations. The posterior narrows past
what the evidence supports, the boundary is crossed on noise, and a good variant is retired
with a confident reason attached to it.

One failure makes the engine timid. The other makes it confidently wrong and leaves a
plausible audit trail. D33's rule — sampled numbers may inform, rank and display, but may
not enter a Beta — is about the second, and it is unaffected by the first.

**What is genuinely exact.** Everything that reaches storage, and every read. The flush
runs synchronously from first statement to last, Durable Objects do not interleave their
own requests, and `countersBetween` flushes before it reads — so there is no window in
which a reader sees half a flush, and no systematic under-count of whatever happened to be
in flight. That last point is worth its own sentence: counts in flight belong
disproportionately to the busiest surfaces, so dropping them would bias the evidence
precisely where it is strongest, which is the worst shape a bias can have.

**What this costs in money, since D33 only estimated it.** At launch traffic, nothing — it
sits inside the free allowance. At 5M events/day the folding and counting is on the order
of $100 a month. That is the price of evidence the engine is allowed to reason from, and
the alternative was not cheaper so much as different: a server big enough to do ClickHouse
merges cost the same order of money, as a fixed fee rather than per event.

---

### D36 — One Durable Object per session, which closes itself — **Taken**

The counters (D33, D35) had no producer. This is it: the piece that decides a session is
over and hands on what it earned.

**Why a session needs an object at all.** The reward is session-scoped — a sign-up belongs
to the whole experience the visitor was shown, not to the click that preceded it — so
nothing can be attributed until the session has ended. Something has to know that it has,
and a session spans requests, so a Worker cannot hold it.

ClickHouse never needed a completion signal: `surface_rewards_hourly` was a _refreshable_
materialized view over a two-hour trailing window, idempotent because `SummingMergeTree`
absorbs a re-run. The counters cannot be recomputed that way — they accumulate — so the
signal has to be explicit.

**Why not the two cheaper options.** Folding from Analytics Engine would work and its SQL
API can group by session id, but it samples, and D33 forbids an estimate from entering a
Beta. Folding inside each surface object would mean eleven copies of the same bookkeeping,
because every session sees every surface — eleven times the writes, and a surface object
single-threaded behind traffic it has no reason to see.

**What makes it affordable.** Every aggregation the ClickHouse fold used is `min`, `max`,
`sum` or `any`, all commutative and associative. So the fold is incremental: a session costs
a fixed handful of scalars rather than a list of its events, and the order they arrive in
does not matter. `session-fold.test.ts` asserts that order-independence directly, because if
it ever stops holding then one object per session stops being enough.

The collector sends one call per session per beacon rather than one per event, which at the
design target is the difference between roughly a million object requests a day and five
million.

---

**Where this diverges from `mv_sessions`, and why that is a fix rather than a drift.**

The ClickHouse fold took `anyState(surfaces)` and `anyState(variants)` — one assignment per
session, picked arbitrarily. But `events.ts` sends the assignment on _every_ event and
explains why in its own comment: a session can span an assignment change, and "attributing
later events to the earlier assignment would silently corrupt the reward attribution."

Those two statements contradict each other. The schema went out of its way to preserve a
distinction the fold then discarded, so a session that saw variant A for two pageviews and B
for three had its entire reward credited to whichever `any` happened to return.

This resolves it the other way: **a session whose assignment changed contributes nothing.**
It is un-attributable by construction — there is no honest answer to which variant earned a
sign-up that happened after the variant changed — and mid-session reassignment is rare,
because it takes a quarantine or an operator pin. The same judgement `parseAssignment`
already makes about a partial vector: discarding costs one session, repairing corrupts a
posterior.

---

**The session timeout is thirty minutes, and it constrains the adapt cycle.**

Nothing in this repository had previously chosen one. Thirty minutes is the web analytics
convention, and worth following for more than familiarity: the number trades attributing a
returning visitor's second visit to the same session against splitting one reading session
in two, and the industry settled it with far more measurement than this project can bring.

The consequence is not optional. Components are filed under the hour the session _started_
in — an hour's traffic is the sessions that began in it, and a session's hour must not move
as it continues, or a long one would leave a window the cycle had already read. But a
session that began at 10:59 can still be open at 11:28, so **an hour is not final until a
session timeout after it ends.** A cycle reading the previous hour immediately would
systematically miss the sessions that straddle the boundary — and straddling sessions are
the long ones, which are also the engaged ones, so the bias would run against exactly the
evidence that matters most.

The adapt cycle therefore reads hours older than `SESSION_TIMEOUT_MS`, and that is a
requirement on the cron rather than a preference.

---

**One failure this design cannot prevent, named rather than hidden.**

`alarm` folds, fans out to the surface objects, then clears its storage. If the fan-out
throws partway, the state remains and the alarm is re-armed, so the next attempt has the
same events — but `SurfaceCounters.record` is additive, so the surfaces that already landed
would be counted twice.

The alternative orderings are worse. Clearing first means a failed fan-out loses the session
entirely. Making the fan-out idempotent means giving each session an id the counters
remember, which is a row per session in every surface object — the per-surface bookkeeping
this design exists to avoid.

So the exposure is: a partial fan-out failure over-counts the surfaces it reached. It takes
an error between two object calls inside one alarm, the over-count is one session, and the
direction is a slightly narrower posterior rather than a wrong leader. That is acceptable
and it is written down so it is not re-discovered as a mystery.

**What it costs.** At launch traffic, nothing. At 5M events/day the folding and counting
together are on the order of $100 a month, which D35 already accounts for.

---

### D37 — The scheduled Worker, and the cycle moves to a package — **Taken**

The last link. Until this existed the chain stopped one step short: beacons reached
Analytics Engine, sessions folded into the surface counters, and nothing read them — so the
published snapshot was never written and every surface resolved to its baseline for ever.
The engine had a producer and no consumer, which is the same shape the whole system was in
before the adapt job was written, one layer down.

**The cycle had to move first.** `adapt.ts`, `adapt-derive.ts` and their ports lived in
`apps/worker`, which made them unreachable from the Worker that now runs them: `CLAUDE.md`
is explicit that apps may depend on packages and never on each other. The cycle decides what
the engine believes, so it is domain logic and belongs in `@morph/cycle` regardless.

Nothing in it changed. Its twenty-five tests passed untouched, which is the
ports-and-adapters discipline doing precisely what it was for — the implementations were
ClickHouse and Postgres, they are now Durable Objects, Analytics Engine, D1 and KV, and the
cycle has no opinion either way.

**A separate Worker from the collector, for least privilege that is not theoretical.** The
collector takes thousands of requests a second from the open internet. This script holds the
D1 binding that can retire a variant and the KV key that decides what every visitor is
shown. One script would mean an exploit in the beacon parser reaching the decision set.

They share the counters namespace, which a Durable Object permits across scripts through
`script_name`. That is the one coupling and it runs the right way round: the collector writes
through the session object, the cron reads.

---

**One interface, two honesty requirements.** `RewardRepository` has two methods and they are
backed by different stores on purpose.

`rewards()` reads the Durable Objects — exact, unsampled, the only thing allowed near a Beta
posterior. `health()` reads Analytics Engine over its SQL API — sampled, and fine for that,
because a p75 LCP a few percent off moves nothing when the thresholds are spaced far wider
than the error. That asymmetry is the whole point of the split and is the thing most likely
to be undone by somebody tidying up, so it is written at both ends.

Reading Analytics Engine needs an HTTPS call and a token, because there is no query binding —
writing is a binding, reading is not. It is the only place in the port where a Worker leaves
Cloudflare's network to talk to Cloudflare.

**And the cycle refuses to run without that token.** `decideAdaptations` looks up each
variant's health with `health.find(...)` and skips the guardrail when it finds nothing. So a
cycle with no readable vitals would still retire variants on reward evidence while being
unable to quarantine a harmful one — the retirement loop running with its safety off,
reporting success.

That is exactly what D30 was written about: a threshold checked against an absent measurement
is worse than no threshold, because it looks like protection. So the absence throws. A thrown
scheduled handler is a failed invocation in the dashboard, which is the only place a missed
cron is visible; swallowing it would make a cycle that never ran look like a cycle with
nothing to do.

---

**Two joints with no compiler behind them**, both of which fail silently and totally, and
both now covered by tests rather than by care.

The snapshot key is a string duplicated between this app and `apps/web`, because apps may
not import each other. Diverge them and the renderer reads a key nobody writes, resolves
every surface to its baseline, and reports a snapshot age of zero — which the thinking bar
displays as "cold start". **A brand new site and a totally broken one look identical.** The
test reads the renderer's source and compares the strings.

The rewards adapter sums across context buckets and drops the holdout. Both are the port's
contract, neither is expressible in its types, and getting the second wrong would fold the
control group into the treatment's evidence — so the holdout lift, the one number that says
whether any of this works, would sit near zero no matter what the engine did.

---

**Smaller decisions worth finding later.**

Two minutes past the hour, not on it. `targetHour` already reads an hour that settled a
session timeout ago, so the delay buys nothing statistically — it exists so the cycle is not
competing with anything else on the hour for a D1 database that is single-threaded.

`ADAPTATION_ENABLED="0"` pauses adaptation without a deploy, and the cycle still runs: it
folds the evidence, writes the posteriors, and publishes a snapshot telling the renderer to
serve baselines. Pausing by disabling the trigger would leave a gap in the posteriors that no
later run could fill.

The engine config is parsed with its zod schema rather than cast. It is written by the admin
console, so it crosses a process boundary, and a malformed weight vector would not fail
loudly — it would quietly change what the engine optimises for. The schema requires the
positive weights to sum to exactly one, so a bad row falls back to the defaults with an error
logged rather than running on arithmetic nobody chose.

`SnapshotWriter` and `CounterReader` are narrowed to the one or two methods each caller
needs, rather than the full `KVNamespace` and `DurableObjectNamespace`. The publisher has no
reason to read the snapshot back; the cron has no reason to write a counter. A type that
cannot do those is a stronger statement than a comment saying it does not — and it was the
tests that pointed this out, by being awkward to write against the wide types.
