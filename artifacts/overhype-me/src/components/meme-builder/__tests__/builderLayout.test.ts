import { describe, expect, it } from "vitest";
import { chooseBuilderLayout, previewWidths } from "../hooks/useWideBuilderLayout";

// Issue #850, amendment 1 (David, Q31: 1): the arrangement that shows the
// picture larger wins. Amendment 2: the stacked cap is always 38% of the
// screen, a short sideways screen goes side by side, and a turn chooses afresh.

describe("chooseBuilderLayout", () => {
  const table: Array<[string, { w: number; h: number }, "landscape" | "square" | "portrait", "wide" | "stacked"]> = [
    ["phone, landscape", { w: 390, h: 844 }, "landscape", "stacked"],
    ["phone, portrait", { w: 390, h: 844 }, "portrait", "stacked"],
    ["phone, square", { w: 390, h: 844 }, "square", "stacked"],
    ["phone on its side, landscape", { w: 844, h: 390 }, "landscape", "wide"],
    ["phone on its side, square", { w: 844, h: 390 }, "square", "wide"],
    ["phone on its side, portrait", { w: 844, h: 390 }, "portrait", "wide"],
    ["small phone on its side, landscape (iPhone SE)", { w: 667, h: 375 }, "landscape", "wide"],
    ["small phone upright, landscape (iPhone SE)", { w: 375, h: 667 }, "landscape", "stacked"],
    ["narrow desktop window, portrait", { w: 1000, h: 1200 }, "portrait", "wide"],
    ["big iPad upright, landscape (David's screenshot)", { w: 1024, h: 1366 }, "landscape", "stacked"],
    ["big iPad upright, portrait", { w: 1024, h: 1366 }, "portrait", "wide"],
    ["iPad upright, square", { w: 820, h: 1180 }, "square", "stacked"],
    ["iPad on its side, landscape", { w: 1180, h: 820 }, "landscape", "wide"],
    ["iPad on its side, square", { w: 1180, h: 820 }, "square", "wide"],
    ["iPad on its side, portrait", { w: 1180, h: 820 }, "portrait", "wide"],
    ["desktop, landscape", { w: 1440, h: 900 }, "landscape", "wide"],
    ["desktop, portrait", { w: 1440, h: 900 }, "portrait", "wide"],
    // Codex F2 on PR #1258: stacked stops at the canvas's own 1280 px.
    ["very large upright screen, landscape", { w: 1920, h: 2400 }, "landscape", "wide"],
  ];
  for (const [name, v, shape, expected] of table) {
    it(`${name} → ${expected}`, () => {
      expect(chooseBuilderLayout(v, shape)).toBe(expected);
    });
  }

  it("never counts a stacked picture wider than the canvas's own pixels", () => {
    expect(previewWidths({ w: 1920, h: 2400 }, "landscape").stacked).toBe(1280);
    expect(previewWidths({ w: 1600, h: 2400 }, "landscape").stacked).toBe(1280);
  });

  it("picks the arrangement whose picture is wider, from scratch", () => {
    const v = { w: 1024, h: 1366 };
    const widths = previewWidths(v, "landscape");
    expect(widths.stacked).toBeGreaterThan(widths.wide);
    expect(widths.stacked).toBeGreaterThan(900);
  });

  it("keeps the current arrangement near a tie, and switches past the 10% margin", () => {
    // Find a viewport width where the two are within 10% of each other.
    const h = 900;
    let tie: number | null = null;
    for (let w = 900; w <= 1600; w += 2) {
      const ws = previewWidths({ w, h }, "landscape");
      const ratio = ws.wide / ws.stacked;
      if (ratio > 1 && ratio < 1.1) { tie = w; break; }
    }
    expect(tie).not.toBeNull();
    const v = { w: tie!, h };
    expect(chooseBuilderLayout(v, "landscape")).toBe("wide");
    expect(chooseBuilderLayout(v, "landscape", "stacked")).toBe("stacked");
    expect(chooseBuilderLayout({ w: 1440, h }, "landscape", "stacked")).toBe("wide");
  });

  it("an upright phone always stacks: the column beside the controls is too narrow to win", () => {
    for (const shape of ["landscape", "square", "portrait"] as const) {
      expect(chooseBuilderLayout({ w: 390, h: 844 }, shape)).toBe("stacked");
      expect(chooseBuilderLayout({ w: 390, h: 844 }, shape, "wide")).toBe("stacked");
    }
  });

  it("a short sideways screen goes side by side for every shape, even when stacked would be larger or is current", () => {
    for (const v of [{ w: 667, h: 375 }, { w: 852, h: 393 }, { w: 932, h: 430 }]) {
      for (const shape of ["landscape", "square", "portrait"] as const) {
        expect(chooseBuilderLayout(v, shape)).toBe("wide");
        expect(chooseBuilderLayout(v, shape, "stacked")).toBe("wide");
      }
    }
    // The iPhone SE case from the build report: stacked is the larger picture there.
    const se = previewWidths({ w: 667, h: 375 }, "landscape");
    expect(se.stacked).toBeGreaterThan(se.wide);
  });

  it("a short window too narrow for both columns falls back to the size rule and stacks (Astra C8)", () => {
    for (const shape of ["landscape", "square", "portrait"] as const) {
      expect(chooseBuilderLayout({ w: 390, h: 480 }, shape)).toBe("stacked");
    }
  });
});
