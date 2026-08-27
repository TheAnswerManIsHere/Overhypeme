/**
 * Environment predicates with a deliberately empty import graph.
 *
 * This module must not import anything — not the logger, not `@workspace/db`,
 * nothing. `lib/bootChecks.ts` runs before the rest of the server's modules are
 * evaluated, and anything reachable from here would be pulled forward with it,
 * which is precisely the ordering problem bootChecks exists to solve.
 */

/**
 * Canonical production predicate.
 *
 * `REPLIT_DEPLOYMENT` is `"1"` only in a published deployment — a Replit
 * preview sets `"0"`, which is NOT production. `NODE_ENV` covers the
 * non-Replit case.
 *
 * `lib/siteUrl.ts` and `lib/devAdminLogin.ts` still carry their own inline
 * copies of this expression; consolidating those is tracked in
 * `docs/engineering/deferred-work.md` rather than done here, since rewriting
 * the predicate inside two security-critical modules is a larger change than
 * the boot assertion that needed a shared copy.
 */
export function isProductionEnv(): boolean {
  return process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
}
