/** SendBackToReviewModal — presentational confirm for the stale-fact refresh. */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SendBackToReviewModal } from "@/components/admin/SendBackToReviewModal";

function renderModal(over: Partial<Parameters<typeof SendBackToReviewModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <SendBackToReviewModal
      factId={42}
      factText="{NAME} bench-presses the Earth."
      busy={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onCancel };
}

describe("SendBackToReviewModal", () => {
  it("checkbox defaults OFF and confirm sends clearOverrides=false", () => {
    const { onConfirm } = renderModal();
    const checkbox = screen.getByTestId("send-back-clear-overrides") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(screen.getByTestId("send-back-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it("checking 'clear my manual edits' sends clearOverrides=true", () => {
    const { onConfirm } = renderModal();
    fireEvent.click(screen.getByTestId("send-back-clear-overrides"));
    fireEvent.click(screen.getByTestId("send-back-confirm"));
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("cancel fires onCancel; the copy promises the fact stays live", () => {
    const { onCancel, onConfirm } = renderModal();
    expect(screen.getByTestId("send-back-modal").textContent).toMatch(/stays live/i);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
