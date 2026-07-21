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
 *  - **CORP is decided by actual visibility, not by path.** helmet's default
 *    `same-origin` is the safe baseline set here; the `cross-origin` relaxation
 *    is applied by `setPublicCors()` (lib/cacheHeaders.ts) — which routes call
 *    ONLY after a response is confirmed public. This avoids the trap where a
 *    path pattern like `/api/memes/:slug/image` matches BOTH a public meme and a
 *    private/owner-only one (or the owner-gated `/api/memes/ai-user/image`): a
 *    private response never calls `setPublicCors`, so it correctly stays
 *    `same-origin` (non-embeddable), and a genuinely public object gets
 *    `cross-origin` even though its path isn't in any allowlist here.
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

// The OG shells are the only HTML documents this server emits; they carry an
// <img> (same-origin render or a legacy R2/Cloudinary/GCS CDN URL) and NO
// <script>/<style>, so images are the only subresource the CSP must permit.
// (CORP for the images those shells reference is set on the image responses
// themselves via setPublicCors, not here.)
const OG_SHELL_PATTERN = /^\/api\/og\//;

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
    // CORP is intentionally NOT set here — it's decided by visibility in
    // setPublicCors() (see file header). helmet's `same-origin` default stands
    // for everything until a route confirms the response is public.
    // Report-Only first — flip the header name to enforce after UAT.
    res.setHeader(
      "Content-Security-Policy-Report-Only",
      OG_SHELL_PATTERN.test(req.path) ? cspOg : cspJson,
    );
    next();
  };

  return [base, perRoute];
}
