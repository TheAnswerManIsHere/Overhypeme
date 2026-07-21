/**
 * The §10.4 / §21 budget PROOF: the moderator authoring reserves declared in
 * api-zod (`promptBudget.ts`) must actually fit inside the engine's 6000-char
 * ceiling once the compiler's REAL fixed-required overhead is measured.
 *
 * If a compiler wording change grows a required section past the reserved
 * `FIXED_REQUIRED_RESERVE_BUDGET`, this test fails — forcing the §21 numbers to
 * be re-derived and re-approved instead of silently eating the moderator pool.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PROMPT_TOTAL_BUDGET,
  FIXED_REQUIRED_RESERVE_BUDGET,
  CORE_SCENE_RENDERED_MAX,
  MODERATOR_ADDITIONS_RENDERED_MAX,
  PROMPT_OUTER_MARGIN,
  validateVisualStrategyOverrideForSave,
  CORE_SCENE_RAW_MAX,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import { measureRequiredPromptBudget } from "../lib/imagePrompt/promptBudget";

describe("measureRequiredPromptBudget — the §21 proof", () => {
  it("the LIVE compiler's worst-case fixed reserve fits inside FIXED_REQUIRED_RESERVE_BUDGET", () => {
    const m = measureRequiredPromptBudget();
    assert.ok(
      m.worstCase <= FIXED_REQUIRED_RESERVE_BUDGET,
      `measured worst-case fixed reserve ${m.worstCase} exceeds the reserved ${FIXED_REQUIRED_RESERVE_BUDGET}; ` +
        `re-derive the §21 numbers (per-mode: ${JSON.stringify(m.perMode)})`,
    );
  });

  it("reserves + margin exactly account for the 6000-char engine budget", () => {
    const sum =
      FIXED_REQUIRED_RESERVE_BUDGET + CORE_SCENE_RENDERED_MAX + MODERATOR_ADDITIONS_RENDERED_MAX + PROMPT_OUTER_MARGIN;
    assert.ok(sum <= PROMPT_TOTAL_BUDGET, `reserves ${sum} exceed total budget ${PROMPT_TOTAL_BUDGET}`);
    assert.ok(PROMPT_OUTER_MARGIN >= 100, "outer margin must be at least 100 (plan §10.4)");
  });

  it("the moderator Concept rendered reserve is at least its raw cap (a token-free Concept must fit)", () => {
    assert.ok(
      CORE_SCENE_RENDERED_MAX >= CORE_SCENE_RAW_MAX,
      "a raw-max token-free Concept must not be rejected by the rendered cap",
    );
  });
});

describe("validateVisualStrategyOverrideForSave (§10.2 / §10.3)", () => {
  const base = (): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true });

  it("accepts an empty / small override", () => {
    const r = validateVisualStrategyOverrideForSave(base());
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("rejects a Concept over the raw cap", () => {
    const r = validateVisualStrategyOverrideForSave({ ...base(), coreSceneOverride: "x".repeat(CORE_SCENE_RAW_MAX + 1) });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "core_scene_raw_too_long"));
  });

  it("rejects a Concept whose WORST-CASE rendered length blows the cap even under the raw cap", () => {
    // 110 repeated {NAME} tokens: raw ~770 (well under the raw cap) but each
    // renders to up to 20 chars → ~2300+ rendered (> the rendered cap).
    const tokenHeavy = "{NAME} ".repeat(110).trim();
    assert.ok(tokenHeavy.length <= CORE_SCENE_RAW_MAX, "sanity: raw length is within the raw cap");
    const r = validateVisualStrategyOverrideForSave({ ...base(), coreSceneOverride: tokenHeavy });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "core_scene_rendered_too_long"));
  });

  it("rejects when the aggregate of OTHER moderator content blows the additions pool", () => {
    // Fill styleAgnosticPromptAdditions past the additions budget.
    const chunk = "y".repeat(150);
    const additions = Array.from({ length: 20 }, () => chunk); // 20 * 150 = 3000 > pool
    const r = validateVisualStrategyOverrideForSave({ ...base(), styleAgnosticPromptAdditions: additions });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "moderator_additions_rendered_too_long"));
  });

  it("does NOT count the Concept toward the additions pool (separate reserves)", () => {
    const r = validateVisualStrategyOverrideForSave({
      ...base(),
      coreSceneOverride: "A grand cinematic scene.",
      styleAgnosticPromptAdditions: ["a small addition"],
    });
    assert.equal(r.ok, true);
    assert.ok(r.usage.coreSceneRendered > 0);
    assert.ok(r.usage.moderatorAdditionsRendered > 0);
    // The Concept's length is not folded into the additions usage.
    assert.ok(r.usage.moderatorAdditionsRendered < r.usage.coreSceneRendered);
  });
});
