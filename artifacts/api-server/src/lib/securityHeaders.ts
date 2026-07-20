/**
 * Application security headers (finding C5).
 *
 * This is an API-only server: it serves `/api/*` JSON, the crawler-facing OG
 * HTML shells (`/api/og/*`), and public image bytes (`/api/memes/:slug/image`,
 * templates). The React SPA is served by a SEPARATE static origin (Replit's
 * application router / the Vite dev server), same-origin via path routing — so
 * a Content-Security-Policy set here governs only this server's responses and
 * can NOT break the SPA's own inline scripts/styles. That makes an aggressive
 * baseline safe here; the SPA's document CSP is a separate concern.
 *
 * Design decisions (each is a deliberate divergence from helmet's defaults):
 *
 *  - **CSP is Report-Only first.** We emit `Content-Security-Policy-Report-Only`
 *    so a mis-scoped directive surfaces as a browser-console violation during
 *    UAT instead of breaking a response. Flip to enforcing (rename the header)
 *    once UAT confirms zero violations. Route-class aware: strict
 *    `default-src 'none'` for JSON; the OG shell additionally allows images.
 *  - **Frame policy is env-aware.** In production nothing frames the app, so
 *    `X-Frame-Options: DENY` + `frame-ancestors 'none'`. In Replit dev the app
 *    (SPA *and* API) runs inside the Replit "webview" iframe, so we OMIT the
 *    frame headers when `REPLIT_DEV_DOMAIN` is set — a blanket DENY would break
 *    the preview.
 *  - **HSTS is production-only** (dev/preview may be plain HTTP), with a
 *    conservative max-age and NO `includeSubDomains`/`preload` yet — those are a
 *    deliberate follow-up once every *.overhype.me subdomain is confirmed HTTPS.
 *  - **CORP is `cross-origin` on public assets.** The meme-image / OG / template
 *    endpoints already advertise `Access-Control-Allow-Origin: *` for hotlinking
 *    and social unfurls; helmet's default `same-origin` would contradict that.
 *    Everything else keeps `same-origin` (private object routes must not become
 *    cross-origin embeddable).
 *  - **COOP is disabled.** OAuth popup flows post back to a same-origin callback;
 *    a `Cross-Origin-Opener-Policy` could sever `window.opener` and is low value
 *    on a JSON/redirect surface. COEP stays off (helmet default) — requiring it
 *    would break cross-origin embeds.
 */
import helmet from "helmet";
import type { Request, RequestHandler } from "express";

/** Canonical production predicate — mirrors lib/siteUrl.ts. */
function isProductionEnv(): boolean {
  return process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
}

// Public, cross-origin-embeddable asset paths (crawler images + OG shells +
// template images). Kept in sync with app.ts's PUBLIC_ASSET_PATH_PATTERNS.
const PUBLIC_ASSET_PATTERNS: RegExp[] = [
  /^\/api\/og\//,
  /^\/api\/memes\/[^/]+\/image$/,
  /^\/api\/memes\/templates\//,
];
// The OG shells are the only HTML documents this server emits; they carry an
// <img> (same-origin render or a legacy R2/Cloudinary/GCS CDN URL) and NO
// <script>/<style>, so images are the only subresource the CSP must permit.
const OG_SHELL_PATTERN = /^\/api\/og\//;

function isPublicAssetPath(path: string): boolean {
  return PUBLIC_ASSET_PATTERNS.some((re) => re.test(path));
}

/** Build the route-class CSP string once per boot (env is fixed for the process). */
function buildCsp(kind: "json" | "og", isProduction: boolean): string {
  // `base-uri` and `form-action` have NO fallback to default-src, so list them
  // explicitly. script-src/style-src/etc. inherit 'none' from default-src.
  const directives = ["default-src 'none'", "base-uri 'none'", "form-action 'none'"];
  if (kind === "og") {
    // Allow the card image from self or any https CDN (legacy R2/Cloudinary/GCS)
    // plus data: for any inline preview. Crawlers ignore CSP; this only governs
    // the human `?noredirect=1` inspection view.
    directives.push("img-src 'self' https: data:");
  }
  // frame-ancestors only in production; in Replit preview the webview frames us.
  if (isProduction) directives.push("frame-ancestors 'none'");
  return directives.join("; ");
}

/**
 * Returns the ordered middleware chain that applies the security headers.
 * Reads the environment at call time so the app (and tests) get a policy
 * matching the current NODE_ENV / REPLIT_DEPLOYMENT / REPLIT_DEV_DOMAIN.
 */
export function securityHeaders(): RequestHandler[] {
  const isProduction = isProductionEnv();
  const cspJson = buildCsp("json", isProduction);
  const cspOg = buildCsp("og", isProduction);

  const base = helmet({
    // We emit CSP ourselves (Report-Only + route-class aware) below.
    contentSecurityPolicy: false,
    // Disabled deliberately — see file header (OAuth popup opener; low value here).
    crossOriginOpenerPolicy: false,
    // Default `same-origin`; overridden to cross-origin for public assets below.
    crossOriginResourcePolicy: { policy: "same-origin" },
    // Never require COEP (helmet default is already off) — would break embeds.
    crossOriginEmbedderPolicy: false,
    // Production-only HSTS; conservative — explicitly NO includeSubDomains/preload
    // yet (helmet defaults includeSubDomains to true), until every *.overhype.me
    // subdomain is confirmed HTTPS. See file header.
    hsts: isProduction
      ? { maxAge: 15_552_000, includeSubDomains: false, preload: false }
      : false,
    // DENY in production; omitted in Replit preview (webview iframe).
    frameguard: isProduction ? { action: "deny" } : false,
    referrerPolicy: { policy: "no-referrer" },
  });

  const perRoute: RequestHandler = (req: Request, res, next) => {
    if (isPublicAssetPath(req.path)) {
      // Public, hotlinkable assets (already ACAO:*). Allow cross-origin embeds.
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    }
    // Report-Only first — flip the header name to enforce after UAT.
    res.setHeader(
      "Content-Security-Policy-Report-Only",
      OG_SHELL_PATTERN.test(req.path) ? cspOg : cspJson,
    );
    next();
  };

  return [base, perRoute];
}
