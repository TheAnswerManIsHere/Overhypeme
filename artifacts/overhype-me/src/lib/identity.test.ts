import { describe, expect, it } from "vitest";
import {
  canStartBuilder,
  isIdentityComplete,
  isLandingExceptionPath,
  isSuppressedPath,
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
    ...over,
  });
}

describe("isSuppressedPath", () => {
  it.each(["/login", "/onboard", "/forgot-password", "/reset-password", "/verify-email", "/admin", "/admin/facts", "/login?x=1"])(
    "suppresses %s",
    (p) => expect(isSuppressedPath(p)).toBe(true),
  );
  it.each(["/", "/loginx", "/administrator", "/search", "/facts/1", "/profile"])(
    "does not suppress %s",
    (p) => expect(isSuppressedPath(p)).toBe(false),
  );
});

describe("isLandingExceptionPath", () => {
  it.each(["/m/abc", "/video/12", "/facts/7"])("treats %s as a landing page", (p) =>
    expect(isLandingExceptionPath(p)).toBe(true),
  );
  it.each(["/facts/7/meme", "/m", "/", "/search", "/video"])("does not treat %s as a landing page", (p) =>
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
    expect(ask({ location: "/video/3", landingLocation: "/video/3" })).toBe(false);
  });

  it("asks once the visitor leaves the landing page", () => {
    expect(ask({ location: "/", landingLocation: "/m/abc" })).toBe(true);
    expect(ask({ location: "/facts/8", landingLocation: "/facts/7" })).toBe(true);
  });

  it("asks on a builder sub-route even when the visit landed there", () => {
    expect(ask({ location: "/facts/7/meme", landingLocation: "/facts/7/meme" })).toBe(true);
  });

  it("asks a signed-in visitor only when neither the account nor the browser holds a name (Phase 1)", () => {
    expect(ask({ auth: "signedIn", completeness: NONE, accountDisplayName: null })).toBe(true);
    expect(ask({ auth: "signedIn", completeness: NONE, accountDisplayName: "  " })).toBe(true);
    expect(ask({ auth: "signedIn", completeness: NONE, accountDisplayName: "Ada" })).toBe(false);
    expect(ask({ auth: "signedIn", completeness: NAME_ONLY, accountDisplayName: null })).toBe(false);
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
  it("leaves signed-in builders ungated in Phase 1", () => {
    expect(canStartBuilder("signedIn", NONE)).toBe(true);
  });
});
