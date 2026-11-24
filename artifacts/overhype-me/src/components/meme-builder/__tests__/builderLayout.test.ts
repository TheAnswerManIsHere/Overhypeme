import { describe, expect, it } from "vitest";
import { chooseBuilderLayout, previewWidths } from "../hooks/useWideBuilderLayout";

// Issue #850, amendment 1 (David, Q31: 1): the arrangement that shows the
// picture larger wins. The stacked cap is the default 38% of the screen.
const cap = (h: number) => Math.floor(h * 0.38);

describe("chooseBuilderLayout", () => {
  const table: Array<[string, { w: number; h: number }, "landscape" | "square" | "portrait", "wide" | "stacked"]> = [
    ["phone, landscape", { w: 390, h: 844 }, "landscape", "stacked"],
    ["phone, portrait", { w: 390, h: 844 }, "portrait", "stacked"],
    ["phone, square", { w: 390, h: 844 }, "square", "stacked"],
    ["phone on its side, landscape", { w: 844, h: 390 }, "landscape", "wide"],
    ["phone on its side, square", { w: 844, h: 390 }, "square", "wide"],
    ["phone on its side, portrait", { w: 844, h: 390 }, "portrait", "wide"],
    ["narrow desktop window, portrait", { w: 1000, h: 1200 }, "portrait", "wide"],
    ["big iPad upright, landscape (David's screenshot)", { w: 1024, h: 1366 }, "landscape", "stacked"],
    ["big iPad upright, portrait", { w: 1024, h: 1366 }, "portrait", "wide"],
    ["iPad upright, square", { w: 820, h: 1180 }, "square", "stacked"],
    ["iPad on its side, landscape", { w: 1180, h: 820 }, "landscape", "wide"],
    ["iPad on its side, square", { w: 1180, h: 820 }, "square", "wide"],
    ["iPad on its side, portrait", { w: 1180, h: 820 }, "portrait", "wide"],
    ["desktop, landscape", { w: 1440, h: 900 }, "landscape", "wide"],
    ["desktop, portrait", { w: 1440, h: 900 }, "portrait", "wide"],
  ];
  for (const [name, v, shape, expected] of table) {
    it(`${name} → ${expected}`, () => {
      expect(chooseBuilderLayout(v, shape, cap(v.h))).toBe(expected);
    });
  }

  it("picks the arrangement whose picture is wider, from scratch", () => {
    const v = { w: 1024, h: 1366 };
    const widths = previewWidths(v, "landscape", cap(v.h));
    expect(widths.stacked).toBeGreaterThan(widths.wide);
    expect(widths.stacked).toBeGreaterThan(900);
  });

  it("keeps the current arrangement near a tie, and switches past the 10% margin", () => {
    // Find a viewport width where the two are within 10% of each other.
    const h = 900;
    let tie: number | null = null;
    for (let w = 900; w <= 1600; w += 2) {
      const ws = previewWidths({ w, h }, "landscape", cap(h));
      const ratio = ws.wide / ws.stacked;
      if (ratio > 1 && ratio < 1.1) { tie = w; break; }
    }
    expect(tie).not.toBeNull();
    const v = { w: tie!, h };
    expect(chooseBuilderLayout(v, "landscape", cap(h))).toBe("wide");
    expect(chooseBuilderLayout(v, "landscape", cap(h), "stacked")).toBe("stacked");
    expect(chooseBuilderLayout({ w: 1440, h }, "landscape", cap(h), "stacked")).toBe("wide");
  });

  it("an upright phone always stacks: the column beside the controls is too narrow to win", () => {
    for (const shape of ["landscape", "square", "portrait"] as const) {
      expect(chooseBuilderLayout({ w: 390, h: 844 }, shape, 320)).toBe("stacked");
      expect(chooseBuilderLayout({ w: 390, h: 844 }, shape, 320, "wide")).toBe("stacked");
    }
  });

  it("a remembered small stacked height favours side by side", () => {
    expect(chooseBuilderLayout({ w: 1024, h: 1366 }, "landscape", 200)).toBe("wide");
  });
});
