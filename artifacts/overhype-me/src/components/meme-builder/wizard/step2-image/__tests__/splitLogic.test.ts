import { describe, it, expect } from "vitest";
import {
  getWords,
  intelligentSplit,
} from "../sliders/splitLogic";

describe("getWords", () => {
  it("splits on whitespace and drops empties", () => {
    expect(getWords("  foo   bar baz ")).toEqual(["foo", "bar", "baz"]);
  });
});

describe("intelligentSplit", () => {
  it("returns the word count for very short texts", () => {
    expect(intelligentSplit("just two")).toBe(2);
  });

  it("prefers breaks after sentence-ish punctuation near the middle", () => {
    // 6 words → mid = 3. The third word ends in a comma → keep it as the split.
    const split = intelligentSplit("a quick brown, fox jumps over");
    expect(split).toBe(3);
  });

  it("falls back to the middle when no punctuation is nearby", () => {
    const split = intelligentSplit("a b c d e f g h");
    expect(split).toBe(4);
  });
});
