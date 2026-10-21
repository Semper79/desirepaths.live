# Privacy

The operator is EU-based. This document is the design, not a policy page — it says what
the system actually does with personal data and where in the code each claim is
enforced. The public-facing privacy notice is generated from it and must never say more
than it does.

> **The controller identity (D4) is enforced, not awaited.** Three variables —
> `MORPH_CONTROLLER_NAME`, `MORPH_CONTROLLER_ADDRESS`, `MORPH_CONTROLLER_EMAIL` — carry it,
> and until all three are set the collector refuses every beacon with 503, `/ready` refuses
> the deployment and names what is missing, and `/privacy` states that nothing is being
> recorded. The requirement "filled in before the first visitor is measured" is therefore a
> property of the system rather than something to remember: a deployment that cannot name
> its controller does not measure anybody. The three facts are still the operator's to
> supply; nothing here invents them.

---

## 0. Where this runs, and why that is a harder question than it was

The original design (D3) put everything on one server in Falkenstein, which made "where
does the data live" a one-word answer. The Cloudflare port (D31) removes that answer and
does not replace it with an equally simple one, so it is worth being precise rather than
reassuring.

**Processing location is not fixed.** A visitor's request is handled at whichever Cloudflare
location is nearest to them, which can be outside the EU. That is a transfer in the sense
Chapter V cares about, and no configuration flag makes it untrue.

**What is actually transferred is the mitigation, and it is a real one.** The IP address is
hashed inside the request that received it, with a daily-rotating salt and a pepper the
Worker never writes down, and the original is discarded before anything reaches storage.
There is no row, in any store, that contains an IP address. What crosses a border is the
request itself — which is unavoidable for any website — not a record that persists there.

**Where the records do live:**

| Store            | What is in it                                | Location control                                             |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------ |
| D1               | content, consent records, the adaptation log | `--jurisdiction eu` at creation. Not yet applied — see below |
| Durable Objects  | exact per-variant counters, no identifiers   | `locationHint` at creation                                   |
| Workers KV       | sticky assignments (anonymous id → variant)  | Global by design; not constrainable                          |
| Analytics Engine | sampled behavioural events                   | Not constrainable                                            |

**The open piece, and it has a deadline.** D1 takes `--jurisdiction eu` at creation, which
restricts both where the data is stored and where queries run. It is a **creation-time**
choice: there is no command that moves an existing database into a jurisdiction, so the
only way to change it later is to create a new one and migrate. Nothing has been created
yet, which means this is currently free and becomes a migration the moment there is a row
of content. It therefore belongs with D4 rather than after it.

Note that `--jurisdiction` and `--location` are not the same thing and the first wins:
`--location` is a hint about the primary replica and is ignored outright when a
jurisdiction is set. A hint is not a guarantee, and only the jurisdiction is.

Durable Objects take the same constraint through `jurisdiction` when deriving an object id.
The counters hold no identifiers at all — surface, variant, two integers — so this matters
less there, but it costs nothing to set.

KV and Analytics Engine cannot be constrained. That is defensible only because of what
they hold: an anonymous id with no linkage to a person, and sampled events keyed on that
same id. If either ever held something more, this paragraph stops being an explanation and
becomes a problem.

---

## 1. The two modes

MORPH runs one of two genuinely different systems depending on consent. This is the
whole design, and everything else follows from it.

**Aggregate mode (default, no consent beyond `necessary`).**
Behaviour is measured through a rotating daily pseudonymous identifier. There is no
profile, no cross-day linkage, and no per-visitor state beyond the current session's
variant assignment. The adaptive engine runs on aggregate counters only. Legal basis:
legitimate interest (Art. 6(1)(f)) for first-party, non-tracking measurement of the
operator's own site.

**Personalised mode (explicit `personalisation` consent).**
A visitor's own history informs their own experience. Legal basis: consent
(Art. 6(1)(a)). No surface reaches this mode unless its
`SurfaceConstraints.requiresConsent` says `personalisation` _and_ the visitor granted it.

Refusing everything does not degrade the site. It pins the visitor to the baseline
assignment — which is exactly what the 5% holdout cohort already sees, and therefore a
known-good experience rather than a punishment.

