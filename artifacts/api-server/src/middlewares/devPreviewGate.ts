/**
 * @purpose devPreviewGate: in a Replit workspace (development), refuses the dev admin shortcut (/api/auth/dev-admin-login) to a request that reached the server through the public `*.replit.dev` preview address unless it carries DEV_PREVIEW_KEY, by header or cookie; every other API address, direct local requests and the published deployment are untouched. A keyed POST /api/dev-preview-gate sets the cookie.
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
/** The dev admin shortcut, the one address the key guards. */
const ADMIN_LOGIN_PATH = "/api/auth/dev-admin-login";
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
    message: "The dev admin shortcut needs the preview key. Open the preview once with ?devPreviewKey=<DEV_PREVIEW_KEY> to unlock this browser.",
  });
}

export function devPreviewGate(env: NodeJS.ProcessEnv = process.env) {
  const gated = isGatedEnvironment(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!gated) return next();
    if (isDirectLocalRequest(req)) return next();
    if (req.path !== ADMIN_LOGIN_PATH && req.path !== GATE_PATH) return next();
    const key = env.DEV_PREVIEW_KEY ?? "";

    if (!key) return refuse(res);
    const fromCookie = readCookie(req.headers.cookie, DEV_PREVIEW_COOKIE);
    const keyed = matchesKey(req.headers[DEV_PREVIEW_HEADER], key);
    if (!keyed && !matchesKey(fromCookie, key)) return refuse(res);

    // The web app's unlock call: a keyed POST, never a key in an address, so
    // no log or trace records it. It sets the cookie for a navigation to the
    // shortcut, which script cannot key; Partitioned lets an embedded preview
    // pane keep it where the browser refuses third-party cookies.
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
