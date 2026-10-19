/**
 * VisualConceptCard — the moderator's prominent "describe the picture" field.
 * Covers: auto-enable on typing (never auto-disable on clear), name-token
 * canonicalization, caret token-chip insertion, the char counter, and the
 * helper copy steering moderators away from engine instructions.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { VisualConceptCard } from "./VisualConceptCard";
import { withCoreSceneOverride, CORE_SCENE_MAX_CHARS } from "./EnrichmentEditor";

function Harness({
  initial,
  onChangeSpy,
}: {
  initial?: VisualPromptStrategyOverride;
  onChangeSpy?: (next: VisualPromptStrategyOverride) => void;
}) {
  const [value, setValue] = useState<VisualPromptStrategyOverride | undefined>(initial);
  return (
    <VisualConceptCard
      value={value}
      onChange={(next) => {
        setValue(next);
        onChangeSpy?.(next);
      }}
    />
  );
}

describe("withCoreSceneOverride (presence-based — no enable field)", () => {
  it("canonicalizes name tokens and sets the scene, with no enable side effect", () => {
    const next = withCoreSceneOverride(undefined, "{name} rides a duck");
    expect("enabled" in next).toBe(false);
    expect(next.coreSceneOverride).toBe("{NAME} rides a duck");
  });

  it("clearing the scene leaves every other field untouched", () => {
    const base = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "a scene", requiredVisualDetails: ["a detail"] };
    const cleared = withCoreSceneOverride(base, "");
    expect(cleared.coreSceneOverride).toBe("");
    expect(cleared.requiredVisualDetails).toEqual(["a detail"]);
    expect("enabled" in cleared).toBe(false);
  });
});

describe("VisualConceptCard", () => {
  it("typing a scene calls onChange with the canonicalized text (no enable side effect)", () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.change(screen.getByTestId("visual-concept-textarea"), {
      target: { value: "{name} rides a giant rubber duck" },
    });
    const next = spy.mock.calls.at(-1)![0] as VisualPromptStrategyOverride;
    expect("enabled" in next).toBe(false);
    expect(next.coreSceneOverride).toBe("{NAME} rides a giant rubber duck");
  });

  it("clearing the scene emits an empty concept (no enable flip)", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "a scene" }}
        onChangeSpy={spy}
      />,
    );
    fireEvent.change(screen.getByTestId("visual-concept-textarea"), { target: { value: "" } });
    const next = spy.mock.calls.at(-1)![0] as VisualPromptStrategyOverride;
    expect("enabled" in next).toBe(false);
    expect(next.coreSceneOverride).toBe("");
  });

  it("token chip inserts at the caret of the textarea", () => {
    const spy = vi.fn();
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "a  b" }} onChangeSpy={spy} />);
    const el = screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement;
    el.focus();
    el.setSelectionRange(2, 2);
    act(() => {
      fireEvent.click(screen.getAllByTestId("visual-concept-token-chip")[0]!);
    });
    const next = spy.mock.calls.at(-1)![0] as VisualPromptStrategyOverride;
    expect(next.coreSceneOverride).toBe("a {NAME} b");
  });

  it("shows David/he-him examples beside each token chip", () => {
    render(<Harness />);
    const cardText = screen.getByTestId("visual-concept-card").textContent ?? "";
    for (const expected of [
      "{NAME}David",
      "{NAME_POSSESSIVE}David’s",
      "{SUBJ}he",
      "{OBJ}him",
      "{POSS}his",
      "{POSS_PRO}his",
      "{REFL}himself",
    ]) {
      expect(cardText).toContain(expected);
    }
  });

  it("shows the char counter and the don't-write-engine-instructions helper copy", () => {
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "abc" }} />);
    expect(screen.getByText(`3/${CORE_SCENE_MAX_CHARS}`)).toBeTruthy();
    expect(screen.getByTestId("visual-concept-card").textContent).toMatch(/compiler owns those and will flag them/i);
  });

  it("flags an unknown token with the advisory", () => {
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "starring {BOGUS}" }} />);
    expect(screen.getByTestId("visual-concept-card").textContent).toMatch(/Invalid token/i);
  });

  it("shows a tokenize error (from vsoTokenizeErrors) ahead of the token-validation warning", () => {
    render(
      <VisualConceptCard
        value={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "starring {BOGUS}" }}
        onChange={() => {}}
        tokenizeError="unbalanced token"
      />,
    );
    const text = screen.getByTestId("visual-concept-card").textContent ?? "";
    expect(text).toContain("unbalanced token");
    expect(text).not.toMatch(/Invalid token/i);
  });

  it("disables the textarea and chips when disabled=true", () => {
    render(<VisualConceptCard value={EMPTY_VISUAL_STRATEGY_OVERRIDE} onChange={() => {}} disabled />);
    expect((screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement).disabled).toBe(true);
    for (const chip of screen.getAllByTestId("visual-concept-token-chip")) {
      expect((chip as HTMLButtonElement).disabled).toBe(true);
    }
  });
  it("the Visual Concept textarea carries maxLength 1500, so a paste past 1,500 characters is cut there and the counter reads 1500/1500", () => {
    render(<Harness />);
    const el = screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement;
    expect(el.getAttribute("maxlength")).toBe("1500");
    // A browser cuts pasted text at the field's own maxLength; do the same here.
    const pasted = "x".repeat(1600);
    fireEvent.change(el, { target: { value: pasted.slice(0, el.maxLength) } });
    expect((screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toHaveLength(1500);
    expect(screen.getByText("1500/1500")).toBeTruthy();
  });

  it("a blank concept renders the visual-concept-required line reading exactly: Required — describe the picture before saving or approving.", () => {
    render(<Harness />);
    const line = screen.getByTestId("visual-concept-required");
    expect(line.textContent?.trim()).toBe("Required — describe the picture before saving or approving.");
  });

  it("the Visual Concept card header carries a red * required marker", () => {
    render(<Harness />);
    const marker = screen.getByTitle("Required");
    expect(marker.textContent).toBe("*");
    expect(marker.className).toContain("text-red-500");
    expect(marker.parentElement?.textContent).toContain("Visual concept — describe the picture");
  });

  it("typing {NOPE} after existing text in the visual-concept-textarea, with no save, shows the Invalid token warning", () => {
    const spy = vi.fn();
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: "Existing scene text" }} onChangeSpy={spy} />);
    expect(screen.getByTestId("visual-concept-card").textContent).not.toMatch(/Invalid token/i);
    const el = screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement;
    fireEvent.change(el, { target: { value: `${el.value}{NOPE}` } });
    expect((screen.getByTestId("visual-concept-textarea") as HTMLTextAreaElement).value).toBe("Existing scene text{NOPE}");
    expect(screen.getByTestId("visual-concept-card").textContent).toContain("Invalid token: ");
    expect(screen.getByTestId("visual-concept-card").textContent).toContain("{NOPE}");
  });
});
