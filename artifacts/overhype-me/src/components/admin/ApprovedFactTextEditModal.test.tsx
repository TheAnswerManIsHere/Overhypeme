/**
 * The approved-fact-text confirmation modal: Confirm is gated on the exact
 * phrase + a valid reason, consequences are conditional on the impact, and the
 * confirm payload carries the phrase + reason + the impact's expected hash.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { APPROVED_FACT_TEXT_EDIT_PHRASE, type ApprovedFactTextEditImpact } from "@workspace/api-zod";
import { ApprovedFactTextEditModal } from "./ApprovedFactTextEditModal";

function impact(over: Partial<ApprovedFactTextEditImpact> = {}): ApprovedFactTextEditImpact {
  return {
    protected: true,
    protectionReason: "active",
    currentStoredText: "OLD wording.",
    normalizedProposedText: "NEW wording.",
    expectedOldTextHash: "hash-of-old",
    persistedMemeCount: 0,
    liveMemeCount: 0,
    refreshInFlight: false,
    ...over,
  };
}

describe("ApprovedFactTextEditModal", () => {
  it("disables Confirm until the exact phrase AND a ≥10-char reason are present", () => {
    render(<ApprovedFactTextEditModal impact={impact()} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const confirm = screen.getByTestId("approved-fact-text-edit-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("approved-fact-text-edit-phrase"), { target: { value: APPROVED_FACT_TEXT_EDIT_PHRASE } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true); // reason still empty

    fireEvent.change(screen.getByTestId("approved-fact-text-edit-reason"), { target: { value: "short" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true); // reason too short

    fireEvent.change(screen.getByTestId("approved-fact-text-edit-reason"), { target: { value: "a properly long reason" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("stays disabled when the phrase is wrong even with a good reason", () => {
    render(<ApprovedFactTextEditModal impact={impact()} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-phrase"), { target: { value: "change approved fact text" } });
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-reason"), { target: { value: "a properly long reason" } });
    expect((screen.getByTestId("approved-fact-text-edit-confirm") as HTMLButtonElement).disabled).toBe(true);
  });

  it("emits the phrase, trimmed reason and expected hash on confirm", () => {
    const onConfirm = vi.fn();
    render(<ApprovedFactTextEditModal impact={impact()} busy={false} error={null} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-phrase"), { target: { value: APPROVED_FACT_TEXT_EDIT_PHRASE } });
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-reason"), { target: { value: "  a properly long reason  " } });
    fireEvent.click(screen.getByTestId("approved-fact-text-edit-confirm"));
    expect(onConfirm).toHaveBeenCalledWith({ phrase: APPROVED_FACT_TEXT_EDIT_PHRASE, reason: "a properly long reason", expectedOldTextHash: "hash-of-old" });
  });

  it("shows the meme consequence only when persisted memes exist", () => {
    const { rerender } = render(<ApprovedFactTextEditModal impact={impact({ persistedMemeCount: 0 })} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByText(/keep the OLD wording/i)).toBeNull();

    rerender(<ApprovedFactTextEditModal impact={impact({ persistedMemeCount: 5, liveMemeCount: 4 })} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/keep the OLD wording/i)).toBeTruthy();
  });
});
