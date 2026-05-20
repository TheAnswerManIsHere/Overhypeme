import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ActivityRing } from "../ActivityRing";

describe("ActivityRing", () => {
  it("renders with the activity role + label when active", () => {
    render(<ActivityRing />);
    const el = screen.getByRole("status");
    expect(el).toBeTruthy();
    expect(el.getAttribute("aria-label")).toBe("Working");
  });

  it("renders nothing when active=false", () => {
    const { container } = render(<ActivityRing active={false} />);
    expect(container.firstChild).toBeNull();
  });

  it("applies the requested size in pixels", () => {
    render(<ActivityRing size={120} />);
    const el = screen.getByRole("status");
    expect((el as HTMLElement).style.width).toBe("120px");
    expect((el as HTMLElement).style.height).toBe("120px");
  });

  it("includes a spinning ring child for the visual motion cue", () => {
    render(<ActivityRing />);
    const el = screen.getByRole("status");
    // The outer arc has animate-spin; the inner dot has animate-pulse.
    const hasSpin = el.querySelector(".animate-spin") !== null;
    const hasPulse = el.querySelector(".animate-pulse") !== null;
    expect(hasSpin).toBe(true);
    expect(hasPulse).toBe(true);
  });
});
