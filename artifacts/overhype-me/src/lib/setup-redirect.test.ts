/**
 * @purpose Proves the shell sends an unverified account to "check your email" and an un-onboarded one to onboarding with where it was going, an under-age account to the adults-only screen from anywhere, and one without a current Terms acceptance to the accept screen unless it said "not now" this visit; leaves an eligible account and the set-up and sign-in pages alone.
 * @subsystem accounts-auth
 */
import { describe, it, expect } from "vitest";
import { currentDestination, setupRedirectFor } from "./setup-redirect";

describe("setupRedirectFor", () => {
  it("verify first, then onboard, carrying the destination", () => {
    expect(setupRedirectFor("unverified", "/submit")).toBe("/check-email?returnTo=%2Fsubmit");
    expect(setupRedirectFor("unonboarded", "/facts/12?x=1")).toBe("/onboard?returnTo=%2Ffacts%2F12%3Fx%3D1");
  });
  it("an account scheduled for deletion is sent to keep-my-account from anywhere else", () => {
    expect(setupRedirectFor("deletion_pending", "/submit")).toBe("/account/deletion");
    expect(setupRedirectFor("deletion_pending", "/onboarding-tips")).toBe("/account/deletion");
    for (const p of ["/account/deletion", "/account/deletion?scheduled=1", "/login"]) expect(setupRedirectFor("deletion_pending", p)).toBeNull();
  });
  it("a suspended account is sent to the suspended screen from anywhere else", () => {
    expect(setupRedirectFor("suspended", "/submit")).toBe("/account/suspended");
    for (const p of ["/account/suspended", "/login"]) expect(setupRedirectFor("suspended", p)).toBeNull();
  });
  it("the contact page is reachable from every account state (launch Phase 16, increment 5)", () => {
    for (const state of ["suspended", "underage", "deletion_pending", "unverified", "unonboarded", "terms_unaccepted"] as const) {
      expect(setupRedirectFor(state, "/support")).toBeNull();
      expect(setupRedirectFor(state, "/support?category=account")).toBeNull();
    }
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
  // Launch Phase 14, increment 4.
  it("an under-age account is sent to the adults-only screen from anywhere else, the legal pages and support excepted", () => {
    expect(setupRedirectFor("underage", "/submit")).toBe("/account/adults-only");
    expect(setupRedirectFor("underage", "/onboarding-tips")).toBe("/account/adults-only");
    for (const p of ["/account/adults-only", "/account/adults-only?delete=confirm", "/terms", "/privacy", "/support", "/login"]) {
      expect(setupRedirectFor("underage", p)).toBeNull();
    }
  });
  it("an account without a current Terms acceptance is asked, carrying where it was going, until it says not now", () => {
    expect(setupRedirectFor("terms_unaccepted", "/submit")).toBe("/account/terms?returnTo=%2Fsubmit");
    expect(setupRedirectFor("terms_unaccepted", "/submit", { termsDeferred: true })).toBeNull();
    for (const p of ["/account/terms", "/terms", "/privacy"]) expect(setupRedirectFor("terms_unaccepted", p)).toBeNull();
    // "Not now" defers only the Terms question, never another state's screen.
    expect(setupRedirectFor("underage", "/submit", { termsDeferred: true })).toBe("/account/adults-only");
  });
});
