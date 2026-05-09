/**
 * overhype-og-router — Cloudflare Worker on overhype.me/m/*.
 *
 * For known crawler user agents we serve the crawler-targeted OG shell from
 * `/api/og/m/:slug`. For everything else we pass the request through
 * unchanged so the static SPA artifact responds with index.html and the
 * client-side router handles the route.
 *
 * `isbot` is bundled into the worker. UA detection should not be hand-rolled
 * — the social-crawler list shifts frequently and the package is actively
 * maintained.
 */
import { isbot } from "isbot";

interface Env {}

const SLUG_RE = /^\/m\/([A-Za-z0-9_-]+)\/?$/;

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return fetch(request);
    }

    const url = new URL(request.url);
    const match = url.pathname.match(SLUG_RE);
    if (!match) return fetch(request);

    const ua = request.headers.get("user-agent") ?? "";
    if (!isbot(ua)) return fetch(request);

    // Bot path — rewrite to the OG endpoint on the same origin. Replit's
    // router maps /api/* to the api-server, which serves the OG HTML.
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

    // Return the OG response verbatim. Cache-Control set by the api-server
    // governs Cloudflare's edge cache.
    return new Response(ogResp.body, {
      status: ogResp.status,
      statusText: ogResp.statusText,
      headers: ogResp.headers,
    });
  },
};
