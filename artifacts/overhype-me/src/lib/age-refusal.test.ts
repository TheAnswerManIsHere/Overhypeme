/**
 * Launch Phase 14, increment 4: the browser's under-18 mark is never lifted;
 * the one account let past it is one support has corrected that has not
 * finished set-up. An ordinary member signing in leaves it in place.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { isAgeRefusedBrowser, isSupportCorrected, markAgeRefusedBrowser } from "./age-refusal";

describe("the adults-only browser mark", () => {
  beforeEach(() => window.localStorage.clear());

  it("lets past only a support-corrected account that has not finished set-up", () => {
    expect(isSupportCorrected({ eligibility: "unonboarded", is18Plus: true })).toBe(true);
  });

  it("does not let past an ordinary member, a fresh sign-up, an unverified or an under-age account", () => {
    expect(isSupportCorrected({ eligibility: "eligible", is18Plus: true })).toBe(false);
    expect(isSupportCorrected({ eligibility: "terms_unaccepted", is18Plus: true })).toBe(false);
    expect(isSupportCorrected({ eligibility: "unonboarded", is18Plus: false })).toBe(false);
    expect(isSupportCorrected({ eligibility: "unverified", is18Plus: null })).toBe(false);
    expect(isSupportCorrected({ eligibility: "underage", is18Plus: true })).toBe(false);
    expect(isSupportCorrected(null)).toBe(false);
  });

  it("is kept with no expiry: nothing here removes it", () => {
    markAgeRefusedBrowser();
    isSupportCorrected({ eligibility: "unonboarded", is18Plus: true });
    isSupportCorrected({ eligibility: "eligible", is18Plus: true });
    expect(isAgeRefusedBrowser()).toBe(true);
  });
});
