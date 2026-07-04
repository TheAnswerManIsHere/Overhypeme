/**
 * AttemptEvalControl — the per-attempt rating + failure-tag + note control.
 * Covers: rating posts + clears on re-click; tag posts; notes post on blur; a
 * failed save reverts the optimistic state.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { AttemptEvalControl, type EvalWriteBody } from "./AttemptEvalControl";

const ok = async () => ({ ok: true });

describe("AttemptEvalControl", () => {
  it("clicking a rating posts { rating }, and re-clicking it clears to null", async () => {
    const saves: EvalWriteBody[] = [];
    const onSave = vi.fn(async (b: EvalWriteBody) => { saves.push(b); return { ok: true }; });
    render(<AttemptEvalControl onSave={onSave} />);
    await act(async () => { fireEvent.click(screen.getByTestId("eval-rating-4")); });
    expect(saves.at(-1)).toEqual({ rating: 4 });
    await act(async () => { fireEvent.click(screen.getByTestId("eval-rating-4")); });
    expect(saves.at(-1)).toEqual({ rating: null });
  });

  it("clicking a failure tag posts { failureTag } and clears on re-click", async () => {
    const saves: EvalWriteBody[] = [];
    const onSave = vi.fn(async (b: EvalWriteBody) => { saves.push(b); return { ok: true }; });
    render(<AttemptEvalControl onSave={onSave} />);
    await act(async () => { fireEvent.click(screen.getByTestId("eval-tag-compiler")); });
    expect(saves.at(-1)).toEqual({ failureTag: "compiler" });
    await act(async () => { fireEvent.click(screen.getByTestId("eval-tag-compiler")); });
    expect(saves.at(-1)).toEqual({ failureTag: null });
  });

  it("posts notes on blur when changed", async () => {
    const onSave = vi.fn(async (_b: EvalWriteBody) => ({ ok: true }));
    render(<AttemptEvalControl onSave={onSave} />);
    const notes = screen.getByTestId("eval-notes");
    fireEvent.change(notes, { target: { value: "lost the pose" } });
    await act(async () => { fireEvent.blur(notes); });
    expect(onSave).toHaveBeenCalledWith({ notes: "lost the pose" });
  });

  it("reverts the optimistic rating when the save fails", async () => {
    const onSave = vi.fn(async (_b: EvalWriteBody) => ({ ok: false, error: "boom" }));
    render(<AttemptEvalControl rating={2} onSave={onSave} />);
    // 2 is pre-selected; clicking 5 optimistically selects it, then reverts.
    await act(async () => { fireEvent.click(screen.getByTestId("eval-rating-5")); });
    await waitFor(() => expect(screen.getByTestId("eval-error")).toBeTruthy());
    expect(screen.getByTestId("eval-rating-5").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("eval-rating-2").getAttribute("aria-pressed")).toBe("true");
  });

  it("compact hides the notes field", () => {
    render(<AttemptEvalControl compact onSave={ok} />);
    expect(screen.queryByTestId("eval-notes")).toBeNull();
  });
});
