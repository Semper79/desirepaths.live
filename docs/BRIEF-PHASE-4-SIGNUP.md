# Brief — Phase 4: visitor sign-up

A self-contained implementation brief for an agent that has not seen this repository
before. Read it in full before writing anything. Where it cites a file, open the file:
the reasoning lives in the code comments and this brief does not repeat it.

**The one-sentence job:** visitors can create an account through OAuth, and the site can
tell the adaptive engine that it happened.

Everything else described here is a constraint on how.

---

## 0. Read these first, in this order

| File                                        | Why                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| `CLAUDE.md`                                 | The working agreement. The guardrails in it outrank this brief.          |
| `docs/DECISIONS.md` D5                      | Which providers ship, and why five rather than ten.                      |
| `docs/DECISIONS.md` D6                      | What an account is _for_. Decided: the site stays fully open.            |
| `docs/PRIVACY.md`                           | What the system currently promises about personal data. You change this. |
| `packages/core/src/surfaces/registry.ts` §9 | The surface you must not break.                                          |

---

## 1. What already exists — do not rebuild it

This is the most important section. Roughly half of Phase 4 is already written, and the
common failure mode for this task is building a second, parallel version of it.

**The measurement side is complete.**

- `packages/core/src/events.ts` already defines `signup_view`, `signup_start` and
  `signup_complete`. `signup_complete` is already validated to carry a `provider` prop —
  see the check at line ~107, which rejects the event without it.
- `packages/core/src/session-fold.ts` already folds those into `signedUp` and `signups`.
- The composite reward already weights sign-up at 40%. Nothing in `packages/adaptive`
  needs to change, and you must not change it (see §2).

So you do **not** design an event schema, a reward signal or a counter. You emit the
three events that exist, at the right moments, through the beacon that already ships
them.

**The adaptive surface is complete.**

`signup.providers_order` is surface 9 in the registry. It is declared as `kind:
'ordering'` over `AUTH_PROVIDERS`, with a payload of `{ order: AuthProvider[] }`, minimum
three. The home page already renders it: `apps/web/src/app/page.tsx`, the `Signup`
component.

The registry removes absent providers from the variant space, which is how D5 intends
unset providers (X, Reddit, Twitch, Spotify, Instagram) to behave. Confirm that still
holds once providers are real; do not add a second filter in the page.

**The environment contract is already declared.**

`.env.example` already names `AUTH_SECRET`, `AUTH_TRUST_HOST`, and `AUTH_<PROVIDER>_ID` /
`_SECRET` for each provider. The intended library is therefore Auth.js (NextAuth v5), and
that is settled — do not substitute another.

**A session implementation already exists, and it is not yours.**

`apps/admin/src/lib/session.ts` is a signed-cookie session for the single operator. Its
own header comment says explicitly that it is not what Phase 4 builds. Visitor sign-up is
a different audience, a different threat model and a different table. Do not merge them,
and do not import from `apps/admin` — see §2.

**The current placeholder you are replacing.**

`apps/web/src/app/join/page.tsx` says sign-up is not open, and the provider buttons link
to it rather than to OAuth. Both are deliberate and both go away when this lands. Read
that file's header comment before deleting it: it records why there is no email capture
on the page, and that reasoning still applies to anything you build.

---

## 2. Hard constraints

These are not style preferences. A change that violates one of them is wrong even if it
works.

**Architecture**

- `packages/adaptive` has zero runtime dependencies and performs no I/O. Do not touch it.
- `packages/core` owns every zod schema and every shared type. If a shape is needed in two
  places it lives there — not duplicated, not re-declared structurally.
- Apps may depend on packages. Packages may never depend on apps. `apps/web` must not
  import from `apps/admin`.

**TypeScript**

- `strict`, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- No `any`. No non-null assertion without an `eslint-disable-next-line` carrying a reason.
- `as unknown as` is lint-enforced against. If you need it, the type is wrong.
- Anything crossing a process boundary — HTTP body, OAuth provider response, cookie
  payload — is parsed with zod, never cast.

**Comments and language**

- English everywhere: identifiers, comments, copy, docs, commit messages.
- Comments explain _why_, never _what_. A comment restating the code gets deleted.
- A file implementing a rule from a decision cites it, e.g. `// D5: five providers`.

