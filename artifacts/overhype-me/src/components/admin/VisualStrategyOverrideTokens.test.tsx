/**
 * Phase 3 polish — token-chip insertion + {NAME_POSSESSIVE} UX. Covers the
 * field-agnostic insertion helper and the chip-list/validator coverage guard.
 * (The "More art direction" panel these chips also served was deleted at the
 * switch, plan PLAN_GAG_DIRECT_RENDER.md, D; the scene card still uses them.)
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen, act } from "@testing-library/react";
import {
  OVERRIDE_TOKEN_CHIPS,
  insertTokenIntoTextControl,
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
