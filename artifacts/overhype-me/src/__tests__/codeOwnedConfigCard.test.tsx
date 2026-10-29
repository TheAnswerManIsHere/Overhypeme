/**
 * The admin config card for a code-owned AI system prompt (Launch Phase 3,
 * plan amendment 1, B3): the code's text in a read-only box, "Set in code",
 * and no Save button. An ordinary row keeps its editable field.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConfigCard, ConfigPageContext, type ConfigPageCtx, type ConfigRow } from "@/pages/admin/_configShared";

const row = (over: Partial<ConfigRow>): ConfigRow => ({
  key: "k", value: "v", valueLabel: null, dataType: "text", label: "L", description: null,
  minValue: null, maxValue: null, isPublic: false, updatedAt: new Date(0).toISOString(), ...over,
});

function renderCard(r: ConfigRow) {
  const ctx: ConfigPageCtx = {
    rows: [r],
    stdEdits: { [r.key]: { value: r.value, label: r.value, saving: false, error: null, saved: false } },
    setStdEdits: () => {},
    saveStd: () => {},
    stdDirty: () => false,
    load: () => {},
  };
  return render(<ConfigPageContext.Provider value={ctx}><ConfigCard row={r} /></ConfigPageContext.Provider>);
}

describe("ConfigCard for a code-owned prompt", () => {
  it("shows the code's text read-only, says it is set in code, and offers no save", () => {
    renderCard(row({ key: "scene_prompt_system", value: "the code's prompt", codeOwned: true }));
    const box = screen.getByTestId("code-owned-scene_prompt_system").querySelector("textarea")!;
    expect(box.value).toBe("the code's prompt");
    expect(box.readOnly).toBe(true);
    expect(screen.getByText("Set in code")).toBeTruthy();
    expect(screen.queryByText(/Last updated/)).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("leaves an ordinary text setting editable", () => {
    renderCard(row({ key: "some_text_setting", value: "x" }));
    expect(screen.queryByTestId("code-owned-some_text_setting")).toBeNull();
    expect(screen.getByText(/Last updated/)).toBeTruthy();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.readOnly).toBe(false);
  });
});
