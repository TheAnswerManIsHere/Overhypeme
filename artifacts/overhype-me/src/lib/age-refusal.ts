/**
 * @purpose The browser's own mark that someone here answered set-up with a date under 18 (launch Phase 14, increment 4): kept with no expiry, carrying no personal data, so a fresh sign-up in the same browser is shown the adults-only screen instead of the date question; lifted only when the signed-in account is one support has corrected — not under age and 18 or over by a stored date, which a fresh sign-up never is. A different browser is an accepted limit (plan, item 4).
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

/** What the browser learns of the signed-in account: the two fields `/auth/user` already carries. */
export interface AgeState {
  eligibility?: string | null;
  is18Plus?: boolean | null;
}

/**
 * True when the account shows a corrected age: not under age, and 18 or over
 * by its stored date of birth. Support's correction is the only way a refused
 * account gets there; a fresh sign-up has no stored date, so it is never true
 * for one, and the mark keeps doing its job.
 */
export function isCorrectedAdult(user: AgeState | null | undefined): boolean {
  return !!user && user.eligibility !== "underage" && user.is18Plus === true;
}

/** Lifts this browser's mark once the signed-in account is a corrected adult. */
export function liftAgeRefusalIfCorrected(user: AgeState | null | undefined): void {
  if (!isCorrectedAdult(user)) return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Storage refused: nothing was marked here either.
  }
}

export function isAgeRefusedBrowser(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
