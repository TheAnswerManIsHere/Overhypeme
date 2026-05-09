# Phase 5 — Deployment instructions (Replit)

This file is the operational checklist for landing Phase 5 in production.
It is owned by Replit AI; the user does not need to run any of these
commands.

Phase 5 ships three things that need to be deployed in order:

1. **The api-server** — already deployed via the standard Replit pipeline;
   the new `/api/og/m/:slug` endpoint comes along for free.
2. **The static SPA artifact** — also standard pipeline; the new `/m/:slug`
   route is pure client code.
3. **The Cloudflare Worker** at `cloudflare/og-router/` — **NEW deploy
   step**; this is the only piece that does not auto-deploy when the
   branch lands. Until the worker is deployed, social shares of `/m/:slug`
   URLs will hit the static SPA shell and render as broken cards.

Order matters: deploy the api-server first (so `/api/og/m/:slug` is live),
then the worker (so it has somewhere to fetch from).

---

## TL;DR

```bash
# 1. Branch is already merged / deployed via the normal Replit pipeline.
#    Confirm /api/og/m/:slug is reachable at the production origin.
curl -sI https://overhype.me/api/og/m/{any-real-slug} | head -3
# Expect HTTP/2 200 with content-type: text/html.

# 2. Set the Cloudflare deploy token (one-time per shell).
export CLOUDFLARE_API_TOKEN="<token from Replit Secrets: CLOUDFLARE_API_TOKEN>"

# 3. Deploy the worker.
pnpm install                  # picks up cloudflare/og-router/package.json
pnpm worker:deploy            # → wrangler deploy

# 4. Verify with the smoke script.
SLUG=<a-real-live-slug> BASE_URL=https://overhype.me \
  bash scripts/phase5-og-smoke.sh
```

If all four steps green, Phase 5 is deployed.

---

## What changed in the api-server build

Nothing structural. New files:

- `artifacts/api-server/src/routes/og.ts` — handler for `/api/og/m/:slug`.
- Mounted in `artifacts/api-server/src/routes/index.ts` between
  `memesRouter` and `renderRouter`.

Verification after the api-server pipeline runs:

```bash
curl -sI https://overhype.me/api/og/m/__nonexistent__
# Expect: HTTP/2 404, content-type: text/html, cache-control: public, max-age=3600

curl -s  https://overhype.me/api/og/m/__nonexistent__ | grep -E 'og:type|twitter:card'
# Expect: og:type and twitter:card meta tags present (generic 404 card)
```

If the 404 returns JSON instead of HTML, the static-artifact route is
intercepting before the api-server. Re-check the Replit `[[services]]`
ordering in `.replit` — `paths = ["/api"]` must win over `paths = ["/"]`
for `/api/*`.

---

## What changed in the static SPA artifact

Only client-side route renames: `/meme/:slug` is gone, `/m/:slug` is the
canonical path. There are no static-artifact rewrite changes; the existing
`from = "/*", to = "/index.html"` rule already covers `/m/:slug` for human
visitors.

There is **no deep-link migration** — the project hasn't shipped publicly
yet, so no live URLs need redirects. If/when that changes, add a redirect
rule (Cloudflare Page Rule, or in `artifact.toml`) `from = "/meme/*", to =
"/m/:splat"` so old shares 301 to the new path.

---

## Cloudflare Worker deploy — long form

### Token storage

The deploy needs a Cloudflare API token with the **"Edit Cloudflare
Workers"** scope on this account + zone. The token is stored as
`CLOUDFLARE_API_TOKEN` in Replit Secrets.

If you don't have access to the secret, ask the user to paste it; do
**not** put it in source control.

### Account and zone IDs

These are not secrets. They live in `cloudflare/og-router/wrangler.toml`:

```
account_id = "975a348dc75f2f3849507caefab3862e"
routes = [
  { pattern = "overhype.me/m/*", zone_id = "759edc0f6744c981b16d648f1a9ffa12" },
]
```

If either ID changes (account migration, zone rebuild), edit
`wrangler.toml` and re-deploy.

### Deploy command

From the repo root:

```bash
pnpm install                # idempotent — installs wrangler + isbot if missing
pnpm worker:deploy          # → wrangler deploy in cloudflare/og-router/
```

Expected output ends with something like:

