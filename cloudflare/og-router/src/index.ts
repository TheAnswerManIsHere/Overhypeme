/**
 * overhype-og-router — Cloudflare Worker on overhype.me.
 *
 * Two responsibilities:
 *
 *   1. /m/:slug — bot-vs-human routing.  For known crawler user agents we
 *      serve the crawler-targeted OG shell from `/api/og/m/:slug`.  For
 *      everything else we pass through to the static SPA artifact and let
 *      the client-side router handle the route.
 *
 *      `isbot` is bundled into the worker. UA detection should not be
 *      hand-rolled — the social-crawler list shifts frequently and the
 *      package is actively maintained.
 *
 *   2. /api/memes/:slug/image and /api/og/* — strip the `Set-Cookie:
 *      GAESA=...` header that Google App Engine's load balancer injects
 *      into every response leaving the Replit production environment.
 *      Cloudflare treats any response with `Set-Cookie` as user-specific
 *      and downgrades `Cache-Control: public` to `private`, which causes
 *      Twitter/X to refuse to render the meme image as a large card.
 *      Rebuilding the Response object here drops the platform-injected
 *      cookie before it ever leaves the edge.
 */
import { isbot } from "isbot";

interface Env {}

const SLUG_RE = /^\/m\/([A-Za-z0-9_-]+)\/?$/;
const STRIP_COOKIE_RE = /^\/api\/(memes\/[^/]+\/image|og(\/|$))/;
const MEME_IMAGE_PATH_RE = /^\/api\/memes\/[^/]+\/image$/;

/**
 * Bump alongside `MEME_RENDER_VERSION` (artifacts/api-server/src/routes/
 * memes.ts) whenever a change to the meme render pipeline changes what
 * `generateMemeBuffer` draws for the same stored inputs.
 *
 * `MEME_RENDER_VERSION` only changes the origin's ETag — useless against a
 * shared/edge cache entry that's still within its `s-maxage`, since an edge
 * PoP serving a fresh cached response never re-contacts origin to learn a new
 * ETag. Appending this version to the ORIGIN subrequest URL below (query
 * strings are part of Cloudflare's default cache key) gives a render-pipeline
 * change a genuinely fresh cache key, so a previously-cached meme image can
 * never be served stale post-deploy. Scoped to the origin subrequest only —
 * the PUBLIC url (the stored `meme.imageUrl`, and every consumer of it: the
 * JSON API, `<img>`/`<video>` tags, Zazzle export, OG cards) is untouched.
 *
 * This Worker deploys independently of the main app (`pnpm worker:deploy` —
 * see wrangler.toml) — bumping this constant does nothing until that deploy
 * actually runs.
 *
 * DEPLOY ORDER MATTERS: deploy the origin (the app carrying the matching
 * `MEME_RENDER_VERSION`) FIRST and confirm it's live — `curl -I` any meme
 * image URL and check the ETag reads `meme-v<N>-...` — THEN run
 * `pnpm worker:deploy`. Reversing the order caches the WRONG bytes under the
 * new key: the first request at each edge PoP after the Worker deploy uses
 * the fresh `rv` query param, but if the origin is still on the old version
 * it serves old bytes, and the edge then pins those old bytes under the new
 * key for a full `s-maxage` — silently defeating the whole point of bumping
 * this version, for another 24h.
 */
const MEME_IMAGE_EDGE_CACHE_VERSION = 4;

/**
 * Fetch the origin response and return a clone that has all `Set-Cookie`
 * headers removed and a long-lived public Cache-Control.  Use for endpoints
 * that are safe to share across all users (meme images, OG shells) and that
 * would otherwise be poisoned by GCP's GAESA cookie.
 */
async function fetchAndStripCookies(request: Request): Promise<Response> {
  let originRequest: Request = request;
  const url = new URL(request.url);
  if (MEME_IMAGE_PATH_RE.test(url.pathname)) {
    url.searchParams.set("rv", String(MEME_IMAGE_EDGE_CACHE_VERSION));
    originRequest = new Request(url.toString(), request);
  }
  const originResponse = await fetch(originRequest);
  const cleaned = new Response(originResponse.body, originResponse);
  cleaned.headers.delete("Set-Cookie");

  // Force long-lived public edge caching ONLY for genuinely public responses.
  // Private (owner-only) meme images and OG shells now return no-store (or a
  // 404) and the origin marks them so — overriding those would cache a private
  // artifact at the edge. Leave the origin's Cache-Control intact for any
  // non-200 or private/no-store response; only a public 200 gets the override
  // (so GCP's GAESA cookie can't suppress edge caching).
  const originCC = (originResponse.headers.get("Cache-Control") ?? "").toLowerCase();
  const isPrivate = originCC.includes("no-store") || originCC.includes("private");
  if (originResponse.status === 200 && !isPrivate) {
    cleaned.headers.set("Cache-Control", "public, max-age=3600, s-maxage=86400");
  }
  return cleaned;
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fetch(request);
    }

    const url = new URL(request.url);

    // ── Cookie-strip path: meme images and OG shells ────────────────────
    if (STRIP_COOKIE_RE.test(url.pathname)) {
      return fetchAndStripCookies(request);
    }

    // ── Bot-vs-human routing for /m/:slug ───────────────────────────────
    const match = url.pathname.match(SLUG_RE);
    if (!match) return fetch(request);

    const ua = request.headers.get("user-agent") ?? "";
    if (!isbot(ua)) return fetch(request);

    // Bot path — rewrite to the OG endpoint on the same origin. Replit's
    // router maps /api/* to the api-server, which serves the OG HTML.
    // The /api/og/* route above will catch the sub-fetch, so the OG shell
    // returned to the bot is also cookie-free and edge-cacheable.
    const slug = match[1];
    const ogUrl = new URL(`/api/og/m/${slug}`, url.origin);

    // Forward the original headers so the api-server still has access to
    // `accept-language`, `cf-connecting-ip`, etc., for logging and
    // localization.
    const ogResp = await fetch(ogUrl.toString(), {
      method: "GET",
      headers: request.headers,
      redirect: "follow",
    });

    // Strip GAESA from the OG shell as well — same reason as above.
    const cleaned = new Response(ogResp.body, {
      status: ogResp.status,
      statusText: ogResp.statusText,
      headers: ogResp.headers,
    });
    cleaned.headers.delete("Set-Cookie");
    return cleaned;
  },
};
