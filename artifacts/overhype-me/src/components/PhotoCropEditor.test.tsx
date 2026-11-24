/**
 * The crop screen's guidance tells the truth about what is saved (#1215): the
 * saved photo is the whole square on the stage, dimmed corners included, and the
 * circle only shows how it looks as a round picture — so the words must never
 * say that the circle alone is what is saved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PhotoCropEditor } from "./PhotoCropEditor";

// The zoom slider measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

afterEach(() => cleanup());

function renderEditor() {
  render(
    <PhotoCropEditor
      file={new File(["x"], "photo.jpg", { type: "image/jpeg" })}
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      onDecodeError={vi.fn()}
    />,
  );
}

describe("PhotoCropEditor guidance", () => {
  it("says the whole square is saved", () => {
    renderEditor();
    expect(screen.getByText(/the whole square is saved/i)).toBeTruthy();
  });

  it("never claims the circle alone is what is saved", () => {
    renderEditor();
    const text = screen.getByTestId("photo-crop-editor").textContent ?? "";
    expect(text).not.toMatch(/(in|inside) the circle is (your|what)/i);
    expect(text).not.toMatch(/square inside the circle/i);
  });
});
