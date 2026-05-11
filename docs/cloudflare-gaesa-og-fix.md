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

## Fix option A — Cloudflare Transform Rule (recommended)

This strips the GAESA cookie from the meme-image and OG-shell responses
*before* Cloudflare decides whether to cache them, so CF sees a clean
`Cache-Control: public` and caches normally.  Subsequent requests — including
Twitter's bot — get CF-edge-cached responses with no `Set-Cookie` at all.

### Steps in the Cloudflare dashboard

1. Log in → select the **overhype.me** zone.
2. **Rules → Transform Rules → Modify Response Header → Create rule.**
3. Name it: `Strip GAESA from OG image paths`.
4. Under **When incoming requests match…** choose **Custom filter expression**
   and enter:

   ```
   (http.request.uri.path matches "^/api/memes/[^/]+/image$") or
   (http.request.uri.path matches "^/api/og/")
   ```

5. Under **Then… → Response header modifications** add:

   | Action | Header name | Value |
   |--------|-------------|-------|
   | Remove | `Set-Cookie` | *(leave blank)* |

6. Click **Deploy**.

After the rule is live, purge the Cloudflare cache for the affected paths
(Rules → Cache Rules → Purge Everything, or use the API), then re-scrape the
affected tweet using the [Twitter Card Validator](https://cards-dev.twitter.com/validator).

---

## Fix option B — Cloudflare Cache Rule (alternative)

If you prefer to keep GAESA in the response but force Cloudflare to cache the
image anyway (so *hits* are served without `Set-Cookie`), use a Cache Rule
with "Cache Everything" for the image path.  Note: cache *misses* still
expose GAESA to the requester, which is usually fine for Twitter bots because
the first hit primes the cache and subsequent bot re-fetches are hits.

1. **Rules → Cache Rules → Create rule.**
2. Name: `Cache meme images at edge`.
3. **When**: `http.request.uri.path matches "^/api/memes/[^/]+/image$"`
4. **Then**:
   - Cache eligibility: **Eligible for cache**
   - Edge Cache TTL: **1 day** (override origin)
   - Browser Cache TTL: **1 hour** (respect origin)
5. Click **Deploy**.

---

## Fix option C — Cloudflare Worker snippet (most robust)

Add the following snippet to the existing CF Worker that handles bot routing
for `overhype.me`.  It intercepts meme-image requests and strips `Set-Cookie`
from the proxied origin response before forwarding it to Twitter:

```js
// In the existing Worker fetch handler, add before the default passthrough:
const url = new URL(request.url);
const IMAGE_RE = /^\/api\/memes\/[^/]+\/image$/;

if (IMAGE_RE.test(url.pathname)) {
  const originResponse = await fetch(request);
  const cleaned = new Response(originResponse.body, originResponse);
  cleaned.headers.delete("Set-Cookie");
  cleaned.headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  return cleaned;
}
```

This is the most robust option because the Worker rebuilds the `Response`
object from scratch — cookies in the origin response are never forwarded to
the client at all, regardless of what Google's infrastructure adds.

---

## Verification

After any of the above changes:

```bash
# Should show cf-cache-status: HIT and no set-cookie header:
curl -sI "https://overhype.me/api/memes/087dJrsjRO/image" | grep -E "set-cookie|cache-control|cf-cache"

# Re-scrape the OG card:
# https://cards-dev.twitter.com/validator
# Paste: https://overhype.me/m/087dJrsjRO
```

Expected result after fix:

```
cache-control: public, max-age=3600, s-maxage=86400
cf-cache-status: HIT
```
(No `set-cookie` line.)

---

## Why no app-level code change fixes this

| Approach | Why it fails |
|---|---|
| `res.clearCookie("GAESA")` / `res.removeHeader("Set-Cookie")` | GAESA is injected by GCP's load balancer *after* Express sends its response bytes.  Express cannot see or modify headers added at the network layer. |
| Express middleware to strip cookies for public routes | Same reason — the middleware runs before the response leaves Express, but GCP adds GAESA after. |
| `Cache-Control: no-transform` | Tells intermediaries not to modify body encoding, not headers.  Does not prevent CF from honouring Set-Cookie. |
| Serve image from a different Express route | Every route on `overhype.me` goes through the same GCP infrastructure — all responses get GAESA. |
