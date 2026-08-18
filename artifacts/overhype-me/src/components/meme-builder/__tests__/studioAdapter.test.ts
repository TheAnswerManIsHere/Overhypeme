import { describe, it, expect } from "vitest";
import {
  studioPathToMode,
  roleToIdentity,
  extractObjectPath,
} from "../integration/studioAdapter";

describe("studioPathToMode", () => {
  it("maps stock-image and gradient-image (deprecated soft-redirect) to 'stock'", () => {
    expect(studioPathToMode("stock-image")).toBe("stock");
    expect(studioPathToMode("gradient-image")).toBe("stock");
  });

  it("maps photo-image and ai-gallery to 'self-upload'", () => {
    expect(studioPathToMode("photo-image")).toBe("self-upload");
    expect(studioPathToMode("ai-gallery")).toBe("self-upload");
  });
});

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

describe("extractObjectPath", () => {
  it("returns undefined for null / undefined / empty input", () => {
    expect(extractObjectPath(undefined)).toBeUndefined();
    expect(extractObjectPath(null)).toBeUndefined();
    expect(extractObjectPath("")).toBeUndefined();
  });

  it("returns undefined for external URLs (no storage prefix)", () => {
    expect(extractObjectPath("https://gravatar.com/avatar/abcd")).toBeUndefined();
    expect(extractObjectPath("https://example.com/path/foo.png")).toBeUndefined();
  });

  it("strips the /api/storage prefix and returns /objects/<rest>", () => {
    expect(extractObjectPath("/api/storage/objects/uploads/abc.jpg")).toBe(
      "/objects/uploads/abc.jpg",
    );
  });

  it("handles fully-qualified URLs containing the storage prefix", () => {
    expect(
      extractObjectPath("https://overhype.me/api/storage/objects/uploads/xyz.png"),
    ).toBe("/objects/uploads/xyz.png");
  });

  it("returns undefined when the prefix is present but nothing follows", () => {
    expect(extractObjectPath("/api/storage/objects/")).toBeUndefined();
  });
});
