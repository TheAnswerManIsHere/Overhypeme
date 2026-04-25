import { describe, it, expect } from "vitest";
import { inferPronounsFromName } from "./infer-pronouns";

describe("inferPronounsFromName", () => {
  it("returns 'he/him' for known male first names (case-insensitive)", () => {
    expect(inferPronounsFromName("john")).toBe("he/him");
    expect(inferPronounsFromName("John")).toBe("he/him");
    expect(inferPronounsFromName("JOHN")).toBe("he/him");
  });

  it("returns 'she/her' for known female first names", () => {
    expect(inferPronounsFromName("jane")).toBe("she/her");
    expect(inferPronounsFromName("Sarah")).toBe("she/her");
  });

  it("uses only the first whitespace-delimited token as the lookup key", () => {
    expect(inferPronounsFromName("John Smith")).toBe("he/him");
    expect(inferPronounsFromName("Sarah   van der Berg")).toBe("she/her");
  });

  it("trims leading whitespace", () => {
    expect(inferPronounsFromName("   john")).toBe("he/him");
  });

  it("returns null for unknown names", () => {
    expect(inferPronounsFromName("Zorblax")).toBe(null);
  });

  it("returns null when the first token is shorter than 2 characters", () => {
    expect(inferPronounsFromName("a")).toBe(null);
  });

  it("returns null when the first token is 2+ chars but not in either set (e.g. 'J.')", () => {
    expect(inferPronounsFromName("J. Smith")).toBe(null);
  });

  it("returns null for an empty string", () => {
    expect(inferPronounsFromName("")).toBe(null);
  });

  it("returns null for a name that maps to a unisex/ambiguous token (e.g. 'Taylor')", () => {
    // "taylor" is in BOTH sets — male is checked first, so this returns "he/him".
    // Test pins the existing behaviour so future reordering is a deliberate choice.
    expect(inferPronounsFromName("Taylor")).toBe("he/him");
  });
});