**The runtime — read this twice**

The site is a Cloudflare Worker, built by OpenNext. It is **not** a Node server.

- There are no Node built-ins unless `nodejs_compat` covers them. `apps/admin`'s session
  code uses Web Crypto specifically because `node:crypto` fails the build in middleware.
  Assume the same applies to you.
- Secrets are `wrangler secret put`, not `.env`. `.env.example` is the declaration of what
  exists; `apps/web/wrangler.jsonc` is where bindings live, and secrets are deliberately
  absent from it.
- Bindings are per-request. Anything reading `env` at module scope will find nothing and
  then keep finding nothing for the life of the isolate. `apps/web/src/lib/bindings.ts`
  is the existing pattern — use it.
- **`.env.example` still mentions Caddy and `AUTH_TRUST_HOST` behind a proxy.** That text
  predates the Cloudflare port (D31) and is stale. There is no Caddy. Fix the comment
  while you are there.

**Privacy — this is the part most likely to be skipped**

The operator is EU-based and the site currently holds no personal data: a rotating daily
pseudonymous hash and nothing else. `docs/PRIVACY.md` says so in those words, and
`/privacy` renders from it.

Accounts change that, so these are deliverables, not follow-ups:

1. `docs/PRIVACY.md` and `docs/COMPLIANCE.md` updated to describe what an account holds,
   the lawful basis for it, and the processors involved.
2. A retention entry for every new table in `packages/core/src/db/retention.ts`. There is
   a test that reads the migration and fails on any table without a decision — it will
   catch you, and it is meant to.
3. Export and erasure must cover accounts. The `data_subject_request` table exists;
   **no endpoint does.** Shipping accounts without erasure is shipping a GDPR violation.
4. Personalised adaptation requires _explicit consent_; aggregate adaptation runs under
   legitimate interest. `packages/core/src/consent.ts` has the category model and the
   bitmask. An account does not by itself grant consent to personalised adaptation.
5. OAuth tokens are encrypted at rest. Passwords are never stored — there are none.

---

## 3. Scope

**Decided by D5 — build these:** Google, Apple, Discord, TikTok, passkeys, and email
magic link as the no-social path.

**Decided by D5 — declared but unset:** X, Reddit, Twitch, Spotify, Instagram. They stay
in `AUTH_PROVIDERS` and stay without credentials. Adding one later must be a credential,
not a release.

**Decided by D6 — the site stays fully open.** No metering, no wall, no gated content. An
account adds personalisation and the digest. If you find yourself writing a check that
denies content to a signed-out visitor, you have misread the decision.

**Out of scope:** the digest itself, personalisation beyond recording consent, the admin
console, anything in `apps/worker`.

---

## 4. What to build

### 4.1 The auth routes

Auth.js (NextAuth v5) under `apps/web/src/app/api/auth/`. The provider buttons previously
pointed at `/api/auth/signin/<provider>`, which is Auth.js's own shape — keep it, so the
only change to `page.tsx` is restoring the link target and the "Continue with" label.

Verify Auth.js runs under OpenNext on Workers before building on it. `@auth/core` is
Web-standard and should; the Next adapter's assumptions are the risk. If it cannot be made
to work, stop and say so rather than shimming a Node runtime into the Worker — that trade
is the operator's to make, not yours.

### 4.2 Persistence

Accounts, sessions and provider links in D1, in `packages/core/src/db/sqlite.ts` alongside
the existing seven tables. Follow the conventions already there: `text({ enum })` plus
CHECK constraints rather than a Postgres-style enum, `crypto.randomUUID()` for ids,
`json_array_length` rather than the jsonb spelling.

Generate the migration with drizzle-kit as the existing tables were. Do not hand-write it.

Add every new table to `RETENTION_DAYS`. Decide the number deliberately and write down why
in the comment — that file is a policy document that happens to be executable.

### 4.3 Wiring the events

- `signup_view` when the sign-up surface is rendered to a visitor.
- `signup_start` when a provider is chosen.
- `signup_complete` on successful callback, **carrying `provider`** — the event is
  rejected without it.

These go through the existing beacon (`apps/web/src/components/beacon.tsx`), which posts
to `/i`. Do not add a second transport.

The reason `signup_complete` must name the provider: it is what closes the loop on
`signup.providers_order`. Without it the surface has impressions and no conversions, and
the bandit will explore for ever.

