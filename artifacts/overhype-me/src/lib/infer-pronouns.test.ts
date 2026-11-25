import { describe, it, expect } from "vitest";
import { inferPronounsFromName } from "./infer-pronouns";

describe("inferPronounsFromName", () => {
  it("returns 'he/him' for known male first names (case-insensitive)", () => {
    expect(inferPronounsFromName("david")).toBe("he/him");
    expect(inferPronounsFromName("David")).toBe("he/him");
    expect(inferPronounsFromName("DAVID")).toBe("he/him");
  });

  it("returns 'she/her' for known female first names", () => {
    expect(inferPronounsFromName("raena")).toBe("she/her");
    expect(inferPronounsFromName("Raena")).toBe("she/her");
  });

  it("uses only the first whitespace-delimited token as the lookup key", () => {
    expect(inferPronounsFromName("David Franklin")).toBe("he/him");
    expect(inferPronounsFromName("Raena   van der Berg")).toBe("she/her");
  });

  it("trims leading whitespace", () => {
    expect(inferPronounsFromName("   david")).toBe("he/him");
  });

  it("returns null for unknown names", () => {
    expect(inferPronounsFromName("Zorblax")).toBe(null);
  });

  it("returns null when the first token is shorter than 2 characters", () => {
    expect(inferPronounsFromName("a")).toBe(null);
  });

  it("returns null when the first token is 2+ chars but not in either set (e.g. 'J.')", () => {
    expect(inferPronounsFromName("D. Franklin")).toBe(null);
  });

  it("returns null for an empty string", () => {
    expect(inferPronounsFromName("")).toBe(null);
  });

  // Kept under David's Q27 (Issue #983): Taylor is a name in both pronoun lists, which none of the four is.
  it("returns null for a name that maps to a unisex/ambiguous token (e.g. 'Taylor')", () => {
    // "taylor" is in BOTH sets — male is checked first, so this returns "he/him".
    // Test pins the existing behaviour so future reordering is a deliberate choice.
    expect(inferPronounsFromName("Taylor")).toBe("he/him");
  });
});
