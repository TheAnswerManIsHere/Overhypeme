/**
 * Launch Phase 14, increment 4: the browser's under-18 mark is never lifted.
 * It holds every account that has not given an adult date (no account, a
 * fresh sign-up, an unverified or under-age one) and lets past an account
 * that is not under age and 18 or over by a stored date — corrected by
 * support, or set-up finished — which is never asked the date.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isAgeRefusedBrowser, isPastAgeMark, markAgeRefusedBrowser } from "./age-refusal";

describe("the adults-only browser mark", () => {
  beforeEach(() => window.localStorage.clear());

  it("lets past an account with an adult date on file: corrected, or set-up finished", () => {
    expect(isPastAgeMark({ eligibility: "unonboarded", is18Plus: true })).toBe(true);
    expect(isPastAgeMark({ eligibility: "eligible", is18Plus: true })).toBe(true);
    expect(isPastAgeMark({ eligibility: "terms_unaccepted", is18Plus: true })).toBe(true);
  });

  it("holds no account, a fresh sign-up, an unverified and an under-age account of either kind", () => {
    expect(isPastAgeMark(null)).toBe(false);
    expect(isPastAgeMark({ eligibility: "unonboarded", is18Plus: false })).toBe(false);
    expect(isPastAgeMark({ eligibility: "unverified", is18Plus: null })).toBe(false);
    expect(isPastAgeMark({ eligibility: "underage", is18Plus: false })).toBe(false);
    expect(isPastAgeMark({ eligibility: "underage", is18Plus: true })).toBe(false);
  });

  it("is kept with no expiry: nothing here removes it", () => {
    markAgeRefusedBrowser();
    isPastAgeMark({ eligibility: "unonboarded", is18Plus: true });
    isPastAgeMark({ eligibility: "eligible", is18Plus: true });
    expect(isAgeRefusedBrowser()).toBe(true);
  });
});