---

## 2. The anonymous identifier

```
anon_id = sha256( pepper ‖ daily_salt ‖ ip ‖ user_agent )[0..16]
```

- `pepper` is a 32-byte server-side secret (`ANON_ID_PEPPER`), never sent to a client.
- `daily_salt` rotates at 00:00 UTC. Yesterday's identifier cannot be recomputed for the
  same visitor, so cross-day linkage is infeasible even with database access.
- The raw IP is used inside the edge process and discarded. It is never written to a
  database, never logged, and stripped from traces by the OpenTelemetry collector
  (`infra/otel/config.yaml`).
- No cookie is set for measurement. Session continuity uses a `sessionStorage` id that
  dies with the tab.

**What this buys:** the identifier is pseudonymous, not anonymous — it is still personal
data under GDPR, and this document does not pretend otherwise. What the rotation buys is
that the _window_ of linkability is one day, which is what makes legitimate interest a
defensible basis for aggregate measurement, and what bounds the scope of an erasure
request to something the system can actually honour.

**What it costs:** returning-visitor measurement is genuinely weaker. "New vs returning"
is inferred within a day and from the authenticated user id thereafter. That is accepted.

---

## 3. Consent

Four TCF-style categories: `necessary`, `analytics`, `personalisation`, `marketing`,
stored as a 4-bit mask (`packages/core/src/consent.ts`) and written onto every event, so
a consent-scope audit can be answered from the event stream itself rather than from a
cookie somebody has since cleared.

Consent decisions are **append-only** (`consent_record`). A change of mind is a new row,
never an `UPDATE`: the operator must be able to demonstrate what a person consented to
_at the time_ an event was recorded, and an update destroys exactly that evidence. Each
row carries the `policy_version` shown, so the record is reproducible.

The banner is a real gate, not a formality:

- Rejecting is exactly as easy as accepting — one tap, same visual weight.
- No pre-ticked boxes, no legitimate-interest toggles pre-enabled for marketing.
- No dark patterns. The adaptive engine is not permitted to optimise the consent banner:
  it is not a surface in the registry, and it never will be. An optimiser pointed at a
  consent rate produces a dark pattern by construction.
- Withdrawal is available at `/privacy` at any time, and takes effect on the next
  request.

---

## 4. Retention

| Data                               | Where                   | Retention                     | Enforced by                   |
| ---------------------------------- | ----------------------- | ----------------------------- | ----------------------------- |
| Raw behavioural events             | ClickHouse `events`     | **90 days**                   | `TTL ... DELETE` on the table |
| Hourly aggregates (no identifiers) | ClickHouse MVs          | 25 months                     | table TTL                     |
| Session folds                      | ClickHouse `sessions`   | 25 months                     | table TTL                     |
| Dead-letter payloads               | ClickHouse `events_dlq` | 14 days                       | table TTL                     |
| Account and linked identities      | Postgres                | until erasure                 | erasure job                   |
| Consent records                    | Postgres                | 25 months after last activity | retention job                 |
| Adaptation log                     | Postgres                | 25 months                     | monthly partition drop        |
| Data-subject request log           | Postgres                | indefinite                    | —                             |

Retention is enforced by the storage engine, not by a cron job somebody can forget.
`RAW_EVENT_RETENTION_DAYS` in `.env.example` documents the 90-day commitment; changing
it without changing this file is a compliance bug, and the CI check treats a mismatch as
a failure.

The data-subject request log is retained indefinitely **on purpose**: it holds no
personal data beyond an opaque reference that resolves to nothing once erasure
completes. Deleting the proof of deletion is how an operator fails an audit while having
done everything right.

---

## 5. Data-subject rights

