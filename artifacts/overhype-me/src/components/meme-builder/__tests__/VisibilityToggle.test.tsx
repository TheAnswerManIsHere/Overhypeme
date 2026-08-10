import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { VisibilityToggle } from "../parts/VisibilityToggle";

/**
 * Regression coverage for the dropped privacy control (the toggle existed only
 * in the retired single-file builder, so every meme saved through the shipped
 * builders was public).
 *
 * The load-bearing property is the tier lock: privacy is Legendary-level and
 * `createMemeRecord` rejects an explicit `isPublic: false` from anyone below it
 * with a 403, so a lower tier must never be able to *select* Private —
 * otherwise the UI offers a choice the save would refuse.
 */
describe("VisibilityToggle", () => {
  it("defaults to public and lets a legendary viewer switch to private", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <VisibilityToggle isPublic onChange={onChange} tier="legendary" onRequestUpgrade={() => {}} />,
    );

    expect(screen.getByTestId("meme-visibility-public").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByTestId("meme-visibility-private"));
    expect(onChange).toHaveBeenCalledWith(false);

    rerender(
      <VisibilityToggle
        isPublic={false}
        onChange={onChange}
        tier="legendary"
        onRequestUpgrade={() => {}}
      />,
    );
    expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/only you/i)).toBeTruthy();
  });

  it("switches back to public", () => {
    const onChange = vi.fn();
    render(
      <VisibilityToggle
        isPublic={false}
        onChange={onChange}
        tier="legendary"
        onRequestUpgrade={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("meme-visibility-public"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("locks private for a registered viewer: upsells instead of selecting", () => {
    const onChange = vi.fn();
    const onRequestUpgrade = vi.fn();
    render(
      <VisibilityToggle
        isPublic
        onChange={onChange}
        tier="registered"
        onRequestUpgrade={onRequestUpgrade}
      />,
    );

    const privateBtn = screen.getByTestId("meme-visibility-private");
    expect(privateBtn.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("LEGEND")).toBeTruthy();

    fireEvent.click(privateBtn);
    expect(onRequestUpgrade).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never reports private for a locked tier, even if handed isPublic=false", () => {
    // Defence in depth: a stale draft or a caller bug must not render a
    // "Private" state — the server would now reject an unentitled caller's
    // explicit request with a 403 rather than silently flipping it back to
    // public, but this component still must not display private as active
    // for a tier its own tier-only lock treats as unentitled.
    render(
      <VisibilityToggle
        isPublic={false}
        onChange={() => {}}
        tier="registered"
        onRequestUpgrade={() => {}}
      />,
    );
    expect(screen.getByTestId("meme-visibility-private").getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/only you/i)).toBeNull();
  });
});
