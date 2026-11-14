/**
 * The read-only AI settings view (David, 2026-11-14: a page that SHOWS the
 * values). It reads code only, and shows each OpenAI step's parameters as the
 * request actually carries them.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { aiSettingsView } from "../lib/aiSettingsView.js";
import { CODE_OWNED_PROMPT_DEFS } from "../lib/codeOwnedPrompts.js";

const param = (row: { parameters: Array<{ name: string; value: string }> }, name: string) =>
  row.parameters.find((p) => p.name === name)?.value;

describe("aiSettingsView", () => {
  it("shows the gag writer as sent: GPT-6 Astra at medium effort, temperature not sent", async () => {
    const { steps } = await aiSettingsView();
    const gag = steps.find((s) => s.step.startsWith("Gag writer"))!;
    assert.equal(gag.model, "gpt-6-astra");
    assert.equal(param(gag, "Reasoning effort"), "medium");
    assert.equal(param(gag, "Temperature"), "not sent");
    assert.equal(param(gag, "Token limit"), String(4000 + 8000), "reasoning headroom is added, as the call does");
  });

  it("shows a temperature only where the model accepts one (the helper model at effort none)", async () => {
    const { steps } = await aiSettingsView();
    const helper = steps.find((s) => s.step.startsWith("General helper model (defaults"))!;
    assert.equal(param(helper, "Reasoning effort"), "none");
    assert.equal(param(helper, "Temperature"), "0.7");
    for (const s of steps.filter((r) => r.model.startsWith("gpt-5"))) {
      assert.equal(param(s, "Temperature"), "not sent", `${s.step}: gpt-5.x reasoning models take no temperature`);
    }
  });

  it("shows the picture engine for each render mode", async () => {
    const { steps } = await aiSettingsView();
    assert.equal(steps.find((s) => s.step === "Picture engine: text to image")!.model, "fal-ai/nano-banana-2");
    assert.equal(steps.find((s) => s.step === "Picture engine: from a reference photo")!.model, "fal-ai/nano-banana-2/edit");
  });

  it("shows every system prompt set in code, with its text, and names only prompts it shows", async () => {
    const { steps, prompts } = await aiSettingsView();
    assert.deepEqual(prompts.map((p) => p.key).sort(), CODE_OWNED_PROMPT_DEFS.map((d) => d.key).sort());
    for (const p of prompts) assert.ok(p.text.trim().length > 50, `${p.key}: prompt text shown`);
    const keys = new Set(prompts.map((p) => p.key));
    for (const s of steps) if (s.promptKey) assert.ok(keys.has(s.promptKey), `${s.step}: names a shown prompt`);
  });
});
