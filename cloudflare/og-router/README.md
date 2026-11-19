# overhype-og-router

Cloudflare Worker bound to `overhype.me/m/*`. Routes known social crawlers to
the api-server's `/api/og/m/:slug` endpoint; passes humans through to the
static SPA.

## Deploy

**Deploy the main app FIRST and confirm it's live before deploying this
Worker.** This Worker versions its cache-busting query param
(`MEME_IMAGE_EDGE_CACHE_VERSION` in `src/index.ts`) to match the origin's
`MEME_RENDER_VERSION` (`artifacts/api-server/src/routes/memes.ts`). If this
Worker deploys first, the first request at each edge PoP after deploy uses
the new cache key but can still hit an origin running the OLD version — the
edge then caches those old bytes under the new key for a full `s-maxage`,
silently defeating the version bump for another 24h.

```bash
# 1. Confirm the origin is already serving the version this Worker expects.
#    The bare URL goes THROUGH Cloudflare's edge — if this exact URL was
#    fetched in the last 24h it can still be cache-served without ever
#    reaching origin, showing you a stale ETag even after the origin has
#    already deployed. Append a throwaway query param so this specific
#    request is guaranteed to be a fresh cache key and actually hit origin:
curl -sI "https://overhype.me/api/memes/<any-live-slug>/image?verify=$(date +%s)" | grep -i etag
#    → must read meme-v<N>-... where N matches MEME_IMAGE_EDGE_CACHE_VERSION
#      in src/index.ts. If it doesn't match yet, wait for the app deploy to
#      finish (or roll back this Worker's version bump) before continuing.

# 2. Deploy this Worker:
export CLOUDFLARE_API_TOKEN=…  # token with "Edit Cloudflare Workers" scope
pnpm install                   # workspace install picks this up via pnpm-workspace.yaml
pnpm --filter @workspace/og-router run deploy
```

The `account_id` and `zone_id` are wired in `wrangler.toml`.

## How crawlers reach the OG HTML

```
Twitterbot →  GET overhype.me/m/abc
              │
              ▼
  Cloudflare Worker (this)
              │  isbot(ua) === true
              ▼
  fetch(overhype.me/api/og/m/abc) → api-server returns OG shell
```

Humans:

```
Chrome →  GET overhype.me/m/abc
          │
          ▼
  Cloudflare Worker (this)
          │  isbot(ua) === false
          ▼
  fetch(passthrough) → static SPA `index.html` → client-side route
```

## Local test

```bash
pnpm --filter @workspace/og-router run dev
# in another shell:
curl -A "Twitterbot/1.0" http://localhost:8787/m/somesample
curl -A "Mozilla/5.0 (Macintosh)" http://localhost:8787/m/somesample
```

## The daily maintenance call

The Worker's `scheduled` handler (`src/maintenance.ts`) POSTs
`https://overhypeme.replit.app/api/jobs/maintenance` (Replit's own address,
so Cloudflare's country rule and its ~100-second origin wait do not apply)
once a day at 09:23 UTC with the
app's `CRON_SECRET` in `x-cron-secret`. The app scales to zero when idle and
its cleanup timers live inside that process, so this call is what runs the
retention jobs on a quiet day (launch Phase 14, plan S-i).

- **The secret** is a Worker secret named `CRON_SECRET`, equal to the app's.
  Set it in the dashboard before deploying; `[secrets] required` makes
  `wrangler deploy` refuse without it, and a deploy never removes it.
- **A failed day is a failed invocation**: the handler throws on a redirect,
  a refused secret, a run with any failed job, or an answer it does not
  recognise, and retries once only on a cold start (502/503/504 or no
  connection). Read it under the Worker's Logs and Cron Events.
- **Tests**: `pnpm --filter @workspace/og-router test` (run in CI's Build job).
