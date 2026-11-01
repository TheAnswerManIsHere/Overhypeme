/**
 * @purpose Proves the shell sends an unverified account to "check your email" and an un-onboarded one to onboarding with where it was going, leaves an eligible account and the set-up and sign-in pages alone.
 * @subsystem accounts-auth
 */
import { describe, it, expect } from "vitest";
import { currentDestination, setupRedirectFor } from "./setup-redirect";

describe("setupRedirectFor", () => {
  it("verify first, then onboard, carrying the destination", () => {
    expect(setupRedirectFor("unverified", "/submit")).toBe("/check-email?returnTo=%2Fsubmit");
    expect(setupRedirectFor("unonboarded", "/facts/12?x=1")).toBe("/onboard?returnTo=%2Ffacts%2F12%3Fx%3D1");
  });
  it("an eligible account, or one not signed in, is left where it is", () => {
    expect(setupRedirectFor("eligible", "/submit")).toBeNull();
    expect(setupRedirectFor(undefined, "/submit")).toBeNull();
  });
  it("never redirects away from the set-up and sign-in pages", () => {
    for (const p of ["/onboard", "/onboard?returnTo=%2F", "/check-email", "/verify-email?token=a", "/login", "/forgot-password", "/reset-password?token=a"]) {
      expect(setupRedirectFor("unverified", p)).toBeNull();
      expect(setupRedirectFor("unonboarded", p)).toBeNull();
    }
  });
  it("the destination keeps the raw query the address bar holds", () => {
    expect(currentDestination("/search", "?q=space")).toBe("/search?q=space");
    expect(currentDestination("/search", "?q=a%26b")).toBe("/search?q=a%26b");
    expect(currentDestination("/search", "")).toBe("/search");
    expect(setupRedirectFor("unonboarded", currentDestination("/search", "?q=space"))).toBe("/onboard?returnTo=%2Fsearch%3Fq%3Dspace");
  });
  it("a path that only starts with a set-up page's name is not exempt", () => {
    expect(setupRedirectFor("unonboarded", "/onboarding-tips")).toBe("/onboard?returnTo=%2Fonboarding-tips");
  });
});
