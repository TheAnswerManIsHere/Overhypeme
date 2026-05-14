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
      <Step1ArtifactType selected={null} onSelect={() => {}} tier="legendary" />,
    );
    expect(screen.getByRole("heading", { name: /what kind of meme/i })).toBeTruthy();
    expect(screen.getByTestId("step1-image-card")).toBeTruthy();
    expect(screen.getByTestId("step1-video-card")).toBeTruthy();
  });

  it("the crown and video-card chrome render in every state", () => {
    const tiers: Array<"unregistered" | "registered" | "legendary"> = [
      "unregistered",
      "registered",
      "legendary",
    ];
    for (const tier of tiers) {
      const { unmount } = render(
        <Step1ArtifactType selected={null} onSelect={() => {}} tier={tier} />,
      );
      expect(screen.getByTestId("video-card-crown")).toBeTruthy();
      unmount();
    }
  });

  describe("image card", () => {
    it("is tappable for unregistered users", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          tier="unregistered"
        />,
      );
      fireEvent.click(screen.getByTestId("step1-image-card"));
      expect(onSelect).toHaveBeenCalledWith("image");
    });

    it("is tappable for registered users", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          tier="registered"
        />,
      );
      fireEvent.click(screen.getByTestId("step1-image-card"));
      expect(onSelect).toHaveBeenCalledWith("image");
    });

    it("is tappable for legendary users", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          tier="legendary"
        />,
      );
      fireEvent.click(screen.getByTestId("step1-image-card"));
      expect(onSelect).toHaveBeenCalledWith("image");
    });
  });

  describe("video card — unregistered", () => {
    it("renders the locked overlay and 'Go Legendary to unlock'", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          tier="unregistered"
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
          tier="unregistered"
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId("unified-upgrade-modal")).toBeTruthy();
    });
  });

  describe("video card — registered (free)", () => {
    it("renders the locked overlay", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          tier="registered"
        />,
      );
      expect(screen.getByTestId("card-locked-overlay")).toBeTruthy();
    });

    it("clicking opens the upgrade modal", () => {
      const onSelect = vi.fn();
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={onSelect}
          tier="registered"
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByTestId("unified-upgrade-modal")).toBeTruthy();
    });
  });

  describe("video card — legendary", () => {
    it("is tappable and does NOT render the locked overlay", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          tier="legendary"
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
          tier="legendary"
        />,
      );
      fireEvent.click(screen.getByTestId("step1-video-card"));
      expect(onSelect).toHaveBeenCalledWith("video");
    });
  });

  describe("hero examples", () => {
    it("renders the placeholder when the API returns an empty set", () => {
      render(
        <Step1ArtifactType
          selected={null}
          onSelect={() => {}}
          tier="legendary"
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
