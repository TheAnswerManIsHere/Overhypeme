/**
 * @purpose The one decision of when to ask a visitor for their name and pronouns (#719): completeness, the pages that never ask, and the shared-content landing exception, as pure functions the identity provider and the welcome sheet consume.
 * @subsystem public-site
 */

/** Auth as the identity decision sees it. "loading" never asks. */
export type IdentityAuthState = "loading" | "signedOut" | "signedIn";

/**
 * Pages that never show the identity sheet, matched as whole path segments:
 * `/login` and `/login/x` are suppressed, `/loginx` is not.
 */
const SUPPRESSED_ROOTS = ["login", "onboard", "forgot-password", "reset-password", "verify-email", "admin"];

function segments(path: string): string[] {
  const clean = path.split(/[?#]/)[0] ?? "";
  return clean.split("/").filter(Boolean);
}

export function isSuppressedPath(path: string): boolean {
  const first = segments(path)[0];
  return first !== undefined && SUPPRESSED_ROOTS.includes(first);
}

/**
 * The shared-content pages whose first landing shows its content before
 * asking: `/m/:slug` and `/facts/:id` itself. A builder
 * sub-route such as `/facts/:id/meme` is already an action and is excluded.
 */
export function isLandingExceptionPath(path: string): boolean {
  const s = segments(path);
  return s.length === 2 && (s[0] === "m" || s[0] === "facts");
}

export interface IdentityCompleteness {
  /** A non-empty name is held. */
  hasName: boolean;
  /** Pronouns were supplied by the visitor or a link, not the rendering fallback. */
  pronounsSupplied: boolean;
}

export function isIdentityComplete(c: IdentityCompleteness): boolean {
  return c.hasName && c.pronounsSupplied;
}

export interface IdentityDecisionInput {
  auth: IdentityAuthState;
  completeness: IdentityCompleteness;
  /**
   * Phase 1 only: a signed-in account's display name. Signed-in completeness
   * (name and pronouns on the account) arrives with account reconciliation in
   * Phase 2; until then a signed-in visitor is asked only when neither the
   * account nor the browser holds a name.
   */
  accountDisplayName?: string | null;
  /** The current location (path). */
  location: string;
  /** The path this visit landed on (the first page of the page load). */
  landingLocation: string;
  /**
   * The visit has left its landing page at least once. The exception lapses
   * for good then: returning to the landing path (Back, or the app routing
   * there) does not restore it.
   */
  landingLapsed: boolean;
}

/** Whether the identity sheet should be open right now. */
export function shouldAskForIdentity(input: IdentityDecisionInput): boolean {
  const { auth, completeness, accountDisplayName, location, landingLocation, landingLapsed } = input;
  if (auth === "loading") return false;
  if (isSuppressedPath(location)) return false;
  if (!landingLapsed && location === landingLocation && isLandingExceptionPath(landingLocation)) return false;
  if (auth === "signedIn") {
    return !completeness.hasName && !accountDisplayName?.trim();
  }
  return !isIdentityComplete(completeness);
}

/**
 * Whether a builder may initialize its draft from the identity now. A builder
 * copies the identity once, at mount, so it starts only from a complete one.
 * Phase 1 gates signed-out arrivals; signed-in gating arrives with account
 * completion in Phase 2.
 */
export function canStartBuilder(auth: IdentityAuthState, completeness: IdentityCompleteness): boolean {
  if (auth === "loading") return false;
  if (auth === "signedIn") return true;
  return isIdentityComplete(completeness);
}
