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
      <UnifiedUpgradeModal open={false} onClose={() => {}} context="private-meme" />,
    );
    expect(screen.queryByTestId("unified-upgrade-modal")).toBeNull();
  });

  it("renders the private-meme headline when context=private-meme", () => {
    render(<UnifiedUpgradeModal open onClose={() => {}} context="private-meme" />);
    expect(screen.getByText(/go legendary to keep memes private/i)).toBeTruthy();
  });

  it("sells only perks Legendary has: no AI-meme promise since PuLID's removal (launch Phase 4, removal 3)", () => {
    render(<UnifiedUpgradeModal open onClose={() => {}} context="detail-upsell" />);
    const text = screen.getByTestId("unified-upgrade-modal").textContent ?? "";
    expect(text).not.toMatch(/\bAI\b|stylize|face in the meme|generation budget/i);
  });

  it("respects the headline override", () => {
    render(
      <UnifiedUpgradeModal
        open
        onClose={() => {}}
        context="private-meme"
        headline="Custom headline"
      />,
    );
    expect(screen.getByText("Custom headline")).toBeTruthy();
  });

  it("CTA navigates to /pricing (MBFO-5 will replace with embedded checkout)", () => {
    render(
      <UnifiedUpgradeModal open onClose={() => {}} context="private-meme" />,
    );
    fireEvent.click(screen.getByTestId("unified-upgrade-cta"));
    expect(goSpy).toHaveBeenCalledWith("/pricing");
  });

  it("'Not now' invokes onClose", () => {
    const onClose = vi.fn();
    render(
      <UnifiedUpgradeModal open onClose={onClose} context="private-meme" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
