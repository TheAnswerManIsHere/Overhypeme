import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FinalHashtagsEditor } from "./FinalHashtagsEditor";

describe("FinalHashtagsEditor", () => {
  it("renders the final tags and the empty-state warning when none", () => {
    render(<FinalHashtagsEditor finalHashtags={[]} onFinalHashtagsChange={vi.fn()} />);
    expect(screen.getByTestId("final-hashtags-empty-warning")).toBeTruthy();
  });

  it("adds a normalized tag via the input on Enter", () => {
    const onChange = vi.fn();
    render(<FinalHashtagsEditor finalHashtags={["earth"]} onFinalHashtagsChange={onChange} />);
    const input = screen.getByPlaceholderText("Add hashtag…");
    fireEvent.change(input, { target: { value: "#Strength!" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["earth", "strength"]);
  });

  it("removes a tag via its chip", () => {
    const onChange = vi.fn();
    render(<FinalHashtagsEditor finalHashtags={["earth", "pushups"]} onFinalHashtagsChange={onChange} />);
    const chip = screen.getByText("earth").closest("span");
    fireEvent.click(chip!.querySelector("button")!);
    expect(onChange).toHaveBeenCalledWith(["pushups"]);
  });

  // Regression (David, 2026-11-24): hashtags are generated once, by the submit
  // form's AI where the submitter reviews them. Moderation offered a second,
  // enrichment-generated set ("AI suggested" + "Add all"), which carried the
  // placeholder name into tags like "alexpower". The editor offers none.
  it("offers no AI-suggested tags of its own: generation happens once, on the submit form", () => {
    render(<FinalHashtagsEditor finalHashtags={["earth"]} onFinalHashtagsChange={vi.fn()} />);
    expect(screen.queryByText("AI suggested")).toBeNull();
    expect(screen.queryByText("Add all")).toBeNull();
    expect(screen.queryByTitle("Add to final hashtags")).toBeNull();
  });

  it("rejects a denied tag (subject/app/humor) at Add time instead of adding it", () => {
    const onChange = vi.fn();
    render(<FinalHashtagsEditor finalHashtags={["earth"]} onFinalHashtagsChange={onChange} />);
    const input = screen.getByPlaceholderText("Add hashtag…");

    for (const junk of ["alex", "overhype", "funny"]) {
      fireEvent.change(input, { target: { value: junk } });
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("final-hashtags-rejected")).toBeTruthy();

    // A subsequent valid tag clears the rejection and adds normally.
    fireEvent.change(input, { target: { value: "space" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["earth", "space"]);
  });
});
