/**
 * Single source of truth for whether the dev-admin-login backdoor is enabled.
 *
 * `POST/GET /api/auth/dev-admin-login` mints a bootstrap-admin session for ANY
 * caller (unauthenticated privilege escalation), so it MUST be fail-closed:
 *
 *   - OFF by default (no env → disabled everywhere).
 *   - Opt-in ONLY via `ENABLE_DEV_ADMIN_LOGIN=true`, for non-production previews.
 *   - NEVER enabled in production, even if the flag is somehow set there
 *     (belt-and-suspenders — production wins over the flag).
 *
 * The handler (routes/localAuth.ts), the permissive CORS + origin-exemption
 * (app.ts), and the UI trigger (Navbar.tsx, via `import.meta.env.DEV`) all gate
 * on this one predicate so they can't drift out of sync. Finding C1 — see
 * docs/ai-context/security-model.md.
 *
 * Read at request time (handler) and at boot (app.ts); the environment is fixed
 * for the process lifetime, so both agree.
 */
export function isDevAdminLoginEnabled(): boolean {
  const isProduction =
    process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
  if (isProduction) return false;
  return process.env.ENABLE_DEV_ADMIN_LOGIN === "true";
}
