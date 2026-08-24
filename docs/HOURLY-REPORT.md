# The hourly Telegram report

Section 9.4 of the brief: "The exact shape of one hourly Telegram report, filled with
realistic sample data."

**This page is generated, not written.** The text below is the actual output of
`packages/telegram`, produced by the same code path the bot uses, from the fixture in
`packages/telegram/src/sample.ts`. Regenerate it with:

```bash
pnpm report:sample
```

A hand-written example of a machine-generated artefact drifts from reality within a
week. This one cannot: the test suite asserts against the same fixture, so a change that
breaks the report's promises breaks a test first.

---

## How it is produced

The pipeline is deliberately not "ask a model to write a report":

1. The worker gathers facts from ClickHouse and Postgres into a typed `ReportInput`.
2. `composeReport` renders them deterministically. Every number in the output came from
   that object; nothing is inferred or rounded twice.
3. Optionally, the _same_ structured input is handed to Claude for a prose pass over the
   narrative sections.

Step 2 is both the contract and the fallback. The model makes the report read better; it
never decides what the report says. If the API is down, the operator still gets an
accurate report.

## Design decisions visible in the output

- **Deltas are against the same hour last week, never against last hour.** A site with
  daily and weekly seasonality makes hour-over-hour comparison meaningless: 03:00 is
  always quiet, and Sunday is not Tuesday.
- **The largest funnel regression is named.** An operator scanning on a phone should not
  have to compare five numbers to find the one that moved.
- **Every adaptation carries its statistical justification in plain English.**
  "96% probability of being worse than the leader over 3.1k impressions" is actionable;
  "p = 0.014" is not.
- **Holdout lift is its own section.** It is the number that says whether the whole
  system is worth running, and it is reported both cumulatively and for the hour.
- **Messages split at section boundaries.** Telegram caps a message at 4,096 characters.
  Splitting at the nearest line would orphan a section heading at the bottom of one
  message, which reads like a rendering bug.
- **A quiet hour gets one line.** A report that is always long is a report nobody reads.

---

## The rendered report

Escapes are stripped below for readability. The raw MarkdownV2 that Telegram actually
receives is what `pnpm report:sample` prints first.

```text

========================================================================
FULL REPORT — 5012 characters, 2 message(s)
========================================================================

*MORPH · hourly report*
2026-08-24 14:00–15:00 Europe/Rome · uptime 11d 6h
🟢 web  🟢 api  🟢 worker  🟢 clickhouse  🟡 redpanda

*1 · Traffic*
18.4k sessions (+21.2% vs same hour last week)
15.9k uniques · 47.1k pageviews · 12.9k new / 3.0k returning

_Sources_
  tiktok — 6.2k (+48.0%)
  organic search — 4.9k (+9.0%)
  direct — 3.4k (+2.0%)
  chatgpt — 2.1k (+134.0%)
  discord — 1.8k (−7.0%)

_Countries_
  IT — 5.9k (+11.0%)
  US — 4.4k (+31.0%)
  DE — 2.1k (+6.0%)
  FR — 1.9k (+14.0%)
  ES — 1.5k (+19.0%)

_Pages_
  / — 18.4k (+21.0%)
  /live — 9.8k (+55.0%)
  /t/ambient-computing — 6.2k (+290.0%)
  /how-it-works — 4.1k (−4.0%)
  /join — 3.9k (+18.0%)

*2 · Conversion*
421 sign-ups · rate 2.28% · activation 61.2%

_By provider_
  discord — 138 (12.1% of views)
  google — 112 (9.4% of views)
  tiktok — 89 (8.3% of views)
  apple — 51 (7.1% of views)
  passkey — 19 (15.5% of views)
  email — 12 (3.8% of views)

_Funnel_
  land — 18.4k (100.0%, ±0.0pp)
  signup_view — 7.6k (41.4%, +2.1pp)
  signup_start — 2.0k (25.9%, −3.8pp)
  signup_complete — 421 (21.2%, +0.6pp)
  activated — 258 (61.2%, +1.4pp)

⚠️ Largest regression: *signup_start* at −3.8pp versus the same hour last week.

*3 · How MORPH reacted*
⬇️ *retired* `hero.headline#now` (Urgency)
   Retired hero.headline#now — 96% probability of being worse than the leader over 3.1k impressions; sequential test concluded worse (always-valid p = 0.014).
🌱 *generated* `hero.headline#g7f2` (Ambient-computing angle)
   Generated from the winning "live proof" framing conditioned on the ambient-computing cluster (momentum 0.81). Passed schema, reading grade 6.4, and the safety classifier. Injected with an optimistic Beta(3, 12) prior.
🚧 *quarantined* `hero.media#canvas` (Reactive canvas)
   Quarantined by the rollback guardrail: LCP p75 2740ms exceeds the 2000ms budget on phone over 612 samples. Champion unaffected.
