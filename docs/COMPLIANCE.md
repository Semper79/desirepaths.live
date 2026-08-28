# Platform compliance

Section 0 of the brief requires "a `docs/COMPLIANCE.md` with the exact rate limits, ToS
clauses and robots policies you implemented against". This is that record.

It exists so that a question three months from now — "why does the crawler wait 1.1
seconds on that host?", "are we allowed to post that?" — has a written answer with a
date on it, rather than an argument.

**Review cadence:** every clause below carries a _Verified_ date. Platform terms change
without notice. A source whose robots policy has not been re-read within its TTL is not
fetched — that is enforced by `crawl_source.robots_checked_at`, not by a reminder.

---

## 1. Hard rules

These are constraints on the product, not settings. `scripts/check-guardrails.mjs` runs
in CI and fails the build on any of them; removing the check means deleting a file,
which is visible in review.

| #   | Never                                                              | Mechanical check           |
| --- | ------------------------------------------------------------------ | -------------------------- |
| 1   | Automated creation of social accounts                              | `no-account-creation`      |
| 2   | Proxy/IP rotation aimed at evading enforcement                     | `no-proxy-rotation`        |
| 3   | Fingerprint spoofing, stealth plugins, detection evasion           | `no-fingerprint-spoofing`  |
| 4   | CAPTCHA-solving services                                           | `no-captcha-solving`       |
| 5   | Follow/unfollow churn, mass DMs, engagement pods, comment spraying | `no-engagement-automation` |
| 6   | Ignoring `robots.txt`                                              | `no-robots-bypass`         |
| 7   | Storing a platform password                                        | `no-credential-storage`    |
| 8   | Timing jitter whose purpose is to look non-automated               | `no-humanisation-jitter`   |

Rule 8 deserves a note, because it is the one people argue about. Backoff and pacing are
legitimate and implemented — they protect the _other_ party's infrastructure. Randomised
jitter whose stated purpose is to defeat automation detection is not, because its
purpose is deception. The difference is the intent, and the intent is legible in the
code and the comments.

There is exactly one place randomness enters our request timing:
`PolitenessScheduler.backOff` spreads retries within an exponentially growing window,
and only after a host has already returned 429 or 503. It exists so that several queued
jobs for one host do not all return in the same instant — it makes the traffic gentler
on the host, not less detectable — and the reasoning is written at the injection point
so the distinction survives the next reader.

---

## 2. Crawling

**Posture: polite by construction.** Preference order is official API → RSS/Atom or
sitemap → HTML, and HTML is the last resort, not the default.

| Control                                    | Value                                             | Where                                 |
| ------------------------------------------ | ------------------------------------------------- | ------------------------------------- |
| Concurrency per host                       | **1**, non-negotiable                             | `CRAWLER_MAX_CONCURRENCY_PER_HOST`    |
| Global request rate                        | 8 req/s across all hosts                          | `CRAWLER_GLOBAL_QPS`                  |
| Default delay between requests to one host | 1,000 ms                                          | `CRAWLER_DEFAULT_CRAWL_DELAY_MS`      |
| `Crawl-delay` directive                    | Honoured; overrides the default when longer       | `crawl_source.crawl_delay_ms`         |
| `robots.txt` cache TTL                     | 24 h; a stale entry blocks the fetch              | `CRAWLER_ROBOTS_CACHE_TTL_SECONDS`    |
| Conditional requests                       | `ETag` / `If-Modified-Since` always sent          | `crawl_source.etag`, `.last_modified` |
| User-Agent                                 | Descriptive, with a contact URL                   | `CRAWLER_USER_AGENT`                  |
| Timeout                                    | 10 s                                              | `CRAWLER_TIMEOUT_MS`                  |
| Backoff on 429/503                         | Exponential with jitter, respecting `Retry-After` | `packages/crawler`                    |
| Circuit breaker                            | Opens after 5 consecutive failures per host       | `crawl_source.consecutive_failures`   |

**Never fetched:** anything behind an authentication wall, anything a `robots.txt`
disallows for our User-Agent, and anything on `CRAWLER_DENYLIST`.

Conditional requests are not only politeness — with `ETag` in place the steady-state
crawl re-fetches almost nothing, which makes the whole pipeline cheap enough to run
hourly.

### robots.txt interpretation

- Longest-match wins for `Allow` / `Disallow`, per the de-facto standard; `Allow` wins a
  tie at equal length.
