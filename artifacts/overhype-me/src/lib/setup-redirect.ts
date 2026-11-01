/**
 * @purpose Decides where the web shell sends a signed-in account that is not set up yet (launch Phase 5, plan *Who is sent there*): an unverified account to "check your email", an un-onboarded one to onboarding, each carrying where it was going; the set-up and sign-in pages themselves are never redirected away from.
 * @subsystem accounts-auth
 */

/** Where an account that cannot act yet may be without being sent on. */
const SETUP_EXEMPT_ROOTS = ["/onboard", "/check-email", "/verify-email", "/login", "/forgot-password", "/reset-password"];

export function setupRedirectFor(eligibility: string | null | undefined, location: string): string | null {
  const path = location.split("?")[0] ?? location;
  if (SETUP_EXEMPT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return null;
  const returnTo = encodeURIComponent(location);
  if (eligibility === "unverified") return `/check-email?returnTo=${returnTo}`;
  if (eligibility === "unonboarded") return `/onboard?returnTo=${returnTo}`;
  return null;
}
