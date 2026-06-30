import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FactRenderScenarioTile } from "./FactRenderScenarioTile";
import type { RenderScenarioCard } from "@workspace/api-zod";

/**
 * Covers the rendered-image lightbox: a done tile's thumbnail is a button that
 * opens the render at full resolution in a modal, closable by the × button and
 * by Escape.
 */

const DONE_CARD: RenderScenarioCard = {
  key: "generic_t2i",
  label: "Generic (t2i)",
  purpose: "Text-to-image baseline",
  referenceIdentityType: null,
  required: true,
  status: "done",
  stale: false,
  latestAttemptId: 1,
  imageUrl: "/api/admin/reviews/5/renders/rj1/image",
  message: null,
  applicability: null,
};

afterEach(() => cleanup());

describe("FactRenderScenarioTile image lightbox", () => {
  it("opens a full-resolution lightbox when the thumbnail is tapped, and closes it", () => {
    render(<FactRenderScenarioTile reviewId={5} card={DONE_CARD} onRun={vi.fn()} />);

    // No lightbox until tapped.
    expect(screen.queryByTestId("render-scenario-lightbox")).toBeNull();

    fireEvent.click(screen.getByTestId("render-scenario-image-button"));
    const lightbox = screen.getByTestId("render-scenario-lightbox");
    expect(lightbox).toBeTruthy();
    // The full-res image points at the same render URL.
    const fullImg = lightbox.querySelector("img");
    expect(fullImg?.getAttribute("src")).toBe(DONE_CARD.imageUrl);

    // Close via the × button.
    fireEvent.click(screen.getByTestId("render-scenario-lightbox-close"));
    expect(screen.queryByTestId("render-scenario-lightbox")).toBeNull();
  });

  it("closes the lightbox on Escape", () => {
    render(<FactRenderScenarioTile reviewId={5} card={DONE_CARD} onRun={vi.fn()} />);
    fireEvent.click(screen.getByTestId("render-scenario-image-button"));
    expect(screen.getByTestId("render-scenario-lightbox")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("render-scenario-lightbox")).toBeNull();
  });
});
