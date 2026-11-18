/**
 * @purpose devPreviewGate: in a Replit workspace (development), refuses every API request that reached the server through the public `*.replit.dev` preview address unless it carries DEV_PREVIEW_KEY, by header or cookie; requests to localhost are untouched and the published deployment never gates. GET /api/dev-preview-gate?key= sets the cookie.
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
    message: "This development preview is private. Open /api/dev-preview-gate?key=<DEV_PREVIEW_KEY> once to unlock it in this browser.",
  });
}

export function devPreviewGate(env: NodeJS.ProcessEnv = process.env) {
  const gated = isGatedEnvironment(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!gated) return next();
    if (isDirectLocalRequest(req)) return next();
    const key = env.DEV_PREVIEW_KEY ?? "";

    if (req.path === GATE_PATH && req.method === "GET") {
      if (!key || !matchesKey(req.query.key, key)) return refuse(res);
      res.cookie(DEV_PREVIEW_COOKIE, key, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
        maxAge: 90 * 86_400_000,
      });
      res.redirect(302, "/");
      return;
    }

    if (!key) return refuse(res);
    const fromCookie = readCookie(req.headers.cookie, DEV_PREVIEW_COOKIE);
    if (matchesKey(req.headers[DEV_PREVIEW_HEADER], key) || matchesKey(fromCookie, key)) return next();
    return refuse(res);
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
