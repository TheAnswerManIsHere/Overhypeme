/**
 * @purpose The browser's own mark that someone here answered set-up with a date under 18 (launch Phase 14, increment 4): kept with no expiry and never lifted, carrying no personal data, so a fresh sign-up in the same browser is shown the adults-only screen instead of the date question. It holds only accounts that have not given an adult date: an account that is not under age and is 18 or over by a stored date (support's correction, or a finished set-up) is never asked the date, so it goes past. A different browser is an accepted limit (plan, item 4).
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
 * True for an account the mark does not hold: not under age, and 18 or over
 * by a stored date. Only set-up completion and support's correction store a
 * date, so a fresh sign-up (no date), an unverified account and an under-age
 * one are held; a corrected account and a finished adult are never asked the
 * date, so they go past. It is checked on every render, removes nothing, and
 * the set-up page and the adults-only screen both use it, so neither sends an
 * account the other would send back.
 */
export function isPastAgeMark(user: AgeState | null | undefined): boolean {
  return !!user && user.eligibility !== "underage" && user.is18Plus === true;
}

export function isAgeRefusedBrowser(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
