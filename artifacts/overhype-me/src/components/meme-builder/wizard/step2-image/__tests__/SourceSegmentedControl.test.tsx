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
      canPulidStylize={false}
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

  it("Your photo tab is always clickable — self-upload's registration requirement is enforced one level up", () => {
    const { onSelect } = renderControl({ canPulidStylize: false });
    fireEvent.click(screen.getByTestId("source-tab-self-upload"));
    expect(onSelect).toHaveBeenCalledWith("self-upload");
  });

  // ── The general invariant: the lock follows the ENTITLEMENT, not a tier.
  // This control used to gate on `tier === "legendary"` — the same PR #402
  // shape everywhere else in this codebase. Proving "legendary sees it
  // unlocked" is not enough; the invariant is that tier alone never decides
  // this, in either direction.

  it("without meme_pulid_stylize, AI is locked → triggers upgrade", () => {
    const { onRequestUpgrade, onSelect } = renderControl({ canPulidStylize: false });
    fireEvent.click(screen.getByTestId("source-tab-ai-you"));
    expect(onRequestUpgrade).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("with meme_pulid_stylize, AI is unlocked — regardless of which tier granted it", () => {
    const { onSelect, onRequestUpgrade } = renderControl({ canPulidStylize: true });
    fireEvent.click(screen.getByTestId("source-tab-ai-you"));
    expect(onSelect).toHaveBeenCalledWith("ai-you");
    expect(onRequestUpgrade).not.toHaveBeenCalled();
  });

  it("renders LEGEND badge on the AI tab exactly when the entitlement is absent", () => {
    renderControl({ canPulidStylize: false });
    const ai = screen.getByTestId("source-tab-ai-you");
    expect(ai.textContent).toMatch(/LEGEND/);
  });

  it("no LEGEND badge once the entitlement is granted", () => {
    renderControl({ canPulidStylize: true });
    const ai = screen.getByTestId("source-tab-ai-you");
    expect(ai.textContent).not.toMatch(/LEGEND/);
  });

  it("Your photo tab has no SIGN UP badge — signup CTA lives in the panel", () => {
    renderControl();
    const photo = screen.getByTestId("source-tab-self-upload");
    expect(photo.textContent).not.toMatch(/SIGN UP/);
  });
});

describe("pickDefaultSourceTab", () => {
  // A UX default only (which tab to show first), not a gate — the control
  // itself now enforces the real lock off the resolved entitlement, so
  // defaulting to "ai-you" for a legendary tier that happens to have had
  // the entitlement revoked just shows that tab in its locked state, same as
  // landing on it any other way.
  const cases: [Parameters<typeof pickDefaultSourceTab>[0], ReturnType<typeof pickDefaultSourceTab>][] = [
    ["unregistered", "self-upload"],
    ["registered", "self-upload"],
    ["legendary", "ai-you"],
  ];

  for (const [tier, expected] of cases) {
    it(`${tier} → ${expected}`, () => {
      expect(pickDefaultSourceTab(tier)).toBe(expected);
    });
  }
});
