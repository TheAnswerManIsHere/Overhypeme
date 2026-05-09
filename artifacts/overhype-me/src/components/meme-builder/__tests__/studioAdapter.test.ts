import { describe, it, expect } from "vitest";
import {
  studioPathToMode,
  roleToTier,
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

describe("roleToTier", () => {
  it("collapses anonymous and unregistered to unregistered", () => {
    expect(roleToTier("anonymous")).toBe("unregistered");
    expect(roleToTier("unregistered")).toBe("unregistered");
  });

  it("passes registered through unchanged", () => {
    expect(roleToTier("registered")).toBe("registered");
  });

  it("maps legendary and admin to legendary", () => {
    expect(roleToTier("legendary")).toBe("legendary");
    expect(roleToTier("admin")).toBe("legendary");
  });

  it("treats unknown / missing roles as unregistered (defensive default)", () => {
    expect(roleToTier(undefined)).toBe("unregistered");
    expect(roleToTier("alien-tier")).toBe("unregistered");
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
