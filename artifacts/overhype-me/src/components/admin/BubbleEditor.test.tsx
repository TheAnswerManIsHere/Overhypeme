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
    const warnings = screen.getAllByText(/isn't in this fact's character list or this gag's Scene Role Assignments/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.textContent).toContain("the mailman");
  });

  it("renders the unmatched-entity soft warning in the amber warning style (text-amber-700)", () => {
    const ov = OV({ bubbles: [bubble({ entity: "the mailman" })] });
    render(<BubbleEditor value={ov} onChange={vi.fn()} />);
    const warning = screen.getByText(/isn't in this fact's character list or this gag's Scene Role Assignments/);
    expect(warning.tagName).toBe("P");
    expect(warning.className).toContain("text-amber-700");
  });

  it("turns the character counter amber (text-amber-600) at 60+ chars, and keeps it muted below", () => {
    const { unmount } = render(<BubbleEditor value={OV({ bubbles: [bubble({ text: "x".repeat(60) })] })} onChange={vi.fn()} />);
    const counter = screen.getByText(/shorter renders more reliably/);
    expect(counter.textContent).toContain("60/80");
    expect(counter.className).toContain("text-amber-600");
    expect(counter.className).not.toContain("text-muted-foreground");
    unmount();

    render(<BubbleEditor value={OV({ bubbles: [bubble({ text: "x".repeat(59) })] })} onChange={vi.fn()} />);
    const quiet = screen.getByText("59/80");
    expect(quiet.className).toContain("text-muted-foreground");
    expect(quiet.className).not.toContain("text-amber-600");
  });

  it("the bubble text input refuses characters past 80 (maxLength is the literal 80)", () => {
    render(<BubbleEditor value={OV({ bubbles: [bubble({ text: "x".repeat(80) })] })} onChange={vi.fn()} />);
    const input = screen.getByTestId("bubble-text") as HTMLInputElement;
    expect(input.getAttribute("maxlength")).toBe("80");
    expect(input.maxLength).toBe(80);
  });

  it("with four bubbles Add is disabled and the hint reads \"Maximum 4 bubbles\" (literal 4, not MAX_BUBBLES); three still allow Add", () => {
    const four = OV({ bubbles: Array.from({ length: 4 }, () => bubble()) });
    const { unmount } = render(<BubbleEditor value={four} onChange={vi.fn()} />);
    expect((screen.getByTestId("bubble-add") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Maximum 4 bubbles/)).toBeTruthy();
    unmount();

    render(<BubbleEditor value={OV({ bubbles: Array.from({ length: 3 }, () => bubble()) })} onChange={vi.fn()} />);
    expect((screen.getByTestId("bubble-add") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Maximum 4 bubbles/)).toBeNull();
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

// ─── Speaker dropdown (PLAN_BUBBLE_SPEAKERS.md, C) ─────────────────────────────

describe("BubbleEditor — speaker dropdown", () => {
  const MOM = { label: "mom", kind: "person" as const, ofSubject: true };
  const optionTexts = (sel: HTMLElement) => Array.from((sel as HTMLSelectElement).options).map((o) => o.textContent);

  it("offers the subject, the fact's characters and this gag's extra roles, in that order", () => {
    const ov = OV({
      roleBindings: [{ entity: "doctor", visualRole: "in a white coat" }],
      bubbles: [bubble()],
    });
    render(<BubbleEditor value={ov} onChange={vi.fn()} characters={[MOM]} />);
    expect(optionTexts(screen.getByTestId("bubble-entity"))).toEqual([
      "Alex (the subject)",
      "Alex's mom",
      "doctor (added in this gag)",
    ]);
  });

  it("stores the plain label when a character is picked (the hospital example)", () => {
    const onChange = vi.fn();
    const ov = OV({ bubbles: [bubble({ text: "Buckle up, mom" }), bubble({ text: "Will do." })] });
    render(<BubbleEditor value={ov} onChange={onChange} characters={[MOM]} />);
    fireEvent.change(screen.getAllByTestId("bubble-entity")[1]!, { target: { value: "mom" } });
    const next = onChange.mock.calls.at(-1)![0] as VisualPromptStrategyOverride;
    expect(next.bubbles.map((b) => b.entity)).toEqual(["subject", "mom"]);
  });

  it("shows a saved off-list speaker as itself, selected, and never rewrites it", () => {
    const onChange = vi.fn();
    render(<BubbleEditor value={OV({ bubbles: [bubble({ entity: "the mailman" })] })} onChange={onChange} characters={[MOM]} />);
    const sel = screen.getByTestId("bubble-entity") as HTMLSelectElement;
    expect(sel.value).toBe("the mailman");
    expect(optionTexts(sel)).toContain("the mailman (not in this fact's character list)");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reads the characters from the gags panel's context when no prop is given (both placements)", async () => {
    const { FactCharactersContext } = await import("./FactCharactersContext");
    render(
      <FactCharactersContext.Provider value={[MOM]}>
        <BubbleEditor value={OV({ bubbles: [bubble()] })} onChange={vi.fn()} />
        <BubbleEditor firstClass value={OV({ bubbles: [bubble()] })} onChange={vi.fn()} />
      </FactCharactersContext.Provider>,
    );
    for (const sel of screen.getAllByTestId("bubble-entity")) {
      expect(optionTexts(sel)).toContain("Alex's mom");
    }
  });

  it("no longer warns about a speaker that is on the fact's character list", () => {
    render(<BubbleEditor value={OV({ bubbles: [bubble({ entity: "mom" })] })} onChange={vi.fn()} characters={[MOM]} />);
    expect(screen.queryByText(/isn't in this fact's character list/)).toBeNull();
  });
});
