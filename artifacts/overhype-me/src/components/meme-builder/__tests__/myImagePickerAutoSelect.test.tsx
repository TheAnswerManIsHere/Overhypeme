// PR #1313, round 1: the picker's own default pick is reported apart from a
// tap, so the builder can fill the photo an AI picture is drawn from without
// replacing an AI picture restored as the background. A tap still goes to
// onSelect.
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../hooks/useMyImages", () => ({
  useMyImages: () => ({
    isLoading: false,
    rows: [
      { objectPath: "/objects/uploads/a.jpg", isProfile: true },
      { objectPath: "/objects/uploads/b.jpg", isProfile: false },
    ],
  }),
}));
vi.mock("../hooks/useDesktopModality", () => ({ useDesktopModality: () => true }));

import { MyImagePicker } from "../parts/MyImagePicker";

describe("MyImagePicker default pick", () => {
  it("sends its own default pick to onAutoSelect and a tap to onSelect", () => {
    const onSelect = vi.fn();
    const onAutoSelect = vi.fn();
    render(<MyImagePicker selected={null} onSelect={onSelect} onAutoSelect={onAutoSelect} />);
    expect(onAutoSelect).toHaveBeenCalledWith({ kind: "library", objectPath: "/objects/uploads/a.jpg" });
    expect(onSelect).not.toHaveBeenCalled();
    const tiles = screen.getAllByRole("button").filter((b) => b.querySelector("img"));
    fireEvent.click(tiles[1]!);
    expect(onSelect).toHaveBeenCalled();
  });

  it("without onAutoSelect the default pick goes to onSelect, as before", () => {
    const onSelect = vi.fn();
    render(<MyImagePicker selected={null} onSelect={onSelect} />);
    expect(onSelect).toHaveBeenCalledWith({ kind: "library", objectPath: "/objects/uploads/a.jpg" });
  });
});
