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
pnpm exec wrangler d1 create morph
```

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
