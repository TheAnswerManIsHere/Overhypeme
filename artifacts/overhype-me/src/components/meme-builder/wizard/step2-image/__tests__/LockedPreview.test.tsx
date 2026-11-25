import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LockedPreview, fitCanvas } from "../LockedPreview";

const baseProps = {
  factText: "FIREARMS CARRY {NAME} FOR PROTECTION.",
  name: "Legendary User",
  pronouns: "he/him",
  backgroundUrl: null,
  textOptions: {},
  aspectRatio: "landscape" as const,
  framingOffset: { x: 0, y: 0 },
  onFramingChange: () => {},
};

describe("LockedPreview", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  // Issue #850, amendment 2: the resize handle is gone, and a height the old
  // handle remembered is deleted so it can never decide the layout again.
  it("renders the canvas with no resize handle", () => {
    render(<LockedPreview {...baseProps} />);
    expect(screen.getByTestId("locked-preview")).toBeTruthy();
    expect(screen.queryByTestId("locked-preview-resize-handle")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("deletes a preview height the old resize handle remembered", () => {
    window.localStorage.setItem("mbfo_locked_preview_max_h", "400");
    render(<LockedPreview {...baseProps} />);
    expect(window.localStorage.getItem("mbfo_locked_preview_max_h")).toBeNull();
  });

  // #881: the preview must show the meme exactly as saved (#870), and the
  // saved meme's watermark can sit in any corner of it. So nothing may be
  // drawn over the preview: the only thing inside its frame is the canvas.
  it("draws nothing over the preview — the drag hint sits outside its frame", () => {
    render(<LockedPreview {...baseProps} backgroundUrl="https://example.com/x.jpg" />);
    const frame = screen.getByTestId("locked-preview");
    const hint = screen.getByText(/drag the photo to reposition/i);
    expect(frame.contains(hint)).toBe(false);
    const drawn = Array.from(frame.querySelectorAll("*")).filter(
      (el) => el.tagName !== "CANVAS" && (el.textContent ?? "").trim() !== "",
    );
    expect(drawn).toEqual([]);
  });

  it("shows the drag hint only once there is a photo to drag", () => {
    render(<LockedPreview {...baseProps} />);
    expect(screen.queryByText(/drag the photo to reposition/i)).toBeNull();
  });

});

describe("fitCanvas (Issue #850: the wide layout's preview fills its area)", () => {
  // Every aspect ratio, in a wide area and a tall one: the fitted canvas keeps
  // its ratio, never exceeds the area, and reaches the area's full width or
  // its full height (less the 1px border each side), so no usable space is left.
  const ratios = { landscape: 1280 / 720, square: 1, portrait: 720 / 1280 };
  const areas = [
    { w: 980, h: 760 },
    { w: 828, h: 1480 },
    { w: 300, h: 300 },
  ];
  for (const [name, ratio] of Object.entries(ratios)) {
    for (const a of areas) {
      it(`${name} in ${a.w}x${a.h}`, () => {
        const f = fitCanvas(a, ratio);
        expect(f.w).toBeLessThanOrEqual(a.w - 2);
        expect(f.h).toBeLessThanOrEqual(a.h - 2);
        expect(Math.abs(f.w / f.h - ratio)).toBeLessThan(0.02);
        const fillsWidth = a.w - 2 - f.w <= 1;
        const fillsHeight = a.h - 2 - f.h <= 1;
        expect(fillsWidth || fillsHeight).toBe(true);
      });
    }
  }

  it("never goes negative in an area smaller than the border", () => {
    expect(fitCanvas({ w: 1, h: 1 }, 1)).toEqual({ w: 0, h: 0 });
  });
});
