import { describe, expect, it } from "vitest";
import {
  canStartBuilder,
  isIdentityComplete,
  isLandingExceptionPath,
  isSuppressedPath,
  mustWaitForIdentity,
  shouldAskForIdentity,
  type IdentityCompleteness,
  type IdentityDecisionInput,
} from "./identity";

const NONE: IdentityCompleteness = { hasName: false, pronounsSupplied: false };
const NAME_ONLY: IdentityCompleteness = { hasName: true, pronounsSupplied: false };
const PRONOUNS_ONLY: IdentityCompleteness = { hasName: false, pronounsSupplied: true };
const COMPLETE: IdentityCompleteness = { hasName: true, pronounsSupplied: true };

function ask(over: Partial<IdentityDecisionInput>): boolean {
  return shouldAskForIdentity({
    auth: "signedOut",
    completeness: NONE,
    location: "/search",
    landingLocation: "/search",
    landingLapsed: false,
    ...over,
  });
}

describe("isSuppressedPath", () => {
  it.each(["/login", "/onboard", "/forgot-password", "/reset-password", "/verify-email", "/admin", "/admin/facts", "/login?x=1", "/account/deletion", "/account/deletion?scheduled=x"])(
    "suppresses %s",
    (p) => expect(isSuppressedPath(p)).toBe(true),
  );
  it.each(["/", "/loginx", "/administrator", "/accounts", "/search", "/facts/1", "/profile"])(
    "does not suppress %s",
    (p) => expect(isSuppressedPath(p)).toBe(false),
  );
});

describe("isLandingExceptionPath", () => {
  it.each(["/m/abc", "/facts/7"])("treats %s as a landing page", (p) =>
    expect(isLandingExceptionPath(p)).toBe(true),
  );
  it.each(["/facts/7/meme", "/m", "/", "/search", "/video/12"])("does not treat %s as a landing page", (p) =>
    expect(isLandingExceptionPath(p)).toBe(false),
  );
});

describe("isIdentityComplete", () => {
  it("needs both a name and supplied pronouns", () => {
    expect(isIdentityComplete(NONE)).toBe(false);
    expect(isIdentityComplete(NAME_ONLY)).toBe(false);
    expect(isIdentityComplete(PRONOUNS_ONLY)).toBe(false);
    expect(isIdentityComplete(COMPLETE)).toBe(true);
  });
});