⬆️ *promoted* `signup.providers_order#discord-first` (Discord first)
   Promoted to champion for the phone|social context bucket — 12.1% sign-up rate against 9.4% for Google-first over 4.8k impressions, 99% probability of being better.

_Current champions_
  hero.headline → `hero.headline#live-proof`
     2.71% [2.44%–3.00%] over 41.2k impressions · 6 active
  theme.palette → `theme.palette#dark-neon`
     2.64% [2.48%–2.81%] over 88.5k impressions · 4 active
  signup.providers_order → `signup.providers_order#discord-first`
     12.10% [11.20%–13.10%] over 4.8k impressions · 5 active
  layout.density → `layout.density#dense`
     2.59% [2.41%–2.78%] over 52.0k impressions · 3 active

_Live look right now_
  dark-neon · grotesk · dense · motion subtle

*4 · What the web is saying*
4.8k documents from 61 hosts.

_New clusters_
  Ambient computing and always-on wearables
     momentum 0.81 · fit 0.74 · saturation 0.22 · 143 docs
  Open-weight small models on consumer hardware
     momentum 0.66 · fit 0.69 · saturation 0.41 · 97 docs
  Type design revival in indie web
     momentum 0.44 · fit 0.58 · saturation 0.12 · 38 docs

_Published_
  Why your watch is becoming the interface `/t/ambient-computing`

_Queued for review_
  Small models, big rooms: what actually runs on a laptop now

_Rejected by the safety classifier_
  Regional election polling surge — political/electoral — categorically excluded
  Unverified outage rumour at a major platform — unverified breaking news — no corroborating primary source

*5 · Social*
Autonomy: `review` · 2 awaiting approval
  x — 1 posts · 12.4k impressions · 388 engagements · followers +41
     rate-limit headroom 82%
  instagram — 1 posts · 8.9k impressions · 612 engagements · followers +77
     rate-limit headroom 91%
  discord — 2 posts · 3.1k impressions · 244 engagements · followers +19
     rate-limit headroom 95%

👉 /queue to approve or reject

--- message break ---

*6 · Holdout lift*
This hour +18.4% · cumulative +16.3% — conclusive at p = 0.0007
Adaptive 2.710% vs baseline 2.330% reward per impression, over a 5% holdout.

*7 · Anomalies & alerts*
⚠️ *Traffic spike on /t/ambient-computing*
   Pageviews are 4.1 standard deviations above the trailing 4-week profile for this hour-of-week. Source is TikTok; no bot signature detected.
⚠️ *Redpanda consumer lag*
   ClickHouse ingest lag peaked at 4.2s against a 1s target. No events dropped; the buffer absorbed the spike as designed.

*8 · Next hour*
  • Give hero.headline#g7f2 its first 1,000 impressions under novelty down-weighting.
  • Re-test hero.media#canvas on desktop only, where its LCP budget is not the binding constraint.
  • Extend the Discord-first provider ordering to the phone|direct bucket, where the posteriors now overlap.

*Needs you*
  ❓ Two posts are waiting in the approval queue and will expire in 4 hours.

_reward weights v3_

========================================================================
QUIET HOUR — 100 characters
========================================================================

*MORPH* 2026-08-25 04:00–05:00 Europe/Rome · 31 sessions, 0 sign-ups, no adaptations, all green.
```

---

## Interactive commands

| Command                        | Effect                                                    | Admin only |
| ------------------------------ | --------------------------------------------------------- | ---------- |
| `/status`                      | Health, traffic and the live theme right now              |            |
| `/surfaces`                    | Every surface, its champion and its active variants       |            |
| `/queue`                       | Review pending outbound posts, with inline approve/reject |            |
| `/trends`                      | Current trend clusters and their scores                   |            |
| `/report`                      | Send the hourly report now                                |            |
| `/promote <surface> <variant>` | Make a variant the champion                               | yes        |
| `/pin <surface> <variant>`     | Force a variant, suspending learning on that surface      | yes        |
| `/rollback <surface>`          | Revert a surface to its baseline                          | yes        |
| `/pause_adaptation`            | Freeze assignment on current champions                    | yes        |
| `/resume`                      | Resume adaptation                                         | yes        |
| `/autonomy <level>`            | Set the outbound autonomy level                           | yes        |
| `/quiet <hours>`               | Suppress non-critical reports                             | yes        |
| `/kill`                        | Emergency freeze of all autonomous behaviour              | yes        |

The bot answers exactly one chat id, and mutating commands additionally require the
sender to be on the admin list. A message from any other chat is ignored **silently** -
replying "you are not authorised" confirms the bot exists and is live, which is exactly
what someone probing for it wants to learn.
