/**
 * The IP-hash salt: resolution, the dev fallback, and the production assertion.
 *
 * Split out of `transientRenderLog.ts` for one reason — **import graph**. That
 * module imports `@workspace/db`, and the salt assertion has to run before the
 * DB-backed graph is evaluated (see `lib/bootChecks.ts` for why). This file
 * therefore imports nothing but `node:crypto`, `./env` and `./logger`, none of
 * which reach the database.
 *
 * `transientRenderLog.ts` re-exports `hashIp` from here, so existing callers
 * are unaffected.
 */

import crypto from "node:crypto";
import { logger } from "./logger";
import { isProductionEnv } from "./env";

/**
 * Salt used when hashing IPs for storage. Must be a stable per-deployment
 * secret — rotating the salt invalidates historical lookup keys, which is the
 * correct behaviour: two requests from the same IP across a salt rotation
 * will produce two distinct ip_hash values.
 *
 * We deliberately fall back to a fixed nonsense string when the env var is
 * missing so dev / test environments do not crash on boot. Production is
 * covered by `assertIpSaltConfigured()` instead of by this fallback.
 */
const FALLBACK_SALT = "overhype-dev-transient-render-salt-v1";
const MIN_SALT_LENGTH = 16;
let warnedAboutMissingSalt = false;

/** True when `IP_HASH_SALT` is set to a usable value. */
function hasUsableIpSalt(): boolean {
  const salt = process.env.IP_HASH_SALT;
  return typeof salt === "string" && salt.length >= MIN_SALT_LENGTH;
}

/**
 * Boot-time assertion: in production, refuse to start without a real salt.
 *
 * The WARN below was the only signal for two years and it is not enough, for a
 * reason specific to this subsystem: `logTransientRender` catches and swallows
 * its own errors by design (the audit insert must never fail a user's render),
 * so making `getIpSalt` throw at *runtime* would be silently absorbed by that
 * same catch. Boot is the only place the failure is loud.
 *
 * What is actually at stake: `FALLBACK_SALT` is a literal in this repository,
 * which is public. Hashing production IPs with it makes those hashes
 * reversible by anyone — a rainbow table over the IPv4 space is trivial — so
 * the hashing stops being a privacy control at all while still looking like
 * one in the schema.
 *
 * Non-production keeps the fallback: dev, test and preview must not need a
 * secret to boot.
 *
 * Invoked by `lib/bootChecks.ts`, which `index.ts` imports before anything
 * that reaches the database. Deferred twice before shipping (see
 * `docs/engineering/deferred-work.md`).
 */
export function assertIpSaltConfigured(): void {
  if (!isProductionEnv()) return;
  if (hasUsableIpSalt()) return;
  throw new Error(
    "IP_HASH_SALT is required in production and must be at least " +
      `${MIN_SALT_LENGTH} characters. Without it, transient-render IP hashes ` +
      "use a salt committed to this public repository, which makes them " +
      "reversible. Set IP_HASH_SALT via Replit Secrets.",
  );
}

function getIpSalt(): string {
  if (hasUsableIpSalt()) return process.env.IP_HASH_SALT as string;
  if (!warnedAboutMissingSalt) {
    warnedAboutMissingSalt = true;
    logger.warn(
      "[transientRenderLog] IP_HASH_SALT env var is missing or too short — falling back to a fixed dev salt. Set IP_HASH_SALT (>= 16 chars) in production.",
    );
  }
  return FALLBACK_SALT;
}

export function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(`${ip}|${getIpSalt()}`).digest("hex");
}