describe("shouldAskForIdentity", () => {
  it("asks a signed-out visitor with any incomplete identity on an ordinary page", () => {
    for (const c of [NONE, NAME_ONLY, PRONOUNS_ONLY]) {
      expect(ask({ completeness: c })).toBe(true);
    }
    expect(ask({ completeness: NONE, location: "/", landingLocation: "/" })).toBe(true);
  });

  it("never asks for a complete identity", () => {
    expect(ask({ completeness: COMPLETE })).toBe(false);
  });

  it("never asks while auth is loading", () => {
    expect(ask({ auth: "loading" })).toBe(false);
  });

  it("never asks on a suppressed page, but does on a near-miss sibling", () => {
    expect(ask({ location: "/login", landingLocation: "/login" })).toBe(false);
    expect(ask({ location: "/admin/users", landingLocation: "/" })).toBe(false);
    expect(ask({ location: "/loginx", landingLocation: "/loginx" })).toBe(true);
  });

  it("does not ask on the shared-content page the visit landed on", () => {
    expect(ask({ location: "/m/abc", landingLocation: "/m/abc" })).toBe(false);
    expect(ask({ location: "/facts/7", landingLocation: "/facts/7" })).toBe(false);
  });

  it("asks once the visitor leaves the landing page", () => {
    expect(ask({ location: "/", landingLocation: "/m/abc" })).toBe(true);
    expect(ask({ location: "/facts/8", landingLocation: "/facts/7" })).toBe(true);
  });

  it("keeps asking after the visit returns to its landing page (Back, or the app routing there)", () => {
    expect(ask({ location: "/m/abc", landingLocation: "/m/abc", landingLapsed: true })).toBe(true);
    expect(ask({ location: "/facts/7", landingLocation: "/facts/7", landingLapsed: true })).toBe(true);
  });

  // Phase 3: an in-page action on the landing page asks first.
  it("asks on the landing page while an in-page action waits, and only then", () => {
    expect(ask({ location: "/m/abc", landingLocation: "/m/abc", actionPending: true })).toBe(true);
    expect(ask({ location: "/facts/7", landingLocation: "/facts/7", actionPending: true })).toBe(true);
    expect(ask({ location: "/facts/7", landingLocation: "/facts/7", actionPending: false })).toBe(false);
  });

  it("a waiting action never makes a complete identity, a suppressed page or loading auth ask", () => {
    expect(ask({ location: "/m/abc", landingLocation: "/m/abc", actionPending: true, completeness: COMPLETE })).toBe(false);
    expect(ask({ location: "/login", landingLocation: "/m/abc", actionPending: true })).toBe(false);
    expect(ask({ location: "/m/abc", landingLocation: "/m/abc", actionPending: true, auth: "loading" })).toBe(false);
  });

  it("asks on a builder sub-route even when the visit landed there", () => {
    expect(ask({ location: "/facts/7/meme", landingLocation: "/facts/7/meme" })).toBe(true);
  });

  // Phase 2: a set-up account is complete when the ACCOUNT has a name and
  // pronouns, whatever the browser holds.
  it("asks a set-up signed-in account missing a name or pronouns, whatever the browser holds", () => {
    const signedIn = { auth: "signedIn" as const, accountEligible: true };
    expect(ask({ ...signedIn, completeness: NONE, accountDisplayName: null, accountPronouns: "she/her" })).toBe(true);
    expect(ask({ ...signedIn, completeness: COMPLETE, accountDisplayName: "  ", accountPronouns: "she/her" })).toBe(true);
    expect(ask({ ...signedIn, completeness: COMPLETE, accountDisplayName: "Ada", accountPronouns: null })).toBe(true);
    expect(ask({ ...signedIn, completeness: NONE, accountDisplayName: "Ada", accountPronouns: "she/her" })).toBe(false);
  });

  it("never asks an account that is not set up: onboarding is where it answers", () => {
    expect(ask({ auth: "signedIn", accountEligible: false, completeness: NONE, accountDisplayName: null, accountPronouns: null })).toBe(false);
    // /check-email included: the account is not set up there either.
    expect(ask({ auth: "signedIn", accountEligible: false, completeness: NONE, location: "/check-email", landingLocation: "/" })).toBe(false);
  });
});

describe("canStartBuilder", () => {
  it("waits while auth is loading", () => {
    expect(canStartBuilder("loading", COMPLETE)).toBe(false);
  });
  it("starts a signed-out builder only from a complete identity", () => {
    expect(canStartBuilder("signedOut", NONE)).toBe(false);
    expect(canStartBuilder("signedOut", NAME_ONLY)).toBe(false);
    expect(canStartBuilder("signedOut", PRONOUNS_ONLY)).toBe(false);
    expect(canStartBuilder("signedOut", COMPLETE)).toBe(true);
  });
  it("starts a signed-in builder only from a complete account (Phase 2)", () => {
    expect(canStartBuilder("signedIn", NONE, true)).toBe(true);
    expect(canStartBuilder("signedIn", COMPLETE, false)).toBe(false);
  });
});

describe("mustWaitForIdentity (Phase 3: whether an in-page action waits)", () => {
  const base = { auth: "signedOut" as const, completeness: NONE, location: "/facts/7", landingLocation: "/facts/7", landingLapsed: false };
  it("waits on the landing page for an incomplete identity, though arrival never asked", () => {
    expect(mustWaitForIdentity(base)).toBe(true);
  });
  it("waits while auth is still unknown, even for a complete identity", () => {
    expect(mustWaitForIdentity({ ...base, auth: "loading", completeness: COMPLETE })).toBe(true);
  });
  it("runs at once for a complete identity, on a page that never asks, and for an account not yet set up", () => {
    expect(mustWaitForIdentity({ ...base, completeness: COMPLETE })).toBe(false);
    expect(mustWaitForIdentity({ ...base, location: "/login" })).toBe(false);
    expect(mustWaitForIdentity({ ...base, auth: "signedIn", accountEligible: false })).toBe(false);
  });
  it("signed in, waits for the account, not the browser copy", () => {
    expect(mustWaitForIdentity({ ...base, auth: "signedIn", completeness: COMPLETE, accountEligible: true, accountDisplayName: null, accountPronouns: "she/her" })).toBe(true);
    expect(mustWaitForIdentity({ ...base, auth: "signedIn", accountEligible: true, accountDisplayName: "Ada", accountPronouns: "she/her" })).toBe(false);
  });
});
