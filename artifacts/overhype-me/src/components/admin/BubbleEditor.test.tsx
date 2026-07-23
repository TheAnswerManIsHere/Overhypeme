/**
 * BubbleEditor — the ONE shared speech/thought-bubble editor (first-class card
 * on Moderation + embedded in the Advanced VSO panel). Covers: add/edit/remove
 * + the 4-row cap, the auto-enable contract (withBubbles), the 60-char soft
 * warning, token canonicalization in text, the unmatched-entity and
 * duplicate-label soft warnings, and tokenize field-error display.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  MAX_BUBBLES,
  type VisualPromptStrategyOverride,
  type VisualStrategyBubble,
} from "@workspace/api-zod";
import { BubbleEditor, withBubbles } from "./BubbleEditor";

const OV = (partial: Partial<VisualPromptStrategyOverride> = {}): VisualPromptStrategyOverride => ({
  ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
  ...partial,
});
const bubble = (partial: Partial<VisualStrategyBubble> = {}): VisualStrategyBubble => ({
  type: "speech",
  entity: "subject",
  text: "Hello.",
  ...partial,
});

describe("withBubbles (presence-based — no enable field)", () => {
  it("sets the bubbles and preserves every other field, with no enable side effect", () => {
    const next = withBubbles({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "a scene" }, [bubble()]);
    expect("enabled" in next).toBe(false);
    expect(next.bubbles).toEqual([bubble()]);
    expect(next.coreSceneOverride).toBe("a scene");
  });
});

describe("BubbleEditor", () => {
  it("adds a row (defaulting to speech/subject), edits it, and removes it", () => {
    const onChange = vi.fn();
    const { rerender } = render(<BubbleEditor value={OV()} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("bubble-add"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ bubbles: [{ type: "speech", entity: "subject", text: "" }] }),
    );

    const withRow = OV({ bubbles: [bubble({ text: "" })] });
    rerender(<BubbleEditor value={withRow} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("bubble-text"), { target: { value: "{name} rules" } });
    // Token canonicalization happens as-you-type ({name} → {NAME}).
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ bubbles: [expect.objectContaining({ text: "{NAME} rules" })] }),
    );

    fireEvent.click(screen.getByLabelText("Remove bubble"));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ bubbles: [] }));
  });

  it("caps at MAX_BUBBLES rows (Add disabled with a hint)", () => {
    const full = OV({ bubbles: Array.from({ length: MAX_BUBBLES }, () => bubble()) });
    render(<BubbleEditor value={full} onChange={vi.fn()} />);
    expect((screen.getByTestId("bubble-add") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(new RegExp(`Maximum ${MAX_BUBBLES} bubbles`))).toBeTruthy();
  });

  it("soft-warns at 60+ chars of text", () => {
    const long = OV({ bubbles: [bubble({ text: "x".repeat(61) })] });
    render(<BubbleEditor value={long} onChange={vi.fn()} />);
    expect(screen.getByText(/shorter renders more reliably/)).toBeTruthy();
  });

  it("soft-warns on an entity matching neither subject nor any role binding — but not on matches", () => {
    const ov = OV({
      roleBindings: [{ entity: "the bartender", visualRole: "polishing a glass" }],
      bubbles: [bubble({ entity: "the bartender" }), bubble({ entity: "the mailman", type: "thought" })],
    });
    render(<BubbleEditor value={ov} onChange={vi.fn()} />);
    const warnings = screen.getAllByText(/doesn't match "subject" or any Scene Role Assignment/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.textContent).toContain("the mailman");
  });

  it("soft-warns when duplicate role-binding labels make tail attribution ambiguous", () => {
    const ov = OV({
      roleBindings: [
        { entity: "the twin", visualRole: "left twin" },
        { entity: "the twin", visualRole: "right twin" },
      ],
      bubbles: [bubble({ entity: "the twin" })],
    });
    render(<BubbleEditor value={ov} onChange={vi.fn()} />);
    expect(screen.getByText(/more than one Scene Role Assignment is labeled "the twin"/)).toBeTruthy();
  });

  it("shows tokenize field errors on the exact row paths", () => {
    const ov = OV({ bubbles: [bubble(), bubble({ type: "thought" })] });
    render(
      <BubbleEditor
        value={ov}
        onChange={vi.fn()}
        fieldErrors={{ "bubbles[1].text": "unknown token {WEATHER}" }}
      />,
    );
    expect(screen.getByText(/unknown token \{WEATHER\}/)).toBeTruthy();
  });

  it("disabled blocks every input and button", () => {
    const onChange = vi.fn();
    render(<BubbleEditor value={OV({ bubbles: [bubble()] })} onChange={onChange} disabled />);
    expect((screen.getByTestId("bubble-add") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("bubble-text") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("bubble-entity") as HTMLInputElement).disabled).toBe(true);
  });
});
