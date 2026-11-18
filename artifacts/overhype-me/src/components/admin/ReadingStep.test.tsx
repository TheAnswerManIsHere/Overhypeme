/**
 * ReadingStep — the Reading step's states (Issue #1018, increment 1.2c-ii):
 * no run → "Write the reading"; pending → live note; failed → why + "Try
 * again"; ok → the draft note, editable, approved as shown, with the research
 * beneath it. Polling never overwrites what the moderator is typing.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { FactReadingView, ReviewReadingView } from "@workspace/api-zod";
import { ReadingStep } from "./ReadingStep";

function run(overrides: Partial<FactReadingView> = {}): FactReadingView {
  return {
    id: 7,
    status: "ok",
    research: {
      references: [{
        phrase: "Shark Week",
        meaning: "A TV week of shark documentaries; here the sharks watch Alex.",
        pictureImplication: "Sharks watching Alex on TV, NOT Alex watching sharks.",
        sources: [{ title: "Shark Week", url: "https://example.com/shark-week" }],
      }],
    },
    draftNote: "Normally people watch sharks; here sharks hold a week for Alex.",
    error: null,
    createdAt: "2026-11-18T00:00:00.000Z",
    completedAt: "2026-11-18T00:01:00.000Z",
    ...overrides,
  };
}
const view = (latest: FactReadingView | null): ReviewReadingView => ({ latest, approved: null });

describe("ReadingStep", () => {
  it("no run: offers to write the reading", async () => {
    const onRetry = vi.fn(async () => {});
    render(<ReadingStep reading={view(null)} onApprove={async () => null} onRetry={onRetry} />);
    await act(async () => { fireEvent.click(screen.getByTestId("reading-start")); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("pending: says the fact is being read, live, with no approve", () => {
    render(<ReadingStep reading={view(run({ status: "pending", draftNote: null, research: null }))} onApprove={async () => null} onRetry={async () => {}} />);
    expect(screen.getByTestId("reading-pending").textContent).toMatch(/Reading the fact/);
    expect(screen.queryByTestId("approve-reading")).toBeNull();
  });

  it("failed: says why and offers Try again", async () => {
    const onRetry = vi.fn(async () => {});
    render(<ReadingStep reading={view(run({ status: "failed", draftNote: null, research: null, error: "The reading could not be written: timeout" }))} onApprove={async () => null} onRetry={onRetry} />);
    expect(screen.getByTestId("reading-failed").textContent).toMatch(/timeout/);
    await act(async () => { fireEvent.click(screen.getByTestId("reading-retry")); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("ok: shows the draft and the research, and approves the note as edited", async () => {
    const onApprove = vi.fn(async () => null);
    render(<ReadingStep reading={view(run())} onApprove={onApprove} onRetry={async () => {}} />);
    expect((screen.getByTestId("reading-note") as HTMLTextAreaElement).value).toMatch(/sharks hold a week/);
    expect(screen.getByTestId("reading-research").textContent).toMatch(/Sharks watching Alex on TV/);
    fireEvent.change(screen.getByTestId("reading-note"), { target: { value: "  The sharks are the audience.  " } });
    await act(async () => { fireEvent.click(screen.getByTestId("approve-reading")); });
    expect(onApprove).toHaveBeenCalledWith("The sharks are the audience.", 7);
  });

  it("ok with no references: says so", () => {
    render(<ReadingStep reading={view(run({ research: { references: [] } }))} onApprove={async () => null} onRetry={async () => {}} />);
    expect(screen.getByTestId("reading-no-references")).toBeTruthy();
  });

  it("an empty note cannot be approved", () => {
    render(<ReadingStep reading={view(run())} onApprove={async () => null} onRetry={async () => {}} />);
    fireEvent.change(screen.getByTestId("reading-note"), { target: { value: "   " } });
    expect((screen.getByTestId("approve-reading") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refusal is shown on the step", async () => {
    render(<ReadingStep reading={view(run())} onApprove={async () => "A newer reading replaced the one on your screen."} onRetry={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByTestId("approve-reading")); });
    expect(screen.getByTestId("reading-approve-error").textContent).toMatch(/newer reading/);
  });

  it("polling the same run keeps the moderator's edit; a new run reseeds the editor", () => {
    const { rerender } = render(<ReadingStep reading={view(run())} onApprove={async () => null} onRetry={async () => {}} />);
    fireEvent.change(screen.getByTestId("reading-note"), { target: { value: "My correction." } });
    rerender(<ReadingStep reading={view(run())} onApprove={async () => null} onRetry={async () => {}} />);
    expect((screen.getByTestId("reading-note") as HTMLTextAreaElement).value).toBe("My correction.");
    rerender(<ReadingStep reading={view(run({ id: 8, draftNote: "A fresh draft." }))} onApprove={async () => null} onRetry={async () => {}} />);
    expect((screen.getByTestId("reading-note") as HTMLTextAreaElement).value).toBe("A fresh draft.");
  });
});