### 4.4 Readiness

`apps/web/src/app/api/ready/route.ts` reports what a deployment cannot serve without. If
`AUTH_SECRET` is missing, sign-up is broken and the probe should say so by name — read
that file's comment on why a missing pepper is "not ready" and apply the same judgement.

A provider without credentials is **not** a readiness failure: D5 says unset providers
drop out of the variant space. That is a supported state, not a broken one.

---

## 5. What the operator must do, and you cannot

Do not attempt these, and do not work around them. Creating accounts on third-party
services is explicitly forbidden by `CLAUDE.md`.

1. Register OAuth applications: Google, Apple, Discord, TikTok.
2. Apple is the long pole: a paid Developer Program membership, a Services ID, and a key
   rather than a secret — its client secret is a **JWT that expires and must be
   regenerated**. Design for that; do not assume a static secret string.
3. Callback URLs, which need the live domain: `https://desirepath.live`.
4. Set each credential with `wrangler secret put` on `apps/web`.

If credentials are absent, the feature must degrade to the current honest state rather
than erroring.

---

## 6. Definition of done

Nothing is done until this passes at the repository root:

```bash
pnpm verify
pnpm format:check
```

`pnpm verify` runs typecheck, lint, the guardrail check, coverage and build.
`format:check` is a separate CI job and is **not** part of `verify` — it is the gate most
often missed.

Coverage thresholds are enforced per project and are not advisory: 100% branches in
`packages/adaptive`, 80% elsewhere.

Beyond the gate:

- A real sign-up completes end to end against at least one provider.
- `signup_complete` arrives at the collector carrying its provider.
- `/api/ready` names `AUTH_SECRET` when it is unset.
- A signed-out visitor can still read everything (D6).
- `docs/PRIVACY.md`, `docs/COMPLIANCE.md` and the retention policy describe what now
  exists, and an erasure request can actually be fulfilled.

---

## 7. Known traps

- **The gate cannot see a broken link.** Nothing in the suite follows an `href`, and
  `next build` does not resolve them. `/join` and four provider buttons pointed at routes
  that never existed and shipped to production that way. Check the links you change by
  requesting them.
- **`pnpm verify` does not build the Worker.** It builds the Next app. The Worker bundle
  is produced by `opennextjs-cloudflare build`, and the two have failed independently —
  a Next upgrade once passed the whole gate and then threw on every request in production.
  If you can, verify the deployed site, not just the build.
- **Windows cannot build the Worker locally.** `opennextjs-cloudflare build` fails with
  EPERM on pnpm's symlinks on the operator's machine. CI builds on Linux. Do not spend
  time on that failure; it is environmental.
- **Do not add `sharp`, or anything that pulls it.** Keeping it out took
  `ignoredOptionalDependencies` plus `hoist-pattern` exclusions in `.npmrc`; the comments
  there explain why `serverExternalPackages` is not the fix.
- **`next/og` does not work here.** It resolves a fallback font at module scope and the
  file is not in the package. Do not add an `ImageResponse` route.
- **The two names.** The product is Desire Path; the repo, the `@morph/*` namespace and
  the `MORPH_*` variables are MORPH. A comment may say MORPH; a string a person reads says
  Desire Path. `apps/web/src/lib/site.ts` is the only place the public name is written.

---

## 8. Guardrails — these outrank everything above

From `CLAUDE.md`. If the task appears to require one of these, stop and say so rather than
finding a way.

1. No automated creation of social media accounts. The system acts only through accounts
   the operator personally created and authenticated via official OAuth.
2. Nothing whose purpose is evading platform detection, rate limits or enforcement:
   proxy/IP rotation, fingerprint spoofing, CAPTCHA solving, residential proxies,
   session-cookie replay, "humanisation" jitter.
3. No follow/unfollow churn, mass DMs, engagement pods, comment spraying, hashtag
   stuffing, or automated engagement with accounts that have not opted in.
4. No scraping in violation of `robots.txt`, Terms of Service, or behind an auth wall.
5. No storing social platform passwords. OAuth tokens only, encrypted at rest.

For this task, guardrail 1 is the live one: registering the OAuth applications is the
operator's job, by hand. Guardrail 5 governs how you store what those applications return.
