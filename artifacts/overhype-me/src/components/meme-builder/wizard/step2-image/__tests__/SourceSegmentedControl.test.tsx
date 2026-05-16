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
  const onRequestSignup = vi.fn();
  const onRequestUpgrade = vi.fn();
  render(
    <SourceSegmentedControl
      active="stock"
      tier="registered"
      onSelect={onSelect}
      onRequestSignup={onRequestSignup}
      onRequestUpgrade={onRequestUpgrade}
      {...overrides}
    />,
  );
  return { onSelect, onRequestSignup, onRequestUpgrade };
}

describe("SourceSegmentedControl", () => {
  it("renders all three tabs", () => {
    renderControl();
    expect(screen.getByTestId("source-tab-stock")).toBeTruthy();
    expect(screen.getByTestId("source-tab-self-upload")).toBeTruthy();
    expect(screen.getByTestId("source-tab-ai-you")).toBeTruthy();
  });

  it("anonymous users see Your photo as locked → triggers signup", () => {
    const { onRequestSignup, onSelect } = renderControl({ tier: "unregistered" });
    fireEvent.click(screen.getByTestId("source-tab-self-upload"));
    expect(onRequestSignup).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("free users see AI as locked → triggers upgrade", () => {
    const { onRequestUpgrade, onSelect } = renderControl({ tier: "registered" });
    fireEvent.click(screen.getByTestId("source-tab-ai-you"));
    expect(onRequestUpgrade).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("legendary users see all three tabs unlocked", () => {
    const { onSelect, onRequestUpgrade, onRequestSignup } = renderControl({
      tier: "legendary",
    });
    fireEvent.click(screen.getByTestId("source-tab-ai-you"));
    expect(onSelect).toHaveBeenCalledWith("ai-you");
    expect(onRequestUpgrade).not.toHaveBeenCalled();
    expect(onRequestSignup).not.toHaveBeenCalled();
  });

  it("renders LEGEND badge on locked AI tab for non-legendary", () => {
    renderControl({ tier: "registered" });
    const ai = screen.getByTestId("source-tab-ai-you");
    expect(ai.textContent).toMatch(/LEGEND/);
  });

  it("renders SIGN UP badge on locked Your photo tab for anonymous", () => {
    renderControl({ tier: "unregistered" });
    const photo = screen.getByTestId("source-tab-self-upload");
    expect(photo.textContent).toMatch(/SIGN UP/);
  });
});

describe("pickDefaultSourceTab", () => {
  const cases: [Parameters<typeof pickDefaultSourceTab>[0], boolean, ReturnType<typeof pickDefaultSourceTab>][] = [
    ["unregistered", false, "stock"],
    ["unregistered", true, "stock"],
    ["registered", false, "stock"],
    ["registered", true, "self-upload"],
    ["legendary", false, "stock"],
    ["legendary", true, "ai-you"],
  ];

  for (const [tier, hasPrimary, expected] of cases) {
    it(`${tier} + hasPrimary=${hasPrimary} → ${expected}`, () => {
      expect(pickDefaultSourceTab(tier, hasPrimary)).toBe(expected);
    });
  }
});
