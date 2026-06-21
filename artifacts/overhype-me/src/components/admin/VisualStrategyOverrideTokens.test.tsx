/**
 * Phase 3 polish — token-chip insertion + {NAME_POSSESSIVE} UX for the moderator
 * Visual Strategy Override panel. Covers the field-agnostic insertion helper, the
 * chip-list/validator coverage guard, and the panel wiring (eligible vs excluded
 * fields, no-focus-steal, entity canonicalization).
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import {
  OVERRIDE_TOKEN_CHIPS,
  insertTokenIntoTextControl,
  VisualStrategyOverridePanel,
} from "./EnrichmentEditor";

// ── chip-list coverage (review rec. 1) ────────────────────────────────────────

describe("OVERRIDE_TOKEN_CHIPS", () => {
  it("offers exactly the intended personalization token set", () => {
    expect([...OVERRIDE_TOKEN_CHIPS]).toEqual([
      "{NAME}",
      "{NAME_POSSESSIVE}",
      "{SUBJ}",
      "{OBJ}",
      "{POSS}",
      "{POSS_PRO}",
      "{REFL}",
    ]);
  });
});

// ── insertTokenIntoTextControl ────────────────────────────────────────────────

describe("insertTokenIntoTextControl", () => {
  it("inserts at the collapsed caret and fires a React onChange", () => {
    const onValue = vi.fn();
    function Controlled() {
      const [v, setV] = useState("a  b");
      return (
        <input
          data-testid="inp"
          value={v}
          onChange={(e) => {
            setV(e.target.value);
            onValue(e.target.value);
          }}
        />
      );
    }
    render(<Controlled />);
    const el = screen.getByTestId("inp") as HTMLInputElement;
    el.setSelectionRange(2, 2); // between the two spaces: "a |b"
    act(() => {
      insertTokenIntoTextControl(el, "{NAME}");
    });
    expect(onValue).toHaveBeenCalledWith("a {NAME} b");
    expect((screen.getByTestId("inp") as HTMLInputElement).value).toBe("a {NAME} b");
  });

  it("replaces the selected range", () => {
    function Controlled() {
      const [v, setV] = useState("TOKEN_HERE end");
      return <input data-testid="inp" value={v} onChange={(e) => setV(e.target.value)} />;
    }
    render(<Controlled />);
    const el = screen.getByTestId("inp") as HTMLInputElement;
    el.setSelectionRange(0, "TOKEN_HERE".length); // select "TOKEN_HERE"
    act(() => {
      insertTokenIntoTextControl(el, "{NAME_POSSESSIVE}");
    });
    expect((screen.getByTestId("inp") as HTMLInputElement).value).toBe("{NAME_POSSESSIVE} end");
  });
});

// ── panel wiring ──────────────────────────────────────────────────────────────

function enabledOverride(partial: Partial<VisualPromptStrategyOverride> = {}): VisualPromptStrategyOverride {
  return { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, ...partial };
}

/** Render the panel as a controlled host so chip clicks flow back into state. */
function renderPanel(initial: VisualPromptStrategyOverride) {
  const seen: Array<VisualPromptStrategyOverride | undefined> = [];
  function Host() {
    const [v, setV] = useState<VisualPromptStrategyOverride | undefined>(initial);
    return (
      <VisualStrategyOverridePanel
        value={v}
        onChange={(next) => {
          seen.push(next);
          setV(next);
        }}
      />
    );
  }
  render(<Host />);
  return seen;
}

describe("VisualStrategyOverridePanel — token chips", () => {
  it("inserts a token into the last-focused token-capable field (Required Visual Details)", () => {
    const seen = renderPanel(enabledOverride({ requiredVisualDetails: [""] }));
    const targets = screen.getAllByDisplayValue("");
    // The first empty token-capable input is the Required Visual Details row.
    const rvd = targets.find((el) => (el as HTMLInputElement).dataset.tokenInsertTarget === "true") as HTMLInputElement;
    act(() => {
      fireEvent.focus(rvd);
    });
    const chip = screen.getAllByTestId("vso-token-chip").find((b) => b.textContent === "{NAME_POSSESSIVE}")!;
    act(() => {
      fireEvent.click(chip);
    });
    // The field's onChange canonicalized + propagated the inserted token upward.
    const last = seen.at(-1);
    expect(last?.requiredVisualDetails).toEqual(["{NAME_POSSESSIVE}"]);
  });

  it("does NOT target the admin-only Moderator Intent field", () => {
    renderPanel(enabledOverride());
    const label = screen.getByText(/Moderator Intent/i);
    const intent = label.parentElement!.querySelector("textarea")!;
    expect(intent.getAttribute("data-token-insert-target")).toBeNull();
  });

  it("keeps chips out of the tab order's focus path (mousedown is prevented)", () => {
    renderPanel(enabledOverride({ requiredVisualDetails: [""] }));
    const chip = screen.getAllByTestId("vso-token-chip")[0];
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    chip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("canonicalizes name-token aliases typed into roleBindings.entity", () => {
    const seen = renderPanel(enabledOverride({ roleBindings: [{ entity: "", visualRole: "" }] }));
    const entity = screen.getByPlaceholderText(/entity \(subject, mother/i) as HTMLInputElement;
    act(() => {
      fireEvent.change(entity, { target: { value: "{name_possessive} mother" } });
    });
    expect(seen.at(-1)?.roleBindings[0].entity).toBe("{NAME_POSSESSIVE} mother");
  });
});
