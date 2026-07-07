/**
 * Single source of truth for whether the "dev admin login" convenience route
 * (the wordmark triple-tap → instant bootstrap-admin session) is enabled.
 *
 * Fail-closed: disabled unless `ENABLE_DEV_ADMIN_LOGIN==="true"`, and NEVER
 * enabled when `NODE_ENV==="production"` regardless of the flag. app.ts
 * (CORS + origin-exemption), routes/localAuth.ts (route registration), and the
 * client wordmark trigger all read this same gate, so the route cannot be
 * half-mounted (e.g. exempt from CSRF but otherwise "off").
 *
 * To use it in a non-production preview (e.g. the Replit canvas), set
 * `ENABLE_DEV_ADMIN_LOGIN=true` on the server and `VITE_ENABLE_DEV_ADMIN_LOGIN=true`
 * for the client build. In production it stays off no matter what.
 */
export function isDevAdminLoginEnabled(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.ENABLE_DEV_ADMIN_LOGIN === "true";
}
