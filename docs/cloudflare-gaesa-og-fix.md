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

So the cookie has to be either tolerated (Cache Rule) or stripped at the
edge by code we control (Worker).

---

## Fix option A — Cloudflare Cache Rule (recommended, no code)

This tells Cloudflare to cache the meme-image response *despite* the Set-Cookie
header.  Cache **misses** still expose GAESA to the requester (acceptable for
Twitter — its first scrape primes the cache, and on its next refresh the cache
is hot), but every cache **hit** is served straight from the CF edge with no
cookies, no `private` downgrade, and a clean `Cache-Control: public`.

### Steps in the Cloudflare dashboard

1. Log in → select the **overhype.me** zone.
2. **Caching → Cache Rules → Create rule.**
3. Name it: `Cache meme images and OG shells at edge`.
4. Under **When incoming requests match…** choose **Custom filter expression**:

   ```
   (http.request.uri.path matches "^/api/memes/[^/]+/image$") or
   (http.request.uri.path matches "^/api/og/")
   ```

5. Under **Then…** set:
   - **Cache eligibility** → **Eligible for cache** (overrides the
     Set-Cookie bypass — this is the key setting)
   - **Edge TTL** → **Override origin** → **1 day**
   - **Browser TTL** → **Respect origin TTL**
6. Click **Deploy**.

### Prime the cache and verify

Cloudflare's edge cache is per-PoP, so you need to hit each PoP at least once
before Twitter's bot does (or just trigger it from Twitter directly):

```bash
# Force a cache miss + populate (run twice — second one should be HIT)
curl -sI "https://overhype.me/api/memes/087dJrsjRO/image" | grep -E "cf-cache|cache-control|set-cookie"
curl -sI "https://overhype.me/api/memes/087dJrsjRO/image" | grep -E "cf-cache|cache-control|set-cookie"
```

Expected on the second request:
```
cache-control: public, max-age=3600, s-maxage=86400
cf-cache-status: HIT
```
(no `set-cookie` line)

Then re-scrape the affected tweet using the
[Twitter Card Validator](https://cards-dev.twitter.com/validator).

---

## Fix option B — Cloudflare Worker (most robust, requires code edit)

Add this snippet to the existing Worker that already handles bot UA rewriting
for `overhype.me`.  It rebuilds the `Response` object from scratch when the
path matches, which means the GAESA cookie from the origin response is never
forwarded to the client at all — not even on the first hit.

```js
// Inside the Worker's fetch handler, before the existing bot/SPA passthrough:
const url = new URL(request.url);
const STRIP_COOKIE_RE = /^\/api\/(memes\/[^/]+\/image|og\/)/;

if (STRIP_COOKIE_RE.test(url.pathname)) {
  const originResponse = await fetch(request);
  // Cloning into a new Response drops cookies the platform injected at
  // the network layer (e.g. Google App Engine's GAESA).
  const cleaned = new Response(originResponse.body, originResponse);
  cleaned.headers.delete("Set-Cookie");
  cleaned.headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
  return cleaned;
}
```

This is more reliable than Option A because it does not depend on cache state:
the very first request (including Twitter's first-ever scrape of a brand-new
meme URL) is already cookie-free.

---

## Verification (either option)

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
