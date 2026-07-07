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

describe("withCoreSceneOverride", () => {
  it("auto-enables when the scene is non-empty and canonicalizes name tokens", () => {
    const next = withCoreSceneOverride(undefined, "{name} rides a duck");
    expect(next.enabled).toBe(true);
    expect(next.coreSceneOverride).toBe("{NAME} rides a duck");
  });

  it("never auto-disables on clear (other fields may be in use)", () => {
    const enabled = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: "a scene" };
    const cleared = withCoreSceneOverride(enabled, "");
    expect(cleared.enabled).toBe(true);
    expect(cleared.coreSceneOverride).toBe("");
  });

  it("leaves a disabled override disabled when the scene stays empty", () => {
    const next = withCoreSceneOverride(EMPTY_VISUAL_STRATEGY_OVERRIDE, "   ");
    expect(next.enabled).toBe(false);
  });
});

describe("VisualConceptCard", () => {
  it("typing a scene calls onChange with enabled:true and canonicalized text", () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    fireEvent.change(screen.getByTestId("visual-concept-textarea"), {
      target: { value: "{name} rides a giant rubber duck" },
    });
    const next = spy.mock.calls.at(-1)![0] as VisualPromptStrategyOverride;
    expect(next.enabled).toBe(true);
    expect(next.coreSceneOverride).toBe("{NAME} rides a giant rubber duck");
  });

  it("clearing keeps enabled:true", () => {
    const spy = vi.fn();
    render(
      <Harness
        initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: "a scene" }}
        onChangeSpy={spy}
      />,
    );
    fireEvent.change(screen.getByTestId("visual-concept-textarea"), { target: { value: "" } });
    const next = spy.mock.calls.at(-1)![0] as VisualPromptStrategyOverride;
    expect(next.enabled).toBe(true);
    expect(next.coreSceneOverride).toBe("");
  });

  it("token chip inserts at the caret of the textarea", () => {
    const spy = vi.fn();
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: "a  b" }} onChangeSpy={spy} />);
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
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: "abc" }} />);
    expect(screen.getByText(`3/${CORE_SCENE_MAX_CHARS}`)).toBeTruthy();
    expect(screen.getByTestId("visual-concept-card").textContent).toMatch(/compiler owns those and will strip them/i);
  });

  it("flags an unknown token with the advisory", () => {
    render(<Harness initial={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: "starring {BOGUS}" }} />);
    expect(screen.getByTestId("visual-concept-card").textContent).toMatch(/Invalid token/i);
  });

  it("shows a tokenize error (from vsoTokenizeErrors) ahead of the token-validation warning", () => {
    render(
      <VisualConceptCard
        value={{ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: "starring {BOGUS}" }}
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
});
