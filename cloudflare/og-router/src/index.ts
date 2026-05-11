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

/**
 * Fetch the origin response and return a clone that has all `Set-Cookie`
 * headers removed and a long-lived public Cache-Control.  Use for endpoints
 * that are safe to share across all users (meme images, OG shells) and that
 * would otherwise be poisoned by GCP's GAESA cookie.
 */
async function fetchAndStripCookies(request: Request): Promise<Response> {
  const originResponse = await fetch(request);
  const cleaned = new Response(originResponse.body, originResponse);
  cleaned.headers.delete("Set-Cookie");
  // Override whatever Cache-Control the origin sent — without the cookie,
  // CF will now honour this and edge-cache the response.
  cleaned.headers.set(
    "Cache-Control",
    "public, max-age=3600, s-maxage=86400"
  );
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