- A missing `robots.txt` (404) is treated as _allowed_; a 5xx is treated as
  _disallowed_, because a server having a bad day is not consent. A 401/403 on
  `robots.txt` itself is also treated as disallowed: rules behind an auth wall are rules
  we have not been given.
- `Crawl-delay` is honoured even though it is not in the original standard: a host that
  asks for a delay gets it. It is clamped to a minute so one misconfigured host cannot
  stall the queue, and never reduced below our own default — a host asking for less does
  not get to speed us up.
- Wildcards (`*`, `$`) are supported, and pattern metacharacters are matched literally
  because a `robots.txt` is attacker-controlled input from our point of view.
- A redirect is re-checked against the destination's own `robots.txt`, so a redirect
  cannot be used to reach a path — or a host — that would otherwise be disallowed.

### Where these are enforced, and how they are proven

Not conventions every caller has to remember: `packages/crawler` exports no raw fetch
wrapper, so `PoliteFetcher` is the only path from MORPH to a third-party host.

| Claim                                       | Code                                 | Test                           |
| ------------------------------------------- | ------------------------------------ | ------------------------------ |
| robots.txt parsed to the rules above        | `packages/crawler/src/robots.ts`     | `test/robots.test.ts` (27)     |
| One concurrent request per host             | `packages/crawler/src/politeness.ts` | `test/politeness.test.ts` (26) |
| Delay measured from completion, not start   | `politeness.ts` — `end()`            | `test/politeness.test.ts`      |
| Disallowed paths are never requested        | `packages/crawler/src/fetch.ts`      | `test/fetch.test.ts` (38)      |
| Conditional requests always sent            | `fetch.ts` — `send()`                | `test/fetch.test.ts`           |
| Unreadable robots.txt blocks the whole host | `robots.ts` — `policyFrom()`         | both                           |
| Backoff and `Retry-After` on 429/503        | `politeness.ts` — `backOff()`        | both                           |

The politeness tests take time as a parameter rather than sleeping, which is why a
one-minute crawl delay can be asserted in a suite that runs in a second.

---

## 3. Social platforms

MORPH acts **only** through accounts the operator personally created and authenticated
via official OAuth. There is no code path that posts as a visitor, and no database column
for a visitor's posting token.

Every connector shares the same machinery: a token-bucket limiter seeded with the
platform's documented limits, exponential backoff with `Retry-After`, a circuit breaker
that opens on 429/403, and a **daily action cap set well below the platform ceiling**
(`SOCIAL_DAILY_ACTION_CAP`, default 40). The gap between our cap and the platform's is
deliberate headroom: hitting a documented limit is a signal you are operating too close
to the line.

| Platform                  | API                 | Documented limit implemented against                     | Our cap             | Verified              |
| ------------------------- | ------------------- | -------------------------------------------------------- | ------------------- | --------------------- |
| X                         | API v2, Basic tier  | 100 posts / 24 h per user; 60 reads / 15 min             | 40 posts/day        | _pending credentials_ |
| Meta (Instagram, Threads) | Graph API           | 50 content publishes / 24 h per IG account               | 25/day              | _pending app review_  |
| TikTok                    | Content Posting API | Rate limits per app, published in the developer console  | 10/day              | _pending app review_  |
| Discord                   | Bot API             | Global 50 req/s; per-route buckets from response headers | 40 messages/day     | _pending_             |
| Reddit                    | API (OAuth)         | 100 QPM per OAuth client, averaged over 10 min           | 20 posts/day        | _pending_             |
| YouTube                   | Data API v3         | 10,000 quota units/day; a read costs 1, an upload 1,600  | read-only at launch | _pending_             |

The "pending" markers are honest: the exact numbers must be re-read from each platform's
developer documentation at the moment credentials are obtained, and this table updated
with the date. A rate-limit table copied from a blog post is worse than no table.

### Terms of service clauses implemented against

Recorded per platform when credentials are obtained. Each entry names the clause, quotes
the operative requirement in a few words, and links to the code that satisfies it. Left
deliberately empty rather than filled with plausible-looking references — see D7 in
`docs/DECISIONS.md`.

---

## 4. The approval queue

Every outbound post passes through `outbound_post`. Autonomy has three levels
(`SOCIAL_AUTONOMY`), defaulting to `review`:

| Level    | Behaviour                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `manual` | Nothing is drafted automatically.                                                                                                       |
| `review` | Drafted, queued, published only after the operator approves via `/queue`.                                                               |
| `auto`   | Published without a human — **only** when the safety classifier returned `safe` **and** the post matches an operator-approved template. |

