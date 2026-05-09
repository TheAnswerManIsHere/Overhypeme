# overhype-og-router

Cloudflare Worker bound to `overhype.me/m/*`. Routes known social crawlers to
the api-server's `/api/og/m/:slug` endpoint; passes humans through to the
static SPA.

## Deploy

```bash
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
