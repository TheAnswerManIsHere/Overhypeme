# Twitter/X OG Card Broken Image — Root Cause & Cloudflare Fix

## Root cause

Every HTTP response that leaves Replit's production infrastructure (hosted on
Google Cloud / Google App Engine) arrives at Cloudflare with an extra header
injected by Google's load balancer:

```
Set-Cookie: GAESA=<base64-blob>; path=/
via: 1.1 google
```

This applies to **every** response — API routes, static assets, OG shells,
meme images, everything.  There is no app-level code change that can suppress
it; the header is added after Express finishes writing its response, at the
network infrastructure layer.

Cloudflare's default cache policy treats any response that contains a
`Set-Cookie` header as user-specific and therefore uncacheable.  It overrides
our `Cache-Control: public, max-age=3600, s-maxage=86400` with
`Cache-Control: private` and sets `cf-cache-status: DYNAMIC` (not cached).

Twitter/X's card crawler refuses to render a large image card for any
`og:image` URL that responds with `Set-Cookie` or `Cache-Control: private`.
The result: every share shows a small link card instead of the large meme image.

---

## ⚠️ Why a Transform Rule does NOT work

Cloudflare's "Modify Response Header" Transform Rules explicitly **disallow**
modifying `Set-Cookie` (along with `Server`, `Date`, and a few other
security-sensitive headers).  If you try, the dashboard rejects the rule with:

> 'remove' is not a valid value for operation because it cannot be used on
> header 'Set-Cookie'

The cookie therefore has to be stripped at the edge by code we control —
the existing CF Worker for this site.

---

## Fix — Cloudflare Worker (already implemented)

The existing Worker at [`cloudflare/og-router/`](../cloudflare/og-router) was
extended to also intercept `/api/memes/*/image` and `/api/og/*`.  It fetches
the origin response and rebuilds the `Response` object with `Set-Cookie`
removed and a clean `Cache-Control: public, max-age=3600, s-maxage=86400`,
which lets Cloudflare edge-cache the response normally.

The relevant bits in `cloudflare/og-router/src/index.ts`:

```ts
const STRIP_COOKIE_RE = /^\/api\/(memes\/[^/]+\/image|og(\/|$))/;

async function fetchAndStripCookies(request: Request): Promise<Response> {
  const originResponse = await fetch(request);
  const cleaned = new Response(originResponse.body, originResponse);
  cleaned.headers.delete("Set-Cookie");
  cleaned.headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return cleaned;
}

// inside fetch():
if (STRIP_COOKIE_RE.test(url.pathname)) {
  return fetchAndStripCookies(request);
}
```

And the new route patterns in `wrangler.toml`:

```toml
routes = [
  { pattern = "overhype.me/m/*",         zone_id = "..." },
  { pattern = "overhype.me/api/memes/*", zone_id = "..." },
  { pattern = "overhype.me/api/og/*",    zone_id = "..." },
]
```

### Deploy

```bash
pnpm worker:deploy
```

(Requires `CLOUDFLARE_API_TOKEN` with the "Edit Cloudflare Workers" scope —
the same token the existing deploy flow uses.)

---

## Verification

```bash
curl -sI "https://overhype.me/api/memes/087dJrsjRO/image" | \
  grep -E "set-cookie|cache-control|cf-cache"
```

Should show:
```
cache-control: public, max-age=3600, s-maxage=86400
cf-cache-status: HIT
```
**No `set-cookie` line.**

Then validate the card:
- Twitter: <https://cards-dev.twitter.com/validator>
- Facebook: <https://developers.facebook.com/tools/debug/>

---

## Why no app-level code change fixes this

| Approach | Why it fails |
|---|---|
| `res.clearCookie("GAESA")` / `res.removeHeader("Set-Cookie")` | GAESA is injected by GCP's load balancer *after* Express sends its response bytes.  Express cannot see or modify headers added at the network layer. |
| Express middleware to strip cookies for public routes | Same reason — the middleware runs before the response leaves Express, but GCP adds GAESA after. |
| `Cache-Control: no-transform` | Tells intermediaries not to modify body encoding, not headers.  Does not prevent CF from honouring Set-Cookie. |
| Serving the image from a different Express route | Every route on `overhype.me` goes through the same GCP infrastructure — all responses get GAESA. |
| Cloudflare Transform Rule "Remove Set-Cookie" | **Blocked by Cloudflare** — `Set-Cookie` is on the disallowed-headers list for Modify Response Header rules. |