| Right                              | Endpoint                  | Behaviour                                                                                                                                                                              |
| ---------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access / portability (Art. 15, 20) | `GET /api/v1/me/export`   | Authenticated. Returns JSON: profile, linked identities, consent history, referrals, and the last 90 days of that user's events. Delivered within 30 days, in practice within minutes. |
| Erasure (Art. 17)                  | `DELETE /api/v1/me`       | Two-step with email or provider re-confirmation. Postgres rows deleted in a transaction; ClickHouse rows removed by a bounded lightweight delete in the same job.                      |
| Rectification (Art. 16)            | `/settings`               | Direct edit.                                                                                                                                                                           |
| Objection (Art. 21)                | Consent banner → withdraw | Pins the visitor to the baseline immediately.                                                                                                                                          |
| Restriction (Art. 18)              | Contact address           | Manual; the account is flagged and excluded from all processing.                                                                                                                       |

**The honest limit on erasure.** ClickHouse rows are reachable only through `user_id`
(for authenticated events) or through an `anon_id` from the last 90 days. Because the
salt rotates daily, events older than the raw retention window cannot be tied to a
person by anyone, including the operator — which is why the retention window and the
erasure reach are the same 90 days. Aggregates contain no identifier and are outside the
scope of an erasure request; that is a factual statement about the data, not a refusal.

---

## 6. What is deliberately not built

- **No third-party analytics.** No Google Analytics, no Meta Pixel, no session-recording
  tool. Every measurement is first-party.
- **No cross-site tracking.** No third-party cookies, no fingerprinting, no ID graph, no
  data broker enrichment.
- **No data sale or sharing.** The only outbound personal data is what a visitor's own
  OAuth provider already knows about them.
- **No profiling with legal or similarly significant effects.** Adaptation changes a
  headline and a colour scheme. It does not price, rank, score or gate anyone.
- **No optimisation of the consent gate.** See section 3.

---

## 7. Sub-processors

At launch, personal data is processed only by:

| Processor             | Purpose                                     | Location                                 |
| --------------------- | ------------------------------------------- | ---------------------------------------- |
| Hosting provider (D3) | All application and database processing     | EU                                       |
| OAuth providers       | Authentication, at the visitor's initiation | Various — the visitor's own relationship |
| Anthropic             | Content and variant generation              | US — **no personal data is sent**        |
| Telegram              | Operator reporting                          | **Aggregates only — no personal data**   |

The Anthropic and Telegram rows carry the important qualifier. Generation prompts
contain trend clusters and aggregate performance statistics; the hourly report contains
counts and rates. Neither ever contains a visitor identifier, an IP, a user agent or an
email address, and the report composer's input type (`packages/telegram/src/types.ts`)
has no field that could carry one — the type system is the enforcement.

---

## 8. Security measures (Art. 32)

- TLS 1.3 everywhere; HSTS with preload; strict CSP with no `unsafe-inline` for scripts.
- OAuth refresh tokens encrypted at rest with AES-256-GCM; the key lives in the
  environment, never in the database. **No platform passwords are stored, ever** — there
  is no column for one.
- Least-privilege database roles per service (`infra/postgres/init/001_bootstrap.sql`).
  A compromised web process cannot rewrite the adaptation log.
- The adaptation log is append-only by permission, not by convention.
- Postgres and ClickHouse bind to loopback only; nothing but Caddy is publicly reachable.
- Design tokens from generated variants are constrained to a CSS custom-property
  allowlist (`packages/core/src/surfaces/tokens.ts`), so a model-generated variant
  cannot inject CSS or markup.
- Secret scanning and dependency audit in CI on every push.

---

## 9. Breach procedure

1. Contain, then assess scope from the audit trail.
2. Notify the supervisory authority within **72 hours** where the breach is likely to
   result in a risk to rights and freedoms (Art. 33).
3. Notify affected individuals without undue delay where the risk is high (Art. 34).
4. Record every breach in the internal register, including those not notified and the
   reasoning for not notifying.

`docs/RUNBOOK.md#security-incident` holds the operational steps.

---

## 10. DPIA trigger

A Data Protection Impact Assessment is required before any of the following ships:

- Personalised adaptation keyed to an individual's history.
- Any processing of data from visitors known to be under 16.
- Any inference of a special category (Art. 9) from behaviour.
- Automated decision-making with legal or similarly significant effects.

None of these are in Phases 0–8. The first one is a plausible Phase 9, and it is listed
in `docs/DECISIONS.md` as deferred for exactly this reason.
