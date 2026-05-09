/**
 * Phase-4 audit logger for the transient render endpoints.
 *
 * Every call to /api/render-preview and /api/render-download — successful,
 * rejected, or errored — produces one row in `transient_renders`. Raw IPs
 * are never stored; we hash them with a server-side salt so source-IP queries
 * still work for abuse pattern detection without retaining PII (Phase-1
 * audit-PII principle).
 */

import crypto from "node:crypto";
import type { Request } from "express";
import { db } from "@workspace/db";
import { transientRendersTable } from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Salt used when hashing IPs for storage. Must be a stable per-deployment
 * secret — rotating the salt invalidates historical lookup keys, which is the
 * correct behaviour: two requests from the same IP across a salt rotation
 * will produce two distinct ip_hash values.
 *
 * We deliberately fall back to a fixed nonsense string when the env var is
 * missing so dev / test environments do not crash on boot. The fallback is
 * logged at WARN once on first use — production deployments must set the env
 * var via Replit Secrets to avoid an effectively-unsalted hash.
 */
const FALLBACK_SALT = "overhype-dev-transient-render-salt-v1";
let warnedAboutMissingSalt = false;

function getIpSalt(): string {
  const salt = process.env.IP_HASH_SALT;
  if (salt && salt.length >= 16) return salt;
  if (!warnedAboutMissingSalt) {
    warnedAboutMissingSalt = true;
    logger.warn(
      "[transientRenderLog] IP_HASH_SALT env var is missing or too short — falling back to a fixed dev salt. Set IP_HASH_SALT (>= 16 chars) in production.",
    );
  }
  return FALLBACK_SALT;
}

/**
 * Extract the connecting IP from a request. Cloudflare sets
 * `CF-Connecting-IP` to the originating client IP; we trust it because the
 * platform terminates TLS at Cloudflare and rewrites the header for us. The
 * `X-Forwarded-For` chain is intentionally NOT consulted — it can be spoofed
 * upstream when Cloudflare is bypassed, and Express's `req.ip` honours it
 * when `trust proxy` is set.
 *
 * Falls back through the chain so dev / test (which doesn't route through CF)
 * still gets a usable value:
 *   1. CF-Connecting-IP
 *   2. req.ip      (Express's interpretation of trust-proxy)
 *   3. socket.remoteAddress
 *   4. literal "unknown"
 */
export function ipFromRequest(req: Request): string {
  const cfHeader = req.headers["cf-connecting-ip"];
  if (typeof cfHeader === "string" && cfHeader.length > 0) return cfHeader;
  if (Array.isArray(cfHeader) && cfHeader[0]) return cfHeader[0];
  if (req.ip) return req.ip;
  const socketIp = req.socket?.remoteAddress;
  if (socketIp) return socketIp;
  return "unknown";
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(`${ip}|${getIpSalt()}`).digest("hex");
}

export type TransientRenderEndpoint = "preview" | "download";
export type TransientRenderResult = "success" | "rejected" | "error";

export interface TransientRenderLogEntry {
  endpoint: TransientRenderEndpoint;
  factId?: number | null;
  userId?: string | null;
  ip: string;
  mode?: string | null;
  result: TransientRenderResult;
  rejectionReason?: string | null;
  latencyMs?: number | null;
}

/**
 * Insert a single row into `transient_renders`. Failures are logged at WARN
 * but never thrown — the audit table is best-effort metrics and must not fail
 * a user's render. Callers should always treat this as fire-and-forget.
 */
export async function logTransientRender(entry: TransientRenderLogEntry): Promise<void> {
  try {
    await db.insert(transientRendersTable).values({
      endpoint: entry.endpoint,
      factId: entry.factId ?? null,
      userId: entry.userId ?? null,
      ipHash: hashIp(entry.ip),
      mode: entry.mode ?? null,
      result: entry.result,
      rejectionReason: entry.rejectionReason ?? null,
      latencyMs: entry.latencyMs ?? null,
    });
  } catch (err) {
    logger.warn({ err, entry: { ...entry, ip: "<redacted>" } }, "[transientRenderLog] insert failed");
  }
}
