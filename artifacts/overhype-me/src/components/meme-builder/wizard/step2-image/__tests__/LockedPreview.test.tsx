import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LockedPreview } from "../LockedPreview";

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

  it("renders the canvas and a resize handle", () => {
    render(<LockedPreview {...baseProps} />);
    expect(screen.getByTestId("locked-preview")).toBeTruthy();
    expect(screen.getByTestId("locked-preview-resize-handle")).toBeTruthy();
  });

  it("persists the resized height to localStorage on drag", () => {
    render(<LockedPreview {...baseProps} backgroundUrl="https://example.com/x.jpg" />);
    const handle = screen.getByTestId("locked-preview-resize-handle");

    // Mock getBoundingClientRect on the canvas so the resize math has a starting height.
    const canvas = document.querySelector("canvas");
    if (canvas) {
      canvas.getBoundingClientRect = vi.fn(
        () => ({ width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) } as DOMRect),
      );
    }

    fireEvent.mouseDown(handle, { clientY: 100 });
    // Simulate a 60px upward drag.
    fireEvent(window, new MouseEvent("mousemove", { clientY: 40 }));
    fireEvent(window, new MouseEvent("mouseup"));

    // 300 + (40 - 100) = 240
    expect(window.localStorage.getItem("mbfo_locked_preview_max_h")).toBe("240");
  });

  it("clamps the saved height to the 160-1200 range", () => {
    window.localStorage.setItem("mbfo_locked_preview_max_h", "99999");
    render(<LockedPreview {...baseProps} />);
    // Reading it back through readSavedMaxH would clamp; but we can only
    // verify externally that the next write also clamps.
    const handle = screen.getByTestId("locked-preview-resize-handle");
    const canvas = document.querySelector("canvas");
    if (canvas) {
      canvas.getBoundingClientRect = vi.fn(
        () => ({ width: 400, height: 5000, top: 0, left: 0, right: 400, bottom: 5000, x: 0, y: 0, toJSON: () => ({}) } as DOMRect),
      );
    }
    fireEvent.mouseDown(handle, { clientY: 100 });
    fireEvent(window, new MouseEvent("mousemove", { clientY: 50 }));
    fireEvent(window, new MouseEvent("mouseup"));
    const saved = parseInt(window.localStorage.getItem("mbfo_locked_preview_max_h") ?? "", 10);
    expect(saved).toBeLessThanOrEqual(1200);
    expect(saved).toBeGreaterThanOrEqual(160);
  });

  it("double-clicking the handle clears the saved height", () => {
    window.localStorage.setItem("mbfo_locked_preview_max_h", "500");
    render(<LockedPreview {...baseProps} />);
    fireEvent.doubleClick(screen.getByTestId("locked-preview-resize-handle"));
    expect(window.localStorage.getItem("mbfo_locked_preview_max_h")).toBeNull();
  });
});
