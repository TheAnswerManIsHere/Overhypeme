import { useRef } from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WizardPrimaryAction } from "../WizardPrimaryAction";

/**
 * Regression: `buttonRef` must resolve to the primary CTA specifically, not
 * "whichever button happens to render first." `aboveAction` can render its
 * own buttons (the visibility toggle does) — a caller that instead grabbed
 * the first `<button>` in DOM order would focus one of those after Step2Image
 * mounts it above the CTA, which is exactly the bug this ref replaced.
 */
function Harness({ aboveAction }: { aboveAction?: React.ReactNode }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <WizardPrimaryAction
        label="Make my meme"
        onClick={() => {}}
        buttonRef={buttonRef}
        aboveAction={aboveAction}
      />
      <button
        type="button"
        data-testid="focus-primary"
        onClick={() => buttonRef.current?.focus()}
      >
        trigger
      </button>
    </>
  );
}

describe("WizardPrimaryAction buttonRef", () => {
  it("resolves to the primary CTA when there is no aboveAction content", () => {
    render(<Harness />);
    screen.getByTestId("focus-primary").click();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Make my meme" }));
  });

  it("still resolves to the primary CTA when aboveAction renders its own buttons first in DOM order", () => {
    render(
      <Harness
        aboveAction={
          <div>
            <button type="button">Public</button>
            <button type="button">Private</button>
          </div>
        }
      />,
    );
    screen.getByTestId("focus-primary").click();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Make my meme" }));
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Public" }));
  });
});
