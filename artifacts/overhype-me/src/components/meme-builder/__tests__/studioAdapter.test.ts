import { describe, it, expect } from "vitest";
import { roleToIdentity } from "../integration/studioAdapter";

describe("roleToIdentity", () => {
  // This is an IDENTITY mapper, not a permission check. It replaced
  // `roleToTier`, whose admin → legendary collapse is the PR #402 bug: the
  // builder offered a Private pill on the strength of it while the save path
  // resolved the entitlement differently. Entitlements now arrive from the
  // server; nothing derives them from this.
  it("collapses anonymous and unregistered to unregistered", () => {
    expect(roleToIdentity("anonymous")).toBe("unregistered");
    expect(roleToIdentity("unregistered")).toBe("unregistered");
  });

  it("passes registered through unchanged", () => {
    expect(roleToIdentity("registered")).toBe("registered");
  });

  it("maps legendary and admin to legendary", () => {
    expect(roleToIdentity("legendary")).toBe("legendary");
    expect(roleToIdentity("admin")).toBe("legendary");
  });

  it("treats unknown / missing roles as unregistered (defensive default)", () => {
    expect(roleToIdentity(undefined)).toBe("unregistered");
    expect(roleToIdentity("alien-tier")).toBe("unregistered");
  });
});
