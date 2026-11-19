/**
 * @purpose The dev preview key: previewKeyAdmits(req) is the check the dev admin shortcut's own handler makes (routes/localAuth.ts) — in a Replit workspace (development), a request through the public `*.replit.dev` preview address needs DEV_PREVIEW_KEY by header or cookie; direct local requests and the published deployment always pass. devPreviewGate() mounts only the unlock call, a keyed POST /api/dev-preview-gate that sets the cookie; every other API address is untouched.
 * @subsystem security
 *
 * Why (launch Phase 14, increment 3; measured 2026-11-18): the workspace
 * preview address answers the open internet while the dev app runs, and with
 * ENABLE_DEV_ADMIN_LOGIN on there an unauthenticated POST to
 * /api/auth/dev-admin-login minted an administrator session. The plan's rule:
 * a reachable development preview is protected, not accepted.
 *
 * Only that shortcut is gated (David, Q21: 1, 2026-11-19): the whole-API gate
 * of PR #1060 got in the way of testing and turned away Stripe's test
 * webhook, while the measured hole was the admin shortcut. The rest of the
 * dev API is reachable as it was before, sign-up included.
 *
 * The check lives on the shortcut's own handler, not in a middleware that
 * compares the address: Express matches routes case-insensitively and with an
 * optional trailing slash, so a literal comparison ahead of the router let
 * `/api/auth/dev-admin-login/` and `/API/auth/DEV-ADMIN-LOGIN` through
 * (PR #1072 round 1; docs/ai-context/security-model.md: "a stricter match
 * than the router's is a bypass"). On the handler, whatever Express routes
 * there is checked.
 *
 * Fail-closed: with no DEV_PREVIEW_KEY set, the shortcut is refused through
 * the preview. Direct local requests (the Repl agent's checks,
 * `curl localhost:8080`) are never gated.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { isProductionEnv } from "../lib/env";

export const DEV_PREVIEW_COOKIE = "dev_preview_key";
export const DEV_PREVIEW_HEADER = "x-dev-preview-key";
const GATE_PATH = "/api/dev-preview-gate";
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

/** The refusal the shortcut answers when the key is missing or wrong. */
export function refuseDevPreview(res: Response): void {
  res.status(403).json({
    error: "dev_preview_locked",
    message: "The dev admin shortcut needs the preview key. Open the preview once with ?devPreviewKey=<DEV_PREVIEW_KEY> to unlock this browser.",
  });
}

/**
 * True when this request may use the dev admin shortcut as far as the preview
 * key is concerned: always outside a Replit workspace and for direct local
 * requests; through the preview, only with DEV_PREVIEW_KEY by header or cookie.
 * Refused when no key is configured (fail closed).
 */
export function previewKeyAdmits(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isGatedEnvironment(env)) return true;
  if (isDirectLocalRequest(req)) return true;
  const key = env.DEV_PREVIEW_KEY ?? "";
  if (!key) return false;
  return matchesKey(req.headers[DEV_PREVIEW_HEADER], key) || matchesKey(readCookie(req.headers.cookie, DEV_PREVIEW_COOKIE), key);
}

/**
 * The unlock call alone: a keyed POST /api/dev-preview-gate through the
 * preview sets the cookie a navigation to the shortcut carries. Mounted ahead
 * of the origin and CSRF checks, since its fetch carries no CSRF header. Every
 * other request passes untouched; a variant spelling of this address reaches
 * no route (404) and sets nothing.
 */
export function devPreviewGate(env: NodeJS.ProcessEnv = process.env) {
  const gated = isGatedEnvironment(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!gated || req.path !== GATE_PATH) return next();
    if (isDirectLocalRequest(req)) return next();
    const key = env.DEV_PREVIEW_KEY ?? "";
    // A key in the address is never accepted: only the header unlocks.
    if (!key || req.method !== "POST" || !matchesKey(req.headers[DEV_PREVIEW_HEADER], key)) return refuseDevPreview(res);
    // Never a key in an address, so no log or trace records it. Partitioned
    // lets an embedded preview pane keep the cookie where the browser refuses
    // third-party cookies.
    res.cookie(DEV_PREVIEW_COOKIE, key, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      partitioned: true,
      path: "/",
      maxAge: 90 * 86_400_000,
    });
    res.status(204).end();
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
