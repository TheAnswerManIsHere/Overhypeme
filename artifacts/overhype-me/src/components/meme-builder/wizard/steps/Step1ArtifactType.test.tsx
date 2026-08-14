import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Step1ArtifactType } from "./Step1ArtifactType";

// Default to an empty hero-examples response so placeholders render.
function stubEmptyFetch() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ image: [], video: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Step1ArtifactType", () => {
  beforeEach(() => {
    stubEmptyFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the 'What kind of meme?' headline and both cards", () => {
    render(
      <Step1ArtifactType selected={null} onSelect={() => {}} canVideoGeneration={true} />,
    );
    expect(screen.getByRole("heading", { name: /what kind of meme/i })).toBeTruthy();
    expect(screen.getByTestId("step1-image-card")).toBeTruthy();
    expect(screen.getByTestId("step1-video-card")).toBeTruthy();
  });

  it("the crown and video-card chrome render in every state", () => {
    for (const canVideoGeneration of [false, true]) {
      const { unmount } = render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          canVideoGeneration={canVideoGeneration}
        />,
      );
      expect(screen.getByTestId("video-card-crown")).toBeTruthy();
      unmount();
    }
  });

  describe("image card", () => {
    it("is tappable when not entitled to video", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          canVideoGeneration={false}
        />,
      );
      fireEvent.click(screen.getByTestId("step1-image-card"));
      expect(onSelect).toHaveBeenCalledWith("image");
    });

    it("is tappable when entitled to video", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          canVideoGeneration={true}
        />,
      );
      fireEvent.click(screen.getByTestId("step1-image-card"));
      expect(onSelect).toHaveBeenCalledWith("image");
    });
  });

  describe("video card — not entitled", () => {
    it("renders the locked overlay and 'Go Legendary to unlock'", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          canVideoGeneration={false}
        />,
      );
      expect(screen.getByTestId("card-locked-overlay")).toBeTruthy();
      expect(screen.getByText(/go legendary to unlock/i)).toBeTruthy();
    });

    it("clicking the locked video card opens the upgrade modal, not onSelect", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          canVideoGeneration={false}
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId("unified-upgrade-modal")).toBeTruthy();
    });
  });

  describe("video card — entitled", () => {
    it("is tappable and does NOT render the locked overlay", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          canVideoGeneration={true}
        />,
      );
      expect(screen.queryByTestId("card-locked-overlay")).toBeNull();
      expect(screen.queryByTestId("card-budget-reached")).toBeNull();
    });

    it("clicking calls onSelect('video')", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          canVideoGeneration={true}
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).toHaveBeenCalledWith("video");
    });
  });

  // ── The general invariant: this card follows the ENTITLEMENT, not tier.
  // It used to be `tier !== "legendary"` — the same PR #402 shape.
  describe("entitlement invariant", () => {
    it("granted to a non-legendary tier via the grid → tappable, no upgrade modal", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          canVideoGeneration={true}
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).toHaveBeenCalledWith("video");
      expect(screen.queryByTestId("unified-upgrade-modal")).toBeNull();
    });

    it("revoked from legendary via the grid → locked, opens upgrade modal", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          canVideoGeneration={false}
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId("unified-upgrade-modal")).toBeTruthy();
    });
  });

  describe("hero examples", () => {
    it("renders the placeholder when the API returns an empty set", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          canVideoGeneration={true}
        />,
      );
      // Placeholders for both image and video are present (the cards render
      // synchronously while the fetch is pending; once it resolves to empty
      // they remain placeholders).
      expect(screen.getByTestId("hero-example-placeholder-image")).toBeTruthy();
      expect(screen.getByTestId("hero-example-placeholder-video")).toBeTruthy();
    });
  });
});
