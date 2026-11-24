/**
 * @purpose The browser's own mark that someone here answered set-up with a date under 18 (launch Phase 14, increment 4): kept with no expiry and never lifted, carrying no personal data, so a fresh sign-up in the same browser is shown the adults-only screen instead of the date question. The one account let past it is one support has corrected and that has not finished set-up yet. A different browser is an accepted limit (plan, item 4).
 * @subsystem accounts-auth
 */

const KEY = "overhype.ageRefused";

/** Where an under-age account, or a browser marked as one, is sent. */
export const ADULTS_ONLY_PATH = "/account/adults-only";

export function markAgeRefusedBrowser(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Storage refused (private mode): the account's own refusal still holds.
  }
}

/** What the browser learns of the signed-in account: two fields `/auth/user` already carries. */
export interface AgeState {
  eligibility?: string | null;
  is18Plus?: boolean | null;
}

/**
 * True for an account support has corrected and that has not finished set-up:
 * not yet onboarded, yet 18 or over by a stored date. Set-up stores the date
 * in the same write that completes it, so only the correction produces this
 * state — never a fresh sign-up (no date) or an ordinary member (onboarded).
 * It lets that one account past the mark; the mark itself stays.
 */
export function isSupportCorrected(user: AgeState | null | undefined): boolean {
  return !!user && user.eligibility === "unonboarded" && user.is18Plus === true;
}

export function isAgeRefusedBrowser(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
