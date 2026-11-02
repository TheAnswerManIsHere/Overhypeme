/**
 * @purpose Proves name inputs apply the shared name rule on the browser side: the shared table accepts and refuses the same names as the server, a disallowed character is refused as typed or pasted with a hint, the curly apostrophe is converted, a long paste is reported rather than cut, and an open IME composition is left alone until it commits.
 * @subsystem accounts-auth
 */
import { describe, expect, it } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { checkPersonalName } from "@workspace/api-zod";
import { PERSONAL_NAME_ACCEPTED, PERSONAL_NAME_REFUSED } from "../../../../lib/api-zod/src/personalNameRule.fixtures";
import { NameFieldHint, useNameField } from "./use-name-field";

function Field({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  const f = useNameField(value, setValue);
  return (
    <>
      <input data-testid="name" {...f.inputProps} />
      <NameFieldHint hint={f.hint} />
    </>
  );
}

const input = () => screen.getByTestId("name") as HTMLInputElement;

describe("the shared name table, in the browser", () => {
  for (const c of PERSONAL_NAME_ACCEPTED) {
    it(`accepts ${c.why}`, () => expect(checkPersonalName(c.input)).toEqual({ ok: true, value: c.value }));
  }
  for (const c of PERSONAL_NAME_REFUSED) {
    it(`refuses ${c.why}`, () => {
      const r = checkPersonalName(c.input);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe(c.reason);
    });
  }
});

describe("a name field", () => {
  it("refuses an emoji as it is typed, and says why", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "Ada😀" } });
    expect(input().value).toBe("Ada");
    expect(screen.getByTestId("name-field-hint").textContent).toMatch(/letters, numbers/i);
  });

  it("drops brackets and quotes from a paste but keeps the rest", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: 'Ada "Countess" (Lovelace)' } });
    expect(input().value).toBe("Ada Countess Lovelace");
  });

  it("converts the curly apostrophe iOS types", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "O’Brien" } });
    expect(input().value).toBe("O'Brien");
    expect(screen.queryByTestId("name-field-hint")).toBeNull();
  });

  it("keeps accented English-script letters, and refuses another script", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "Zoë Łukasz" } });
    expect(input().value).toBe("Zoë Łukasz");
    fireEvent.change(input(), { target: { value: "Zoë Ольга" } });
    expect(input().value).toBe("Zoë ");
  });

  // David, 2026-11-02: the field stops at the limit and says so; there is
  // no too-long state to refuse at save.
  it("stops a paste at 50 characters and says why", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "a".repeat(60) } });
    expect(input().value).toHaveLength(50);
    expect(input().getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByTestId("name-field-hint").textContent).toMatch(/up to 50 characters, so the rest wasn't added/);
  });

  it("takes no 51st character as it is typed, and says it is the limit", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "b".repeat(50) } });
    expect(screen.getByTestId("name-field-hint").textContent).toMatch(/50-character limit/);
    fireEvent.change(input(), { target: { value: "b".repeat(51) } });
    expect(input().value).toHaveLength(50);
  });

  it("shows a running count as the name nears the limit, and nothing well before it", () => {
    render(<Field />);
    fireEvent.change(input(), { target: { value: "c".repeat(20) } });
    expect(screen.queryByTestId("name-field-hint")).toBeNull();
    fireEvent.change(input(), { target: { value: "c".repeat(42) } });
    expect(screen.getByTestId("name-field-hint").textContent).toBe("42 of 50 characters");
  });

  it("leaves an open IME composition alone, then applies the rule when it commits", () => {
    render(<Field />);
    fireEvent.compositionStart(input());
    // An IME composing an accented letter passes through intermediate text.
    fireEvent.change(input(), { target: { value: "Zo\u00A8" } });
    expect(input().value).toBe("Zo\u00A8");
    fireEvent.change(input(), { target: { value: "Zoë" } });
    fireEvent.compositionEnd(input(), { data: "ë" });
    expect(input().value).toBe("Zoë");
  });
});
