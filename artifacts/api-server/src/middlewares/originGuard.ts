/**
 * @purpose originGuard: in the published deployment, refuses every API request that did not come through Cloudflare (no ORIGIN_SECRET in the x-overhype-origin header, which only Cloudflare's transform rule adds) and, on requests that did, every visitor Cloudflare's location headers place in a blocked country or region. /api/healthz is exempt for the platform's health check. Never active outside the deployment.
 * @subsystem security
 *
 * Launch Phase 14, increment 3 (plan S-e): "In production the API refuses any
 * request lacking a secret header that only Cloudflare adds, and reads
 * location headers only on requests that carry it." The Replit hostname and a
 * direct connection to Replit's ingress with the real hostname both skip
 * Cloudflare, so neither carries the secret; a Host check would not stop the
 * second. The region check is the backstop behind Cloudflare's redirect rule
 * (lib/geography.ts).
 *
 * Fail-closed: a deployment with no ORIGIN_SECRET configured refuses every
 * request but the health check. The deployment marker alone switches it on
 * (REPLIT_DEPLOYMENT=1), never NODE_ENV, so CI's production-mode runs, which
 * refuse to run under that marker (testing/productionModeGuard.ts), are
 * untouched.
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { isBlockedLocation } from "../lib/geography";

export const ORIGIN_HEADER = "x-overhype-origin";
const EXEMPT_PATHS = new Set(["/api/healthz"]);

export function isOriginGuardActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.REPLIT_DEPLOYMENT === "1";
}

/** True when the request carries the secret only Cloudflare adds. */
export function cameThroughCloudflare(req: Request, secret: string | undefined): boolean {
  const given = req.headers[ORIGIN_HEADER];
  if (!secret || typeof given !== "string" || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" ? v : undefined;
}

export function originGuard(env: NodeJS.ProcessEnv = process.env) {
  const active = isOriginGuardActive(env);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!active || EXEMPT_PATHS.has(req.path)) return next();
    res.setHeader("Cache-Control", "no-store");
    if (!cameThroughCloudflare(req, env.ORIGIN_SECRET)) {
      res.status(403).json({ error: "not_admitted", admitted: false });
      return;
    }
    if (isBlockedLocation(header(req, "cf-ipcountry"), header(req, "cf-region-code"))) {
      res.status(451).json({ error: "region_blocked", admitted: false });
      return;
    }
    res.removeHeader("Cache-Control");
    next();
  };
}
