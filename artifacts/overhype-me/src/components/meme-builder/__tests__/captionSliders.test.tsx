/**
 * #1260: the position sliders stopped at limits worked out from a guess, so in
 * portrait the top slider's limit read 51% and the bottom's 72% while the two
 * blocks were drawn over each other. The sliders now take their range and
 * their number from the layout the preview draws.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { captionLayout, memeCaption, type CaptionLayout } from "@workspace/api-zod";
import { sliderRange } from "../captionLayout";
import { AdjustTextSheet } from "../wizard/step2-image/AdjustTextSheet";

// Radix's slider measures its thumb with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const measure = (text: string, size: number) => text.length * size * 0.5;
const topText = "When David Franklin does pushups, he doesn't push himself up –";
const bottomText = "He pushes the Earth down.";
const layoutAt = (topY: number, bottomY: number): CaptionLayout =>
  captionLayout(measure, {
    aspectRatio: "portrait",
    caption: memeCaption("", { topText, bottomText }, "David Franklin", "he/him"),
    style: { topY, bottomY },
  });

describe("sliderRange", () => {
  it("is null for a block that is not drawn", () => {
    expect(sliderRange(undefined)).toBeNull();
  });

  it("offers only positions the drawing leaves exactly where they are", () => {
    const layout = layoutAt(17, 88);
    const top = sliderRange(layout.blocks[0])!;
    const bottom = sliderRange(layout.blocks[1])!;
    expect(top.min).toBeGreaterThan(17); // the five-line block cannot sit at the 17% default: it is drawn lower, and the slider says so
    expect(top.value).toBe(top.min);
    for (const v of [top.min, top.max]) {
      expect(layoutAt(v, layout.blocks[1]!.yPct).blocks[0]!.yPct).toBeCloseTo(v, 9);
    }
    for (const v of [bottom.min, bottom.max]) {
      expect(layoutAt(layout.blocks[0]!.yPct, v).blocks[1]!.yPct).toBeCloseTo(v, 9);
    }
  });

  it("stops the top slider where the top block meets the bottom block", () => {
    const layout = layoutAt(17, 72);
    const top = sliderRange(layout.blocks[0])!;
    const atLimit = layoutAt(top.max, layout.blocks[1]!.yPct);
    expect(atLimit.blocks[0]!.inkBottom).toBeLessThan(atLimit.blocks[1]!.inkTop);
    // One more step would touch the bottom block, which is why the slider ends here.
    const past = top.max + 1;
    expect(past).toBeGreaterThan(layout.blocks[0]!.maxPct);
  });

  it("collapses to where the block is when it has no whole-number room to move", () => {
    const block = { ...layoutAt(17, 88).blocks[0]!, minPct: 40.2, maxPct: 40.8, yPct: 40.5 };
    expect(sliderRange(block)).toEqual({ min: 41, max: 41, value: 41 });
  });
});

describe("AdjustTextSheet position sliders", () => {
  const open = (layout: CaptionLayout | null, onTextOptionsChange = vi.fn()) => {
    render(
      <AdjustTextSheet
        factText={`${topText} ${bottomText}`}
        defaultSplitIndex={10}
        splitIndex={10}
        onSplitChange={() => {}}
        textOptions={{ topY: 51, bottomY: 72 }}
        onTextOptionsChange={onTextOptionsChange}
        captionLayout={layout}
      />,
    );
    fireEvent.click(screen.getByTestId("adjust-text-trigger"));
    return screen.getAllByRole("slider");
  };

  it("runs each slider over the range the layout gives and shows where the block is drawn", () => {
    const layout = layoutAt(51, 72);
    const [, , top, bottom] = open(layout);
    const t = sliderRange(layout.blocks[0])!;
    const b = sliderRange(layout.blocks[1])!;
    expect(top!.getAttribute("aria-valuemin")).toBe(String(t.min));
    expect(top!.getAttribute("aria-valuemax")).toBe(String(t.max));
    expect(top!.getAttribute("aria-valuenow")).toBe(String(t.value));
    expect(bottom!.getAttribute("aria-valuemin")).toBe(String(b.min));
    expect(bottom!.getAttribute("aria-valuemax")).toBe(String(b.max));
    expect(bottom!.getAttribute("aria-valuenow")).toBe(String(b.value));
    // David's screenshot: stored 51% and 72% overlap, so neither is where its block is drawn.
    expect(layout.blocks[0]!.yPct).toBeLessThan(51);
    expect(layout.blocks[1]!.yPct).toBeGreaterThan(72);
  });

  it("falls back to the whole track before the caption face has loaded", () => {
    const [, , top, bottom] = open(null);
    expect(top!.getAttribute("aria-valuemin")).toBe("0");
    expect(top!.getAttribute("aria-valuemax")).toBe("100");
    expect(top!.getAttribute("aria-valuenow")).toBe("51");
    expect(bottom!.getAttribute("aria-valuenow")).toBe("72");
  });

  it("orders its controls split, font size, top position, bottom position, and the font size slider sets the font size", () => {
    const onTextOptionsChange = vi.fn();
    const sliders = open(null, onTextOptionsChange);
    expect(sliders).toHaveLength(4);
    const labels = [...document.querySelectorAll("span.uppercase.tracking-wider")].map((el) => el.textContent?.trim().toUpperCase());
    expect(labels.filter((l) => /SPLIT|FONT SIZE|TOP POSITION|BOTTOM POSITION/.test(l ?? ""))).toEqual(["SPLIT POSITION", "FONT SIZE", "TOP POSITION", "BOTTOM POSITION"]);
    const font = sliders[1]!;
    expect(font.getAttribute("aria-valuemin")).toBe("32");
    expect(font.getAttribute("aria-valuemax")).toBe("120");
    fireEvent.keyDown(font, { key: "End" });
    expect(onTextOptionsChange).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 120, topY: 51, bottomY: 72 }));
  });
});
