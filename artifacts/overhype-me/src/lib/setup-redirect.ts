/**
 * @purpose Decides where the web shell sends a signed-in account that cannot act yet (launch Phase 5, plan *Who is sent there*): a suspended one to the suspended screen, one scheduled for deletion to the "Keep my account" screen, an unverified account to "check your email", an un-onboarded one to onboarding, each set-up step carrying where it was going; the set-up, sign-in and keep-my-account pages themselves are never redirected away from.
 * @subsystem accounts-auth
 */

/** Where an account that cannot act yet may be without being sent on. */
const SETUP_EXEMPT_ROOTS = ["/onboard", "/check-email", "/verify-email", "/login", "/forgot-password", "/reset-password", "/account/deletion", "/account/suspended"];

/** The account states that cannot act yet, each sent to its own screen. */
const REDIRECTED_STATES = new Set<string | null | undefined>(["suspended", "deletion_pending", "unverified", "unonboarded"]);

/** Where an account scheduled for deletion is sent: the one thing it can do is keep itself. */
export const KEEP_ACCOUNT_PATH = "/account/deletion";

/** Where a suspended account is sent: it can do nothing but sign out. */
export const SUSPENDED_PATH = "/account/suspended";

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
  if (!REDIRECTED_STATES.has(eligibility)) return null;
  const path = location.split("?")[0] ?? location;
  if (SETUP_EXEMPT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return null;
  // Nothing else is open to either, so there is nowhere to come back to.
  if (eligibility === "suspended") return SUSPENDED_PATH;
  if (eligibility === "deletion_pending") return KEEP_ACCOUNT_PATH;
  const returnTo = encodeURIComponent(location);
  if (eligibility === "unverified") return `/check-email?returnTo=${returnTo}`;
  if (eligibility === "unonboarded") return `/onboard?returnTo=${returnTo}`;
  return null;
}
