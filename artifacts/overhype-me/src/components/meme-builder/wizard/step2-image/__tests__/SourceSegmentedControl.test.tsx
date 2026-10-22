import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SourceSegmentedControl } from "../SourceSegmentedControl";

function renderControl(
  overrides: Partial<React.ComponentProps<typeof SourceSegmentedControl>> = {},
) {
  const onSelect = vi.fn();
  render(<SourceSegmentedControl active="stock" onSelect={onSelect} {...overrides} />);
  return { onSelect };
}

describe("SourceSegmentedControl", () => {
  it("renders the two sources, and no AI tab since PuLID's removal (launch Phase 4, removal 3)", () => {
    renderControl();
    expect(screen.getByTestId("source-tab-self-upload")).toBeTruthy();
    expect(screen.getByTestId("source-tab-stock")).toBeTruthy();
    expect(screen.queryByTestId("source-tab-ai-you")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(2);
  });

  it("Your photo tab is always clickable — self-upload's registration requirement is enforced one level up", () => {
    const { onSelect } = renderControl();
    fireEvent.click(screen.getByTestId("source-tab-self-upload"));
    expect(onSelect).toHaveBeenCalledWith("self-upload");
  });

  it("marks only the active tab selected", () => {
    renderControl({ active: "self-upload" });
    expect(screen.getByTestId("source-tab-self-upload").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("source-tab-stock").getAttribute("aria-selected")).toBe("false");
  });

  it("no tab carries an upsell badge — nothing here is locked", () => {
    renderControl();
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.textContent).not.toMatch(/LEGEND|SIGN UP/);
    }
  });
});
