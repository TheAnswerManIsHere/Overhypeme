import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { UnifiedUpgradeModal, upgradeNavigation } from "./UnifiedUpgradeModal";

describe("UnifiedUpgradeModal", () => {
  let goSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    goSpy = vi.spyOn(upgradeNavigation, "go").mockImplementation(() => {});
  });

  afterEach(() => {
    goSpy.mockRestore();
  });

  it("does not render content when closed", () => {
    render(
      <UnifiedUpgradeModal open={false} onClose={() => {}} context="video-card" />,
    );
    expect(screen.queryByTestId("unified-upgrade-modal")).toBeNull();
  });

  it("renders the video-card headline when context=video-card", () => {
    render(
      <UnifiedUpgradeModal open onClose={() => {}} context="video-card" />,
    );
    expect(screen.getByText(/go legendary to make videos/i)).toBeTruthy();
  });

  it("renders the ai-tab headline when context=ai-tab", () => {
    render(<UnifiedUpgradeModal open onClose={() => {}} context="ai-tab" />);
    expect(screen.getByText(/go legendary to stylize with ai/i)).toBeTruthy();
  });

  it("respects the headline override", () => {
    render(
      <UnifiedUpgradeModal
        open
        onClose={() => {}}
        context="video-card"
        headline="Custom headline"
      />,
    );
    expect(screen.getByText("Custom headline")).toBeTruthy();
  });

  it("CTA navigates to /pricing (MBFO-5 will replace with embedded checkout)", () => {
    render(
      <UnifiedUpgradeModal open onClose={() => {}} context="video-card" />,
    );
    fireEvent.click(screen.getByTestId("unified-upgrade-cta"));
    expect(goSpy).toHaveBeenCalledWith("/pricing");
  });

  it("'Not now' invokes onClose", () => {
    const onClose = vi.fn();
    render(
      <UnifiedUpgradeModal open onClose={onClose} context="video-card" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