```
Total Upload: ~25 KiB / gzip: ~10 KiB
Worker Startup Time: <X> ms
Uploaded overhype-og-router (X.XX sec)
Deployed overhype-og-router triggers (X.XX sec)
  overhype.me/m/*
Current Version ID: <uuid>
```

If the route line is missing, the worker uploaded but the route didn't
bind — most commonly because:

- The `overhype.me` zone is not on the same account as the API token.
- The DNS records for `overhype.me` are not proxied (orange-cloud) — the
  worker only runs on proxied requests.

Fix DNS first, then re-run `pnpm worker:deploy`. Wrangler is idempotent.

### Verifying the worker is live

```bash
curl -sI -A "Twitterbot/1.0" https://overhype.me/m/<slug>
# Expect: HTTP/2 200, content-type: text/html, cache-control: public, max-age=3600
# AND: cf-worker (or similar) header indicating the worker handled the request.

curl -sI https://overhype.me/m/<slug>
# Plain (human) UA — expect: HTTP/2 200, content-type: text/html (the SPA
# index.html), NO og:image in body.
```

A more thorough sweep is in `scripts/phase5-og-smoke.sh`:

```bash
SLUG=<slug> BASE_URL=https://overhype.me bash scripts/phase5-og-smoke.sh
```

### Cache pre-warming (optional)

The OG endpoint sets `Cache-Control: public, max-age=3600, s-maxage=3600`,
so Cloudflare will cache responses at the edge after the first crawler
hit. There is no need to pre-warm.

If a meme is updated and the cached card is stale, do one of:

1. Wait up to 1 hour for the TTL to expire (default).
2. Purge the cached URL in the Cloudflare dashboard (Caching → Configuration
   → Purge Cache → Custom Purge → enter `https://overhype.me/api/og/m/{slug}`).

---

## Rollback

If the worker breaks crawler routing in prod:

1. **Disable the route** without deleting the worker:
   ```bash
   cd cloudflare/og-router
   pnpm exec wrangler triggers delete
   ```
   Crawlers immediately fall back to the static SPA (broken cards, but
   non-crawler traffic is unaffected).

2. **Or roll back to a prior version**:
   ```bash
   pnpm exec wrangler rollback
   ```
   Picks the previous deploy from Cloudflare's version history.

The api-server's `/api/og/m/:slug` endpoint is independent — leaving it
running is safe even with the worker disabled (it just won't be reached
by crawlers).

---

## Post-deploy paste tests (manual)

These are the only checks that prove the OG cards actually render in
production composers. Use a real, live meme permalink for each:

| Surface | What to check |
|---|---|
| Twitter / X composer | Paste `https://overhype.me/m/<slug>`. Card renders with the meme image (1080×1080), creator name + fact text in the title row, and `overhype.me` as the source. |
| Discord channel | Paste the same URL. Embed renders with image preview and title; clicking opens the SPA. |
| Slack channel | Paste in any channel. Slack-ImgProxy fetches the OG image; preview shows full card. |
| iMessage | Send to yourself. Bubble-link preview shows the meme image (iMessage uses the facebookexternalhit UA family). |
| Facebook composer | Paste in a status. Card unfurls to a large image preview. |
| LinkedIn share dialog | Paste in a post. Card renders with image. |

Document anything that doesn't render correctly with a screenshot back
to the user.

---

## Pre-existing concerns (not introduced by Phase 5)

The api-server typecheck reports `error TS2304: Cannot find name
'generatedObjectPath'` at `src/routes/memes.ts:1631`. This was on the
branch before Phase 5 landed (verified by stashing Phase 5 edits to
`memes.ts` and re-running tsc). It does not block deployment because
esbuild bundles the file regardless; it is a tsc-only failure. File a
separate ticket to fix the unbound reference.

---

## Reporting failures

If any deploy step fails, capture:

1. The exact command and its full output (token redacted).
2. `wrangler --version` and `node --version`.
3. The Cloudflare dashboard URL for the worker
   (`https://dash.cloudflare.com/<account_id>/workers/services/view/overhype-og-router/production`).
4. Whether the api-server `/api/og/m/:slug` returns 200 or 404 for a known
   live slug.

Phase 5 branch: `claude/setup-overhype-project-g8QzX`.
