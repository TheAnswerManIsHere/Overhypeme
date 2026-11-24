/**
 * @purpose The browser's own mark that someone here answered set-up with a date under 18 (launch Phase 14, increment 4): kept with no expiry, carrying no personal data, so a fresh sign-up in the same browser is shown the adults-only screen instead of the date question. A different browser is an accepted limit (plan, item 4).
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

export function isAgeRefusedBrowser(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
