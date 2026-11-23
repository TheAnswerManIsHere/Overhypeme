/**
 * @purpose Decides where the web shell sends a signed-in account that cannot act yet (launch Phase 5, plan *Who is sent there*): a suspended one to the suspended screen, an under-age one to the adults-only screen, one scheduled for deletion to the "Keep my account" screen, an unverified account to "check your email", an un-onboarded one to onboarding, and one that has not accepted the current Terms to the accept screen until it says "not now" for this visit (launch Phase 14, increment 4), each set-up step carrying where it was going; the set-up, sign-in and account-state pages themselves, and the four legal pages, are never redirected away from.
 * @subsystem accounts-auth
 */
import { LEGAL_SLUGS } from "@/generated/legal";
import { ADULTS_ONLY_PATH } from "@/lib/age-refusal";

/** Where an account that cannot act yet may be without being sent on. */
const SETUP_EXEMPT_ROOTS = ["/onboard", "/check-email", "/verify-email", "/login", "/forgot-password", "/reset-password", "/account/deletion", "/account/suspended", ADULTS_ONLY_PATH, "/account/terms",
  // Asking for help works from every account state (launch Phase 16, increment 5).
  "/support", ...LEGAL_SLUGS.map((s) => `/${s}`)];

/** The account states that cannot act yet, each sent to its own screen. */
const REDIRECTED_STATES = new Set<string | null | undefined>(["suspended", "underage", "deletion_pending", "unverified", "unonboarded", "terms_unaccepted"]);

/** Where an account scheduled for deletion is sent: the one thing it can do is keep itself. */
export const KEEP_ACCOUNT_PATH = "/account/deletion";

/** Where a suspended account is sent: it can do nothing but sign out. */
export const SUSPENDED_PATH = "/account/suspended";

/** Where an account that has not accepted the current Terms is asked to. */
export const ACCEPT_TERMS_PATH = "/account/terms";

/**
 * "Not now" on the accept screen lasts this browser visit: the account reads
 * as before, its writes are still refused, and the next visit asks again.
 */
const TERMS_DEFERRED_KEY = "overhype.termsDeferred";

export function deferTermsForThisVisit(): void {
  try {
    window.sessionStorage.setItem(TERMS_DEFERRED_KEY, "1");
  } catch {
    // Storage refused: the screen asks again on the next page, which is safe.
  }
}

export function termsDeferredThisVisit(): boolean {
  try {
    return window.sessionStorage.getItem(TERMS_DEFERRED_KEY) === "1";
  } catch {
    return false;
  }
}

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

export function setupRedirectFor(
  eligibility: string | null | undefined,
  location: string,
  opts: { termsDeferred?: boolean } = {},
): string | null {
  if (!REDIRECTED_STATES.has(eligibility)) return null;
  if (eligibility === "terms_unaccepted" && opts.termsDeferred) return null;
  const path = location.split("?")[0] ?? location;
  if (SETUP_EXEMPT_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return null;
  // Nothing else is open to these, so there is nowhere to come back to.
  if (eligibility === "suspended") return SUSPENDED_PATH;
  if (eligibility === "underage") return ADULTS_ONLY_PATH;
  if (eligibility === "deletion_pending") return KEEP_ACCOUNT_PATH;
  const returnTo = encodeURIComponent(location);
  if (eligibility === "unverified") return `/check-email?returnTo=${returnTo}`;
  if (eligibility === "unonboarded") return `/onboard?returnTo=${returnTo}`;
  if (eligibility === "terms_unaccepted") return `${ACCEPT_TERMS_PATH}?returnTo=${returnTo}`;
  return null;
}
