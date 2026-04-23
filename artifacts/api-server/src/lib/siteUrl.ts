/**
 * Base URL for transactional email links.
 * Priority:
 *   1. SITE_BASE_URL env var (explicit override — always wins)
 *   2. In production deployments, the canonical https://overhype.me domain.
 *      We deliberately do NOT use REPLIT_DOMAINS here, because Replit injects
 *      the auto-assigned *.replit.app hostname there even when a custom domain
 *      is configured — that would surface the wrong domain in user-facing
 *      transactional email links.
 *   3. REPLIT_DEV_DOMAIN env var for in-workspace dev/preview links.
 *   4. https://overhype.me as the final fallback.
 * Trailing slash is always stripped so callers can safely append paths.
 */
export function getSiteBaseUrl(): string {
  if (process.env.SITE_BASE_URL) {
    return process.env.SITE_BASE_URL.replace(/\/$/, "");
  }
  const isProduction =
    process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
  if (isProduction) {
    return "https://overhype.me";
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return "https://overhype.me";
}
