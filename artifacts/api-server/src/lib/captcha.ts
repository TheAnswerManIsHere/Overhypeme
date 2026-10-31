/**
 * Shared Cloudflare Turnstile server-side verification (launch Phase 5,
 * increment 1; it replaced hCaptcha, #795).
 *
 * Bypass rules (intentional, unchanged from the hCaptcha helper):
 * - NODE_ENV is not "production": if TURNSTILE_SECRET_KEY is not set, verification is skipped with a warning.
 * - NODE_ENV is "production": if TURNSTILE_SECRET_KEY is not set, all verifications fail (returns false).
 * This reads NODE_ENV alone, a narrower test than isProductionEnv in ./env (see #700).
 *
 * A token is single-use and expires five minutes after the widget issues it
 * (Cloudflare, "Validate the token"), so a caller verifies at the moment of the
 * action it protects and never caches the answer.
 *
 * @purpose Server-side Cloudflare Turnstile verification shared by every captcha-gated route; with no secret configured it fails closed when NODE_ENV is production and skips with a warning otherwise, a narrower test than isProductionEnv (#700).
 * @subsystem security
 */
import { logger } from "./logger";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_TIMEOUT_MS = 10_000;

export async function verifyCaptcha(token: string, remoteIp?: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const isProd = process.env.NODE_ENV === "production";

  if (!secret) {
    if (isProd) {
      return false;
    }
    // Dev bypass — intentional, keeps local dev frictionless.
    logger.warn("[dev] TURNSTILE_SECRET_KEY not set — bypassing CAPTCHA verification");
    return true;
  }
  if (!token) return false;

  try {
    const body: Record<string, string> = { secret, response: token };
    if (remoteIp) body.remoteip = remoteIp;
    const resp = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // A hung siteverify must not hold the caller's request open; a timeout
      // fails closed like any other unreachable answer.
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status }, "[captcha] Turnstile siteverify answered non-2xx");
      return false;
    }
    const data = (await resp.json()) as { success?: unknown; "error-codes"?: unknown };
    if (data.success !== true) {
      logger.info({ errorCodes: data["error-codes"] }, "[captcha] Turnstile token rejected");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, "[captcha] Turnstile siteverify unreachable");
    return false;
  }
}
