// PR #1313, round 1: My content's AI pictures come from two requests. When the
// finished list fails while a picture is drawing, the section still renders,
// shows the drawing line, and says the list could not load — it does not
// throw and take the page down.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemberPicturesSection } from "./MemberPicturesSection";

const drawing = [{ attemptId: 1, factId: 3, status: "drawing" as const, reason: null, creditReturned: false, aiImageId: null, imageUrl: null, createdAt: "2026-11-25T00:00:00Z" }];

describe("MemberPicturesSection", () => {
  it("a failed finished list with a picture drawing shows the drawing line and says the list could not load", () => {
    render(
      <MemberPicturesSection drawing={drawing} recentlyFailed={[]} list={{ items: undefined, isLoading: false, isError: true }}>
        <p>grid</p>
      </MemberPicturesSection>,
    );
    expect(screen.getByText("Drawing…")).toBeTruthy();
    expect(screen.getByTestId("my-ai-pictures-error").textContent).toContain("Could not load your pictures");
    expect(screen.queryByText("grid")).toBeNull();
  });

  it("a failed finished list with nothing drawing still says so", () => {
    render(
      <MemberPicturesSection drawing={[]} recentlyFailed={[]} list={{ items: undefined, isLoading: false, isError: true }}>
        <p>grid</p>
      </MemberPicturesSection>,
    );
    expect(screen.getByTestId("my-ai-pictures-error")).toBeTruthy();
  });

  it("shows nothing when there is nothing to say", () => {
    const { container } = render(
      <MemberPicturesSection drawing={[]} recentlyFailed={[]} list={{ items: [], isLoading: false, isError: false }}>
        <p>grid</p>
      </MemberPicturesSection>,
    );
    expect(container.textContent).toBe("");
  });
});
