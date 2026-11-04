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
const SUPPRESSED_ROOTS = ["login", "onboard", "forgot-password", "reset-password", "verify-email", "admin", "account"];

function segments(path: string): string[] {
  const clean = path.split(/[?#]/)[0] ?? "";
  return clean.split("/").filter(Boolean);
}

export function isSuppressedPath(path: string): boolean {
  const first = segments(path)[0];
  return first !== undefined && SUPPRESSED_ROOTS.includes(first);
}

/**
 * The shared-content page whose first landing shows its content before
 * asking: `/m/:slug`. A meme's image already carries its creator's name, so
 * it is worth seeing as it is. A fact page is not one (identity-flow Phase 4,
 * David 2026-11-04): a fact is a template with nothing to show until it has a
 * name, so `/facts/:id` asks on arrival like every other page.
 */
export function isLandingExceptionPath(path: string): boolean {
  const s = segments(path);
  return s.length === 2 && s[0] === "m";
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

/** A signed-in account's identity is complete: a name and pronouns, both on the account. */
export function isAccountComplete(displayName: string | null | undefined, pronouns: string | null | undefined): boolean {
  return !!displayName?.trim() && !!pronouns?.trim();
}

export interface IdentityDecisionInput {
  auth: IdentityAuthState;
  completeness: IdentityCompleteness;
  /** A signed-in account's display name. */
  accountDisplayName?: string | null;
  /** A signed-in account's pronouns. */
  accountPronouns?: string | null;
  /**
   * Whether the signed-in account is set up (verified and onboarded). An
   * account that is not is never asked here: onboarding is where it answers,
   * and the server refuses its identity writes until then.
   */
  accountEligible?: boolean;
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
  /**
   * An in-page action is waiting for a complete identity (Phase 3,
   * `askBefore`). While it waits, the landing page asks too: the visitor
   * asked to do something, so the content-first exception has done its job.
   */
  actionPending?: boolean;
}

/** Whether the identity sheet should be open right now. */
export function shouldAskForIdentity(input: IdentityDecisionInput): boolean {
  const { auth, completeness, accountDisplayName, location, landingLocation, landingLapsed } = input;
  if (auth === "loading") return false;
  if (isSuppressedPath(location)) return false;
  if (!input.actionPending && !landingLapsed && location === landingLocation && isLandingExceptionPath(landingLocation)) {
    return false;
  }
  if (auth === "signedIn") {
    // Identity-flow Phase 2: a set-up account is complete when the ACCOUNT
    // has both a name and pronouns, whatever the browser holds; one missing
    // either is asked once, through the same sheet, and the answer saves to
    // the account. (Phase 1 asked only when neither held a name.)
    if (input.accountEligible === false) return false;
    return !isAccountComplete(accountDisplayName, input.accountPronouns);
  }
  return !isIdentityComplete(completeness);
}

/**
 * Whether an in-page action taken now must wait for the identity (Phase 3,
 * `askBefore`): auth is still unknown, or the sheet would ask on this page
 * once the action is pending. False means it runs at once: the identity is
 * complete, the page never asks, or the account is not set up yet and
 * onboarding is where it answers.
 */
export function mustWaitForIdentity(input: Omit<IdentityDecisionInput, "actionPending">): boolean {
  return input.auth === "loading" || shouldAskForIdentity({ ...input, actionPending: true });
}

/**
 * Whether a page may render personalized content (a fact read with the
 * visitor's name) now, identity-flow Phase 4. False while the identity that
 * would render is not known to be there yet: auth unknown with an incomplete
 * browser identity, the sheet about to ask or asking, or a complete signed-in
 * account whose name the browser copy has not received yet. True otherwise,
 * including an account onboarding has not finished, which the sheet never
 * asks. The fact page shows its loading surface until it holds, so a fact is
 * never shown as "__".
 */
export function canShowPersonalizedContent(input: Omit<IdentityDecisionInput, "actionPending">): boolean {
  const { auth, completeness } = input;
  if (auth === "loading") return isIdentityComplete(completeness);
  if (shouldAskForIdentity({ ...input, actionPending: false })) return false;
  if (auth === "signedIn" && isAccountComplete(input.accountDisplayName, input.accountPronouns)) {
    return completeness.hasName;
  }
  return true;
}

/**
 * Whether a builder may initialize its draft from the identity now. A builder
 * copies the identity once, at mount, so it starts only from a complete one.
 * A signed-out arrival needs a complete browser identity; a signed-in one, a
 * complete account (Phase 2).
 */
export function canStartBuilder(
  auth: IdentityAuthState,
  completeness: IdentityCompleteness,
  accountComplete = true,
): boolean {
  if (auth === "loading") return false;
  // A signed-in builder starts only from a complete account (Phase 2).
  if (auth === "signedIn") return accountComplete;
  return isIdentityComplete(completeness);
}
