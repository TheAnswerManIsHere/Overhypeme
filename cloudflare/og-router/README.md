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
# 1. Confirm the origin is already serving the version this Worker expects:
curl -sI https://overhype.me/api/memes/<any-live-slug>/image | grep -i etag
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
