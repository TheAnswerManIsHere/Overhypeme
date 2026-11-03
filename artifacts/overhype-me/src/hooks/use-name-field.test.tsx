/**
 * @purpose Proves name inputs apply the shared name rule on the browser side: the shared table accepts and refuses the same names as the server, a disallowed character is refused as typed or pasted with a hint, the curly apostrophe is converted, the field stops at 50 characters and an edit anywhere in the name takes only what fits without touching the rest, and an open IME composition is left alone until it commits.
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

  // Codex, PR #838: only the edit's own addition is cut; the text around it
  // is never touched, wherever the caret was.
  // Codex, PR #838: only the edit's own addition is cut; the text around it
  // is never touched, wherever the caret was. Each change event carries the
  // caret where a browser leaves it: just after the inserted text.
  const edit = (value: string, caret: number) =>
    fireEvent.change(input(), { target: { value, selectionStart: caret, selectionEnd: caret } });

  it("at the limit, refuses a letter typed at the start or in the middle and keeps the name", () => {
    const full = "A" + "b".repeat(48) + "Z";
    render(<Field initial={full} />);
    edit("X" + full, 1);
    expect(input().value).toBe(full);
    edit(full.slice(0, 25) + "X" + full.slice(25), 26);
    expect(input().value).toBe(full);
    expect(screen.getByTestId("name-field-hint").textContent).toMatch(/up to 50 characters/);
  });

  it("takes only what fits from a paste into the middle, and keeps the end of the name", () => {
    // 45 characters, with a composed accent beside the insertion point.
    const name = "a".repeat(9) + "é" + "c".repeat(34) + "Z";
    expect(name).toHaveLength(45);
    render(<Field initial={name} />);
    edit(name.slice(0, 10) + "ÅØßøåXYZ" + name.slice(10), 18);
    expect(input().value).toBe(name.slice(0, 10) + "ÅØßøå" + name.slice(10));
  });

  it("frees the room of a replaced selection without touching the rest", () => {
    const full = "Ada " + "x".repeat(42) + " Zoë";
    render(<Field initial={full} />);
    // "Ada" selected and replaced by "Augusta": three letters freed, so "Aug" fits.
    edit("Augusta" + full.slice(3), 7);
    expect(input().value).toBe("Aug" + full.slice(3));
  });

  it("lets a stored name over the limit be shortened but not lengthened", () => {
    const long = "n".repeat(55);
    render(<Field initial={long} />);
    edit(long + "o", 56);
    expect(input().value).toBe(long);
    edit("n".repeat(54), 54);
    expect(input().value).toBe("n".repeat(54));
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
