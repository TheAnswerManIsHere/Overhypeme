/**
 * @purpose devPreviewGate: in a Replit workspace (development), refuses every API request that reached the server through the public `*.replit.dev` preview address unless it carries DEV_PREVIEW_KEY, by header or cookie; requests to localhost and Stripe's signed test webhook are untouched, and the published deployment never gates. A keyed POST /api/dev-preview-gate sets the cookie.
 * @subsystem security
 *
 * Why (launch Phase 14, increment 3; measured 2026-11-18): the workspace
 * preview address answers the open internet while the dev app runs, and with
 * ENABLE_DEV_ADMIN_LOGIN on there an unauthenticated POST to
 * /api/auth/dev-admin-login minted an administrator session. The plan's rule:
 * a reachable development preview is protected, not accepted.
 *
 * Fail-closed: with no DEV_PREVIEW_KEY set, preview-address requests are all
 * refused. Direct local requests (the Repl agent's checks, `curl localhost:8080`,
 * the workflow's own health probe) are never gated.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { isProductionEnv } from "../lib/env";

export const DEV_PREVIEW_COOKIE = "dev_preview_key";
export const DEV_PREVIEW_HEADER = "x-dev-preview-key";
const GATE_PATH = "/api/dev-preview-gate";
/**
 * Stripe's test-mode webhook. Dev registers it at the preview address
 * (lib/stripeInit.ts, from getSiteBaseUrl(), which is the dev domain when
 * SITE_BASE_URL is unset), and Stripe cannot carry the key. The route
 * verifies Stripe's signature before it acts, so the key would add nothing
 * there; every other address stays gated.
 */
const STRIPE_WEBHOOK_PATH = "/api/stripe/webhook";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True in a Replit workspace (development), never in the published deployment or a bare local stack. */
export function isGatedEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isProductionEnv(env)) return false;
  return typeof env.REPLIT_DEV_DOMAIN === "string" && env.REPLIT_DEV_DOMAIN.length > 0;
}

/** The Host header's hostname, lower-cased and without a port. */
function hostHeaderName(req: Request): string {
  const raw = (req.headers.host ?? "").trim().toLowerCase();
  if (raw.startsWith("[")) return raw.slice(0, raw.indexOf("]") + 1);
  return raw.split(":")[0]!;
}

/**
 * A direct local request: addressed to localhost and carrying no proxy
 * forwarding header. Replit's preview proxy adds X-Forwarded-For, and a caller
 * can add headers but never remove the proxy's, so a preview request is never
 * read as local whatever Host it ends up with.
 */
function isDirectLocalRequest(req: Request): boolean {
  if (req.headers["x-forwarded-for"] !== undefined || req.headers["forwarded"] !== undefined) return false;
  return LOCAL_HOSTS.has(hostHeaderName(req));
}

function matchesKey(given: unknown, key: string): boolean {
  if (typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function refuse(res: Response): void {
  res.status(403).json({
    error: "dev_preview_locked",
    message: "This development preview is private. Open the preview once with ?devPreviewKey=<DEV_PREVIEW_KEY> to unlock this browser. Inside Replit's embedded pane, pictures and sign-in need the preview open in its own tab.",
  });
}

export function devPreviewGate(env: NodeJS.ProcessEnv = process.env) {
  const gated = isGatedEnvironment(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!gated) return next();
    if (isDirectLocalRequest(req)) return next();
    if (req.method === "POST" && req.path === STRIPE_WEBHOOK_PATH) return next();
    const key = env.DEV_PREVIEW_KEY ?? "";

    if (!key) return refuse(res);
    const fromCookie = readCookie(req.headers.cookie, DEV_PREVIEW_COOKIE);
    const keyed = matchesKey(req.headers[DEV_PREVIEW_HEADER], key);
    if (!keyed && !matchesKey(fromCookie, key)) return refuse(res);

    // The web app's unlock call: a keyed POST, never a key in an address, so
    // no log or trace records it. It sets the cookie for what script cannot
    // key (pictures, navigations); Partitioned lets an embedded preview pane
    // keep it where the browser refuses third-party cookies.
    if (req.path === GATE_PATH && req.method === "POST" && keyed) {
      res.cookie(DEV_PREVIEW_COOKIE, key, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        partitioned: true,
        path: "/",
        maxAge: 90 * 86_400_000,
      });
      res.status(204).end();
      return;
    }
    return next();
  };
}

/** The gate runs ahead of cookie-parser, so it reads the raw header. */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
