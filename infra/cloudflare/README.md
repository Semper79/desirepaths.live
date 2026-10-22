# Cloudflare setup

Everything here is done once, by the operator, against an account that does not exist yet.
The order matters: each step prints an id that a later step pastes into a config file.

D31, D32 and D33 in `docs/DECISIONS.md` explain why the architecture is what it is. This
file is only the mechanics.

---

## 0. Before anything

```bash
pnpm install
pnpm exec wrangler login
```

`wrangler login` opens a browser and writes a token to your machine. It does **not** need
a paid plan — the free tier is a real launch configuration (see "What this costs" below).

---

## 1. The database

```bash
pnpm exec wrangler d1 create morph --jurisdiction eu
```

**`--jurisdiction eu` is not optional and not changeable later.** It restricts where the
data is stored _and_ where queries run, and there is no command that moves an existing
database into a jurisdiction — the only way to change it is to create a new database and
migrate. Right now that costs nothing because there is no content; after launch it is a
migration with a downtime window. `docs/PRIVACY.md` §0 explains why this matters more on
Cloudflare than it did on a single server in Falkenstein.

Do not reach for `--location weur` instead: that is a hint about the primary replica, it
is ignored when a jurisdiction is set, and a hint is not a guarantee.

It prints a `database_id`. Paste it into `apps/web/wrangler.jsonc`, replacing
`REPLACE_ME__D1_DATABASE_ID`.

Then apply the schema:

```bash
cd apps/web
pnpm exec wrangler d1 migrations apply morph --remote
```

`--remote` is the real database. Without it you get the local one, which is what
`pnpm dev` uses and what a build on your laptop reads.

**The local one has to exist too**, or `next build` fails while collecting page data —
`db.ts` deliberately refuses to fall back to seed content when a binding is present but
broken, because a site quietly serving fixtures looks healthy and gets indexed:

```bash
pnpm exec wrangler d1 migrations apply morph --local
```

---

## 1b. Seed it, or nothing adapts

```bash
cd apps/web
pnpm exec wrangler d1 execute morph --local  --file=../../infra/d1/seed.sql
pnpm exec wrangler d1 execute morph --remote --file=../../infra/d1/seed.sql
```

49 variants from the surface registry, the hand-written articles, and the engine
configuration. **Without this the site looks new rather than broken**, which is the reason
it has its own step: `activeVariants()` returns nothing, the adapt cycle reports
`no_variants`, no snapshot is ever published, and every surface resolves to its baseline
for ever. The thinking bar says "cold start" — exactly what a genuinely new site says — so
the gap is invisible until somebody wonders why nothing has changed in a fortnight.

Every statement is `INSERT OR IGNORE`, so re-applying is harmless and applying to a
partially seeded database fills only the gaps. It is deliberately **not** part of the
deploy: a deploy that re-seeded would overwrite your edits to the variant pool.

`infra/d1/seed.sql` is committed and generated — `pnpm seed:generate` rebuilds it after a
change to the registry, and a test fails if the two drift.

---

## 2. The two KV namespaces

```bash
pnpm exec wrangler kv namespace create ASSIGNMENTS
pnpm exec wrangler kv namespace create SNAPSHOT
```

Each prints an `id`. Paste them into `apps/web/wrangler.jsonc` over
`REPLACE_ME__KV_ASSIGNMENTS_ID` and `REPLACE_ME__KV_SNAPSHOT_ID`.

They are separate namespaces because they have nothing in common operationally.
`SNAPSHOT` is a single hot key, rewritten hourly, read by every render, and must never be
purged. `ASSIGNMENTS` is millions of cold keys that expire on their own after thirty days.

---

## 3. The event dataset

Nothing to create. Analytics Engine datasets come into existence on first write, so the
`analytics_engine_datasets` block in `wrangler.jsonc` is the whole configuration.

Reading them back needs an API token — see step 6.

---

## 4. The secret

```bash
cd apps/web
pnpm exec wrangler secret put ANON_ID_PEPPER
```

Paste the output of:

```bash
openssl rand -hex 32
```

This is the input to the visitor hash. It is deliberately absent from `wrangler.jsonc`: a
pepper in version control is not a pepper. Losing it is survivable — every visitor becomes
a new visitor, once — so it is better rotated than recovered.

---

## 4b. The data controller — the one step that blocks launch

Three facts, and only you have them:

| Variable                     | What it is                                                    |
| ---------------------------- | ------------------------------------------------------------- |
| `MORPH_CONTROLLER_NAME`      | The legal entity, or your own name if there is no company     |
| `MORPH_CONTROLLER_ADDRESS`   | Registered office, or your residence as a sole trader         |
| `MORPH_CONTROLLER_EMAIL`     | Where erasure and access requests arrive                      |
| `MORPH_CONTROLLER_DPO_EMAIL` | Only if an Art. 37 data protection officer has been appointed |

