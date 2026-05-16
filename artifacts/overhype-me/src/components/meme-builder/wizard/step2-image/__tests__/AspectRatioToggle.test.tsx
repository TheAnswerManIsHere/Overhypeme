import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AspectRatioToggle } from "../AspectRatioToggle";

describe("AspectRatioToggle", () => {
  it("renders three radio buttons and marks the active one checked", () => {
    render(<AspectRatioToggle value="landscape" onChange={() => {}} />);
    expect(screen.getByTestId("aspect-landscape").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("aspect-square").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("aspect-portrait").getAttribute("aria-checked")).toBe("false");
  });

  it("calls onChange with the new ratio", () => {
    const onChange = vi.fn();
    render(<AspectRatioToggle value="landscape" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("aspect-portrait"));
    expect(onChange).toHaveBeenCalledWith("portrait");
  });
});
