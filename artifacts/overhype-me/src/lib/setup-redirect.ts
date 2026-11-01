/**
 * @purpose Decides where the web shell sends a signed-in account that is not set up yet (launch Phase 5, plan *Who is sent there*): an unverified account to "check your email", an un-onboarded one to onboarding, each carrying where it was going; the set-up and sign-in pages themselves are never redirected away from.
 * @subsystem accounts-auth
 */

/** Where an account that cannot act yet may be without being sent on. */
const SETUP_EXEMPT_ROOTS = ["/onboard", "/check-email", "/verify-email", "/login", "/forgot-password", "/reset-password"];

/**
 * The destination to come back to: the path wouter's `useLocation` gives
 * (pathname only) joined to the address bar's raw query. Raw, because wouter's
 * `useSearch` strips the `?` and decodes the values, which would turn
 * `q=a%26b` into two parameters (PR #801 round 1).
 */
export function currentDestination(pathname: string, rawSearch: string): string {
  if (!rawSearch || rawSearch === "?") return pathname;
  return `${pathname}${rawSearch.startsWith("?") ? rawSearch : `?${rawSearch}`}`;
}

export function setupRedirectFor(eligibility: string | null | undefined, location: string): string | null {
  if (eligibility !== "unverified" && eligibility !== "unonboarded") return null;
  const path = location.split("?")[0] ?? location;
  if (SETUP_EXEMPT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return null;
  const returnTo = encodeURIComponent(location);
  if (eligibility === "unverified") return `/check-email?returnTo=${returnTo}`;
  if (eligibility === "unonboarded") return `/onboard?returnTo=${returnTo}`;
  return null;
}
