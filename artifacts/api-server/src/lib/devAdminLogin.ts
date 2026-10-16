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
 * The handler (routes/localAuth.ts) and the permissive CORS + origin-exemption
 * (app.ts) gate on this one predicate so they can't drift out of sync. The UI
 * trigger (Navbar.tsx) cannot call it and gates separately on
 * `import.meta.env.DEV`. Finding C1 — see docs/ai-context/security-model.md.
 *
 * Read at request time (handler) and at boot (app.ts); the environment is fixed
 * for the process lifetime, so both agree.
 *
 * @purpose isDevAdminLoginEnabled: true only when ENABLE_DEV_ADMIN_LOGIN is "true" and neither REPLIT_DEPLOYMENT is "1" nor NODE_ENV is "production"; the dev-admin-login handler and app.ts's CORS exemption gate on it.
 * @subsystem security
 */
export function isDevAdminLoginEnabled(): boolean {
  const isProduction =
    process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
  if (isProduction) return false;
  return process.env.ENABLE_DEV_ADMIN_LOGIN === "true";
}
