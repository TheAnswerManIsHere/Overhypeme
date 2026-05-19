import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  SourceSegmentedControl,
  pickDefaultSourceTab,
} from "../SourceSegmentedControl";

function renderControl(
  overrides: Partial<React.ComponentProps<typeof SourceSegmentedControl>> = {},
) {
  const onSelect = vi.fn();
  const onRequestUpgrade = vi.fn();
  render(
    <SourceSegmentedControl
      active="stock"
      tier="registered"
      onSelect={onSelect}
      onRequestUpgrade={onRequestUpgrade}
      {...overrides}
    />,
  );
  return { onSelect, onRequestUpgrade };
}

describe("SourceSegmentedControl", () => {
  it("renders all three tabs", () => {
    renderControl();
    expect(screen.getByTestId("source-tab-stock")).toBeTruthy();
    expect(screen.getByTestId("source-tab-self-upload")).toBeTruthy();
    expect(screen.getByTestId("source-tab-ai-you")).toBeTruthy();
  });

  it("anonymous users can click Your photo tab — signup CTA is shown in the panel, not here", () => {
    const { onSelect } = renderControl({ tier: "unregistered" });
    fireEvent.click(screen.getByTestId("source-tab-self-upload"));
    expect(onSelect).toHaveBeenCalledWith("self-upload");
  });

  it("free users see AI as locked → triggers upgrade", () => {
    const { onRequestUpgrade, onSelect } = renderControl({ tier: "registered" });
    fireEvent.click(screen.getByTestId("source-tab-ai-you"));
    expect(onRequestUpgrade).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("legendary users see all three tabs unlocked", () => {
    const { onSelect, onRequestUpgrade } = renderControl({
      tier: "legendary",
    });
    fireEvent.click(screen.getByTestId("source-tab-ai-you"));
    expect(onSelect).toHaveBeenCalledWith("ai-you");
    expect(onRequestUpgrade).not.toHaveBeenCalled();
  });

  it("renders LEGEND badge on locked AI tab for non-legendary", () => {
    renderControl({ tier: "registered" });
    const ai = screen.getByTestId("source-tab-ai-you");
    expect(ai.textContent).toMatch(/LEGEND/);
  });

  it("Your photo tab has no SIGN UP badge for anonymous — signup CTA lives in the panel", () => {
    renderControl({ tier: "unregistered" });
    const photo = screen.getByTestId("source-tab-self-upload");
    expect(photo.textContent).not.toMatch(/SIGN UP/);
  });
});

describe("pickDefaultSourceTab", () => {
  const cases: [Parameters<typeof pickDefaultSourceTab>[0], boolean, ReturnType<typeof pickDefaultSourceTab>][] = [
    ["unregistered", false, "self-upload"],
    ["unregistered", true, "self-upload"],
    ["registered", false, "self-upload"],
    ["registered", true, "self-upload"],
    ["legendary", false, "ai-you"],
    ["legendary", true, "ai-you"],
  ];

  for (const [tier, hasPrimary, expected] of cases) {
    it(`${tier} + hasPrimary=${hasPrimary} → ${expected}`, () => {
      expect(pickDefaultSourceTab(tier, hasPrimary)).toBe(expected);
    });
  }
});
