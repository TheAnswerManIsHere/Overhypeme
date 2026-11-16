/**
 * The Characters editor (PLAN_BUBBLE_SPEAKERS.md, D): edits commit only as a
 * valid whole list; errors show on their own row.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CharactersEditor, characterRowErrors } from "./CharactersEditor";

const MOM = { label: "mom", kind: "person" as const, ofSubject: true };

describe("CharactersEditor", () => {
  it("shows each character with how the dropdown will read it", () => {
    render(<CharactersEditor characters={[MOM]} onChange={vi.fn()} />);
    expect(screen.getByTestId("character-display").textContent).toContain("Alex's mom");
  });

  it("adds a row locally and commits it only once it has a valid label", () => {
    const onChange = vi.fn();
    render(<CharactersEditor characters={[MOM]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("character-add"));
    const labels = screen.getAllByTestId("character-label");
    fireEvent.blur(labels[1]!);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("character-error").textContent).toMatch(/Give the character a label/);
    fireEvent.change(labels[1]!, { target: { value: " dog " } });
    fireEvent.blur(labels[1]!);
    expect(onChange).toHaveBeenLastCalledWith([MOM, { label: "dog", kind: "person", ofSubject: false }]);
  });

  it("refuses the reserved word, a token and a duplicate, on the offending row", () => {
    expect(characterRowErrors([{ ...MOM, label: "subject" }])[0]).toMatch(/reserved/);
    expect(characterRowErrors([{ ...MOM, label: "{NAME}" }])[0]).toMatch(/personalization tokens/);
    expect(characterRowErrors([MOM, { ...MOM, label: "Mom" }])).toEqual(["", expect.stringMatching(/listed twice/)]);
  });

  it("commits kind and relation changes immediately, and a removal", () => {
    const onChange = vi.fn();
    render(<CharactersEditor characters={[MOM]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("character-kind"), { target: { value: "animal" } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...MOM, kind: "animal" }]);
    fireEvent.click(screen.getByLabelText("Remove character 1"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
