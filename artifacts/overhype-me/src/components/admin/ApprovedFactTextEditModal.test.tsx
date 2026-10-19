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

  it("renders the stored text struck through (line-through) with the normalized proposed text beside it", () => {
    render(<ApprovedFactTextEditModal impact={impact()} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const oldEl = screen.getByText("OLD wording.");
    expect(oldEl.className).toContain("line-through");
    const newEl = screen.getByText("NEW wording.");
    expect(newEl.className).not.toContain("line-through");
    // old (struck) is listed before new in the same diff block
    expect(oldEl.compareDocumentPosition(newEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(oldEl.parentElement!.parentElement).toBe(newEl.parentElement!.parentElement);
  });

  it("always shows the consequence line that the taxonomy will be marked stale for reprocess", () => {
    render(<ApprovedFactTextEditModal impact={impact({ persistedMemeCount: 0 })} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(
      screen.getByText(/taxonomy was classified from the old wording; it will be marked stale for reprocess/),
    ).toBeTruthy();
  });

  it("says nothing about variants anywhere in the rendered modal", () => {
    const { container, rerender } = render(<ApprovedFactTextEditModal impact={impact()} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(container.textContent ?? "").not.toMatch(/variant/i);
    rerender(<ApprovedFactTextEditModal impact={impact({ persistedMemeCount: 5, liveMemeCount: 4, refreshInFlight: true })} busy={false} error={null} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(container.textContent ?? "").not.toMatch(/variant/i);
  });

  it("requires exactly the literal phrase CHANGE APPROVED FACT TEXT (pinned, not read from the production export)", () => {
    const onConfirm = vi.fn();
    render(<ApprovedFactTextEditModal impact={impact()} busy={false} error={null} onConfirm={onConfirm} onCancel={vi.fn()} />);
    const confirm = screen.getByTestId("approved-fact-text-edit-confirm") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-reason"), { target: { value: "a properly long reason" } });
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-phrase"), { target: { value: "CHANGE APPROVED FACT TEXT" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ phrase: "CHANGE APPROVED FACT TEXT" }));
    // A near-miss of the literal keeps it disabled.
    fireEvent.change(screen.getByTestId("approved-fact-text-edit-phrase"), { target: { value: "CHANGE APPROVED FACT TEXT " } });
    expect(confirm.disabled).toBe(true);
    // And the modal tells the admin to type that literal.
    expect(screen.getByText("CHANGE APPROVED FACT TEXT")).toBeTruthy();
  });
});