Put them in the `vars` block of both `wrangler.jsonc` files, or — if you would rather a
residential address not sit in the repository — set them per Worker:

```bash
pnpm exec wrangler secret put MORPH_CONTROLLER_NAME
```

**Until all three are set, nothing measures anybody.** That is enforced rather than
documented: the collector answers 503 to every beacon, `/ready` refuses the deployment and
names the missing variables, and `/privacy` tells the visitor that nothing is being
recorded. All three statements are true in that state, which is why it is safe to deploy
the renderer before you have decided this — see "Publishing in two steps" below.

---

## 5. The domain

In the Cloudflare dashboard, add `desirepath.live` as a zone and point the registrar's
nameservers at the two Cloudflare gives you. Then, in the Worker's settings, add a custom
domain for `desirepath.live`.

TLS is automatic and there is no certificate to manage.

**`MORPH_INDEXABLE` stays `"0"` until you mean it.** Turning it on is the deliberate act of
letting search engines index the site; an indexed staging deployment outranks the real
thing for its own brand name and takes months to unwind.

---

## 6. CI

The deploy job in `.github/workflows/ci.yml` needs two repository secrets:

| Secret                  | Where it comes from                                               |
| ----------------------- | ----------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard sidebar, or `pnpm exec wrangler whoami`                 |
| `CLOUDFLARE_API_TOKEN`  | My Profile → API Tokens → Create Token, "Edit Cloudflare Workers" |

The token also needs **Account → Account Analytics → Read** if Grafana is going to query
the Analytics Engine SQL API with it.

---

## Publishing in two steps

The controller decision blocks measuring people, not serving pages. So it does not have to
block a first deployment:

**Step one, now.** Deploy the renderer only, to the `staging` environment, with
`MORPH_INDEXABLE=0` and the collector not deployed. No visitor is measured, so Art. 13
does not engage, so D4 does not block it. What this proves is the part that cannot be
proved from a laptop: that OpenNext's output actually runs on Workers, that D1 answers, and
that the pages are the right pages.

```bash
cd apps/web
pnpm exec wrangler d1 migrations apply morph --local
pnpm exec wrangler d1 execute morph --local --file=../../infra/d1/seed.sql
pnpm exec opennextjs-cloudflare build
pnpm exec opennextjs-cloudflare deploy --env staging
```

`build` and `deploy` are separate commands — `deploy` publishes an app that is already
built and will not build one. And the build needs the _local_ database, because
`next build` queries D1 while deciding which article slugs to prerender; the deployed
Worker reads the remote one at request time.

**Step two, once the controller is decided.** Deploy the collector, set the three
variables, and flip `MORPH_INDEXABLE` to `"1"` on production when you actually want search
engines to find it.

---

## Building locally on Windows

`opennextjs-cloudflare build` fails on Windows with
`EPERM: operation not permitted, symlink`. This is not a project problem: Next's
`standalone` output symlinks the dependency tree, and Windows refuses that without
elevation.

Three ways out, best first:

1. **Let CI build it.** This is the normal path and needs nothing from you.
2. **Turn on Developer Mode** — Settings → Privacy & security → For developers → Developer
   Mode. It permits unprivileged symlink creation and fixes this permanently.
3. **Build in WSL**, which is what OpenNext itself recommends.

Everything else works on Windows: `pnpm dev`, the whole test suite, `wrangler d1`, and
`next build` up to the standalone step.

---

## What this costs

The **Workers free plan** allows 100,000 requests a day. That is a real launch
configuration and it is where to start.

The design target in `CLAUDE.md` is 5M events a day, which is fifty times that. **Workers
Paid** is $5/month and includes 10M requests; at the design target the bill is tens of
dollars a month, not thousands. The honest summary: cheaper than a VPS until roughly 1M
events a day, more expensive after.

Free-plan limits worth knowing before you hit them:

| Resource                    | Free     | Paid                    |
| --------------------------- | -------- | ----------------------- |
| Worker requests             | 100k/day | 10M/month, then $0.30/M |
| D1 database size            | 500 MB   | 10 GB                   |
| D1 queries per invocation   | 50       | 1,000                   |
| Durable Object rows written | 100k/day | 50M/month included      |
| Analytics Engine retention  | 3 months | 3 months                |

Analytics Engine keeps data for three months and then **deletes** it rather than rolling it
up. The D1 rollups (D33) are what make the other twenty-two months of `adaptation_log`
meaningful, and a gap in that cron is unrecoverable because the source is gone.
