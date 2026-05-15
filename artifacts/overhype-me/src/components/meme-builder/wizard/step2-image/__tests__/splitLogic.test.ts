import { describe, it, expect } from "vitest";
import {
  computeTextCollisionConstraints,
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

describe("computeTextCollisionConstraints", () => {
  it("clamps maxTopY below the bottom-block boundary", () => {
    const { maxTopY, minBottomY } = computeTextCollisionConstraints({
      topLines: 2,
      fontSize: 64,
      canvasH: 720,
      topY: 17,
      bottomY: 88,
    });
    // The top block occupies ~20% of canvas height; maxTopY = floor(88 - ~20) ≈ 68
    expect(maxTopY).toBeGreaterThan(50);
    expect(maxTopY).toBeLessThan(80);
    // minBottomY = ceil(17 + ~20) ≈ 38
    expect(minBottomY).toBeGreaterThan(30);
    expect(minBottomY).toBeLessThan(50);
  });

  it("never returns out-of-range values", () => {
    const { maxTopY, minBottomY } = computeTextCollisionConstraints({
      topLines: 10,
      fontSize: 80,
      canvasH: 720,
      topY: 0,
      bottomY: 100,
    });
    expect(maxTopY).toBeGreaterThanOrEqual(0);
    expect(minBottomY).toBeLessThanOrEqual(100);
  });
});