The `auto` condition is a database CHECK constraint on `outbound_post`, not application
logic:

```sql
CHECK (status <> 'approved'
       OR approved_by IS NOT NULL
       OR (autonomy_at_creation = 'auto' AND safety_verdict = 'safe' AND template_id IS NOT NULL))
```

Putting it in the schema means no future code path can skip it, including one written in
a hurry by someone who has not read this document.

---

## 5. The safety classifier

Runs before anything reaches the site or a social platform, in
`packages/crawler/src/safety.ts` (25 tests). Rule-based rather than a model, and
deliberately so — see D15. `block` beats `review` beats `allow`, and one blocking
category is enough however many others were clean.

**Blocked outright — never published without a human writing it:**

| Category                                            | Id          |
| --------------------------------------------------- | ----------- |
| Political and electoral content                     | `electoral` |
| Violence, disaster and loss of life                 | `tragedy`   |
| Medical claims and health advice                    | `medical`   |
| Investment and financial advice                     | `financial` |
| Content concerning children                         | `minors`    |
| Ongoing legal proceedings — litigation, allegations | `legal`     |
| Adult content                                       | `adult`     |

**Held for the operator rather than dropped** — not inherently unsafe, but not something
to publish unread:

| Category                                 | Id         |
| ---------------------------------------- | ---------- |
| Unverified breaking news                 | `breaking` |
| Protected characteristics as the subject | `identity` |

**Not enforced in code, and named rather than implied:** "anything naming a private
individual". Term matching cannot detect it — that needs named-entity recognition plus a
judgement about whether the person named is public, and a rule set that tried would
either miss most cases or block every article mentioning anybody. It is carried instead
by `SOCIAL_AUTONOMY` staying at `review`, where a human reads the draft. Stated here
because a compliance claim no code implements is worse than an acknowledged limitation.

Rejections are logged with the rule that fired and the exact terms that fired it
(`trend_signal.safety_reason`), because "the classifier said no" is not a reviewable
answer — and because a bad rule should be visible and fixable rather than mysterious.

The reasoning behind the strictness: newsjacking a disaster is a brand-ending mistake,
and it is exactly the kind of thing a momentum-scoring pipeline will surface first,
since tragedy has enormous momentum. The classifier is the thing standing between a
momentum score and a catastrophe.

---

## 6. Growth strategy — what is actually done instead

The compliant levers, all automated:

1. **Content quality and timing.** Publishing genuinely relevant material when the
   audience is measurably active, learned per platform from that platform's own
   analytics API.
2. **Conversion optimisation.** The adaptive engine. This is where most of the
   compounding gain comes from, and it is entirely first-party.
3. **Frictionless onboarding.** One-tap social sign-in, with the provider ordering
   itself adaptive.
4. **Referral.** An on-site invite mechanic with a real incentive, tracked end to end.
   Peer invitation is the only follower-growth mechanism that compounds and cannot get
   you banned.
5. **SEO/AEO.** Structured data, per-page OG images, sitemap, RSS, clean semantic HTML.
   Organic search and AI-answer citation are the largest sustainable acquisition
   channels and are treated as first-class.
6. **Community listening.** Conversations where the account could genuinely contribute
   are surfaced _to the operator in the report_. Suggested, never auto-replied.

---

## 7. Accessibility

WCAG 2.2 AA is a product requirement, not a checklist item:

- Every palette variant is contrast-checked **at generation time**
  (`packages/core/src/color.ts`); a failing variant is rejected before it can be served.
  There is no code path that admits one.
- Every animating surface must keep a `reducedMotionSafe` variant active, enforced by
  `validateSurface`.
- Tap targets never fall below 44 px, enforced as a surface invariant on
  `layout.density`.
- Generated copy has a reading-level ceiling per surface.
- axe runs in CI against **every** palette, density and layout variant — not only the
  baseline. A budget that holds only for the variant nobody sees is not a budget.

---

## 8. Content provenance

Generated content carries a visible "generated, human-reviewable" provenance record,
mandatory source attribution, and a `reviewed_by` / `reviewed_at` pair. Both are database
constraints:

```sql
CHECK (status <> 'published' OR jsonb_array_length(sources) > 0)
CHECK (status <> 'published' OR generated_by IS NULL OR reviewed_at IS NOT NULL)
```

Publishing generated content with no sources, or with no human review, is not a policy
violation in this system. It is a constraint violation.
