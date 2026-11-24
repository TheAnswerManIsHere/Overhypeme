/**
 * Launch Phase 14, increment 4: the browser's under-18 mark is lifted only by
 * an account support has corrected, never by a fresh sign-up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isAgeRefusedBrowser, isCorrectedAdult, liftAgeRefusalIfCorrected, markAgeRefusedBrowser } from "./age-refusal";

describe("the adults-only browser mark", () => {
  beforeEach(() => window.localStorage.clear());

  it("is lifted by a corrected account: not under age and 18+ by a stored date", () => {
    markAgeRefusedBrowser();
    liftAgeRefusalIfCorrected({ eligibility: "unonboarded", is18Plus: true });
    expect(isAgeRefusedBrowser()).toBe(false);
  });

  it("stays for a fresh sign-up, which has no stored date", () => {
    markAgeRefusedBrowser();
    liftAgeRefusalIfCorrected({ eligibility: "unonboarded", is18Plus: false });
    liftAgeRefusalIfCorrected({ eligibility: "unverified", is18Plus: null });
    liftAgeRefusalIfCorrected(null);
    expect(isAgeRefusedBrowser()).toBe(true);
  });

  it("stays for an account still under age, whatever else it reports", () => {
    markAgeRefusedBrowser();
    liftAgeRefusalIfCorrected({ eligibility: "underage", is18Plus: true });
    expect(isAgeRefusedBrowser()).toBe(true);
  });

  it("names the corrected state exactly", () => {
    expect(isCorrectedAdult({ eligibility: "eligible", is18Plus: true })).toBe(true);
    expect(isCorrectedAdult({ eligibility: "underage", is18Plus: false })).toBe(false);
    expect(isCorrectedAdult(undefined)).toBe(false);
  });
});
