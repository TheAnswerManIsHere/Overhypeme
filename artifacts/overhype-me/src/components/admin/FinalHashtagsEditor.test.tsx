import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FinalHashtagsEditor } from "./FinalHashtagsEditor";

describe("FinalHashtagsEditor", () => {
  it("renders the final tags and the empty-state warning when none", () => {
    render(<FinalHashtagsEditor finalHashtags={[]} onFinalHashtagsChange={vi.fn()} aiSuggestions={[]} />);
    expect(screen.getByTestId("final-hashtags-empty-warning")).toBeTruthy();
  });

  it("adds a normalized tag via the input on Enter", () => {
    const onChange = vi.fn();
    render(<FinalHashtagsEditor finalHashtags={["earth"]} onFinalHashtagsChange={onChange} aiSuggestions={[]} />);
    const input = screen.getByPlaceholderText("Add hashtag…");
    fireEvent.change(input, { target: { value: "#Strength!" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["earth", "strength"]);
  });

  it("removes a tag via its chip", () => {
    const onChange = vi.fn();
    render(<FinalHashtagsEditor finalHashtags={["earth", "pushups"]} onFinalHashtagsChange={onChange} aiSuggestions={[]} />);
    const chip = screen.getByText("earth").closest("span");
    fireEvent.click(chip!.querySelector("button")!);
    expect(onChange).toHaveBeenCalledWith(["pushups"]);
  });

  it("offers AI suggestions not already in the final list, and pulls one in on +", () => {
    const onChange = vi.fn();
    render(
      <FinalHashtagsEditor
        finalHashtags={["earth"]}
        onFinalHashtagsChange={onChange}
        aiSuggestions={["earth", "legendary"]}
      />,
    );
    // "earth" is already final, so only "legendary" is offered as a source chip.
    const suggestion = screen.getByTitle("Add to final hashtags");
    fireEvent.click(suggestion);
    expect(onChange).toHaveBeenCalledWith(["earth", "legendary"]);
  });

  it("rejects a denied tag (subject/app/humor) at Add time instead of adding it", () => {
    const onChange = vi.fn();
    render(<FinalHashtagsEditor finalHashtags={["earth"]} onFinalHashtagsChange={onChange} aiSuggestions={[]} />);
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

  it("does not offer denied AI suggestions and skips them in 'Add all'", () => {
    const onChange = vi.fn();
    render(
      <FinalHashtagsEditor
        finalHashtags={[]}
        onFinalHashtagsChange={onChange}
        aiSuggestions={["funny", "space", "overhype"]}
      />,
    );
    // Only "space" is a legitimate suggestion chip.
    expect(screen.queryByText("funny")).toBeNull();
    expect(screen.queryByText("overhype")).toBeNull();
    fireEvent.click(screen.getByText("Add all"));
    expect(onChange).toHaveBeenCalledWith(["space"]);
  });

  it("'Add all' merges every not-yet-added suggestion", () => {
    const onChange = vi.fn();
    render(
      <FinalHashtagsEditor
        finalHashtags={["earth"]}
        onFinalHashtagsChange={onChange}
        aiSuggestions={["legendary", "pushups"]}
      />,
    );
    fireEvent.click(screen.getByText("Add all"));
    expect(onChange).toHaveBeenCalledWith(["earth", "legendary", "pushups"]);
  });
});
