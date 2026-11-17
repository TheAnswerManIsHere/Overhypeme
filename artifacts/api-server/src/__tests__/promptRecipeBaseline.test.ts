// The prompt tuner, part 2 (plan PLAN_PROMPT_TUNER.md, *Testing*), on the
// direct compile (plan PLAN_GAG_DIRECT_RENDER.md, *Testing Plan*: "The direct
// compile is pinned by a captured corpus"): each family's baseline recipe
// reproduces, byte for byte, the prompt the direct compile made for every
// pin case when the switch landed (fixtures/directCompileBaseline.json). A
// recipe that changes one piece changes only that piece's wording.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileDirect, type DirectCompileArgs } from "../lib/imagePrompt/compilers/nanoBanana2.js";
import { BASELINE_RECIPE, baselineRecipeFor, recipeFrom, recipeProblems, changedPolicyPieces, fillPiece, BASELINE_PIECES, RECIPE_PIECES } from "../lib/imagePrompt/recipe.js";
import { measureRequiredPromptBudget, recipeBudgetNeed, recipeBudgetProblems } from "../lib/imagePrompt/promptBudget.js";
import { FIXED_REQUIRED_RESERVE_BUDGET } from "@workspace/api-zod";
import { DIRECT_COMPILE_CASES, DIRECT_COMPILE_FAMILIES } from "./fixtures/directCompileCases.js";

const pinned = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/directCompileBaseline.json", import.meta.url)), "utf8")) as { prompts: Record<string, Record<string, string>> };
const compile = (args: Omit<DirectCompileArgs, "recipe">, recipe = BASELINE_RECIPE) => compileDirect({ ...structuredClone(args), recipe });
const sample = DIRECT_COMPILE_CASES.find((c) => c.name === "person, subject balloon, caption at the bottom")!;

describe("the direct compile's captured-prompt pin", () => {
  it(`reproduces every captured prompt exactly (${DIRECT_COMPILE_CASES.length} cases × ${DIRECT_COMPILE_FAMILIES.length} families)`, () => {
    for (const family of DIRECT_COMPILE_FAMILIES) {
      for (const c of DIRECT_COMPILE_CASES) {
        const want = pinned.prompts[family]?.[c.name];
        assert.ok(want, `${family} / ${c.name} is captured`);
        assert.equal(compile(c.args, baselineRecipeFor(family)).prompt, want, `${family} / ${c.name} changed`);
      }
    }
  });

  it("the baseline is what an omitted recipe compiles with", () => {
    for (const c of DIRECT_COMPILE_CASES) {
      assert.equal(compileDirect(structuredClone(c.args)).prompt, pinned.prompts["nano-banana-2"]![c.name]);
    }
  });

  it("an unknown or missing stored piece reads its baseline text", () => {
    assert.deepEqual(recipeFrom(7, { "nope": "x" }).pieces, BASELINE_PIECES);
    assert.equal(recipeFrom(7, {}).versionId, 7);
  });
});

describe("a recipe that changes pieces", () => {
  it("changes only the wording it holds: the identity paragraph and a section label", () => {
    const r = recipeFrom(1, { "identity.person": "Use the photo as the person's face.", "label.coreScene": "THE SCENE" });
    const out = compile(sample.args, r).prompt;
    assert.ok(out.includes("Use the photo as the person's face."));
    assert.ok(!out.includes(BASELINE_PIECES["identity.person"]));
    assert.ok(out.startsWith("THE SCENE: "));
    assert.equal(
      out.replace("Use the photo as the person's face.", BASELINE_PIECES["identity.person"]).replace(/^THE SCENE: /, "CORE SCENE: "),
      pinned.prompts["nano-banana-2"]![sample.name],
      "nothing else moves",
    );
  });

  it("emits engine notes as their own section before RENDER STYLE, only when there are some", () => {
    const out = compile(sample.args, recipeFrom(2, { "notes.engine": "Prefer natural skin texture." }));
    assert.match(out.prompt, /ENGINE NOTES: Prefer natural skin texture\. RENDER STYLE: /);
    assert.ok((out.promptBreakdown ?? []).some((s) => s.id === "engine_notes"));
    const none = compile(sample.args, recipeFrom(3, { "notes.engine": "   " }));
    assert.ok(!(none.promptBreakdown ?? []).some((s) => s.id === "engine_notes"));
  });

  it("the photoreal line applies whether the look-less style arrives empty or already resolved", () => {
    const r = recipeFrom(4, { "style.photoreal": "Shot on a 35mm film camera." });
    for (const stylePrompt of [BASELINE_PIECES["style.photoreal"], ""]) {
      assert.match(compile({ ...sample.args, stylePrompt }, r).prompt, /RENDER STYLE: Shot on a 35mm film camera\./);
    }
    assert.match(compile({ ...sample.args, stylePrompt: "Anime illustration." }, r).prompt, /RENDER STYLE: Anime illustration\./, "a chosen look's own text is never replaced");
  });

  it("a stored version's retired pieces are read as nothing: the violence sentence is the rule's, whatever the version holds", () => {
    // Pieces only the removed planned sections used (plan PLAN_GAG_DIRECT_RENDER.md, D) stay stored and are ignored.
    const r = recipeFrom(5, { "violence.allow": "Show all the gore.", "constraints.duplicate": "Clone {subject}.", "identity.person": "Keep the face." });
    assert.ok(!("violence.allow" in r.pieces) && !("constraints.duplicate" in r.pieces));
    assert.equal(r.pieces["identity.person"], "Keep the face.");
    assert.ok(!compile(sample.args, r).prompt.includes("Show all the gore."));
  });
});

describe("recipe pieces", () => {
  it("are only those the direct compile emits", () => {
    const keys = RECIPE_PIECES.map((p) => p.key);
    for (const gone of ["binding.agePerson", "constraints.duplicate", "constraints.soleAgent", "composition.framing", "composition.keyElements", "text.literal", "text.forbid", "violence.allow", "label.subjectBinding", "label.environment", "label.lighting"]) {
      assert.ok(!keys.includes(gone as never), `${gone} is no longer offered`);
    }
  });

  it("fill each slot once, never re-reading a value", () => {
    const r = recipeFrom(1, { "bubbles.speech": "Balloon to {who}: {text}." });
    assert.equal(fillPiece(r, "bubbles.speech", { who: "{who} Alex", text: "\"hi\"" }), "Balloon to {who} Alex: \"hi\".");
  });

  it("refuse a missing or unknown slot, an emptied policy line, an empty label and an unknown piece", () => {
    assert.deepEqual(recipeProblems(BASELINE_PIECES), [], "the baseline is well formed");
    const problems = recipeProblems({
      "composition.captionSpace": "Leave room for the caption.",
      "identity.person": "Use {photo} as the face.",
      "text.overlay": "  ",
      "label.coreScene": "",
      "made.up": "x",
    });
    assert.ok(problems.some((p) => /must contain \{side\}/.test(p)));
    assert.ok(problems.some((p) => /\{photo\} is not something/.test(p)));
    assert.ok(problems.some((p) => /policy line can be reworded but not emptied/.test(p)));
    assert.ok(problems.some((p) => /section label cannot be empty/.test(p)));
    assert.ok(problems.some((p) => /"made\.up" is not a piece/.test(p)));
    assert.deepEqual(recipeProblems({ "notes.engine": "" }), [], "a non-policy piece may be emptied");
  });

  it("load a stored version that still carries retired pieces, keeping the rest of its wording", () => {
    const loaded = recipeFrom(4, { "identity.none": "Draw a hero.", "label.renderTask": "TASK", "binding.singlePerson": "One {subject}.", "identity.person": "Keep the face." });
    assert.equal(loaded.pieces["identity.person"], "Keep the face.");
    for (const k of ["identity.none", "label.renderTask", "binding.singlePerson"]) assert.ok(!(k in loaded.pieces), k);
  });

  it("name the policy pieces that differ", () => {
    const changed = recipeFrom(1, { "text.incidental": "Background words stay blurred.", "identity.none": "x" }).pieces;
    assert.deepEqual(changedPolicyPieces(BASELINE_PIECES, changed), ["text.incidental"]);
  });
});

describe("the save-time budget check covers every piece (Codex, PR #926 round 1)", () => {
  /** The one piece in a section the compiler may drop when a prompt runs long, and the engine-notes label, emitted only with notes, which are measured. */
  const TRIMMABLE = new Set(["composition.captionSpace", "label.composition", "label.engineNotes"]);
  const pad = (key: string, by: number) => {
    const base = BASELINE_PIECES[key as keyof typeof BASELINE_PIECES];
    return key.startsWith("label.") ? base + "X".repeat(by) : `${base} ${"x".repeat(by)}`.trim();
  };

  it("refuses every piece that reaches a section never trimmed, when it alone grows by 1,000 characters", () => {
    const tight = measureRequiredPromptBudget().worstCase + 50;
    const accepted: string[] = [];
    for (const p of RECIPE_PIECES) {
      if (TRIMMABLE.has(p.key)) continue;
      if (recipeBudgetProblems(recipeFrom(1, { [p.key]: pad(p.key, 1000) }), tight).length === 0) accepted.push(p.key);
    }
    assert.deepEqual(accepted, [], "each of these grew by 1,000 characters unmeasured");
  });

  it("measures the baseline's fixed wording, and it fits", () => {
    const need = recipeBudgetNeed(BASELINE_RECIPE);
    assert.equal(need, measureRequiredPromptBudget().worstCase, "the baseline grows no balloon line beyond itself");
    assert.deepEqual(recipeBudgetProblems(BASELINE_RECIPE), []);
  });

  it("leaves real room for tuning: a version can add well over a thousand characters (David, 2026-11-12)", () => {
    assert.ok(FIXED_REQUIRED_RESERVE_BUDGET - recipeBudgetNeed(BASELINE_RECIPE) >= 3000);
    assert.deepEqual(recipeBudgetProblems(recipeFrom(1, { "identity.person": pad("identity.person", 1200), "notes.engine": "x".repeat(1200) })), []);
  });
});

describe("a slot filled with a fact's own text appears no more often than today's wording uses it (Codex, PR #926 round 2)", () => {
  it("refuses one extra use of every fact-text slot in every piece", () => {
    const missed: string[] = [];
    for (const p of RECIPE_PIECES) {
      for (const slot of p.slots) {
        if (slot === "subject" || slot === "gender") continue;
        if (recipeProblems({ [p.key]: `${p.text} {${slot}}` }).length === 0) missed.push(`${p.key} {${slot}}`);
      }
    }
    assert.deepEqual(missed, []);
  });
});

describe("a recipe cannot drop the gag's own text (build report, PR #926)", () => {
  it("refuses an emptied balloon piece", () => {
    for (const key of ["bubbles.speech", "bubbles.thought"]) {
      assert.ok(recipeProblems({ [key]: "  " }).some((p) => /fact's own text/.test(p)), key);
    }
  });
});

describe("the preview's highlighting (plan, A: the recipe's pieces highlighted)", () => {
  it("leaves every pinned prompt unchanged once the marks are read out, and marks only wording", async () => {
    const { markRecipe, segmentsOf } = await import("../lib/imagePrompt/recipeHighlight.js");
    for (const family of DIRECT_COMPILE_FAMILIES) {
      const marked = markRecipe(baselineRecipeFor(family));
      let wordingSeen = 0;
      for (const c of DIRECT_COMPILE_CASES) {
        const segs = segmentsOf(compile(c.args, marked).prompt);
        assert.equal(segs.map((s) => s.text).join(""), pinned.prompts[family]![c.name], `${family} / ${c.name}: highlighting changed the prompt`);
        wordingSeen += segs.filter((s) => s.piece).length;
      }
      assert.ok(wordingSeen > DIRECT_COMPILE_CASES.length, `${family}: wording is marked`);
    }
  });

  it("marks a slot's filled value as the gag's text, not as wording", async () => {
    const { markRecipe, segmentsOf } = await import("../lib/imagePrompt/recipeHighlight.js");
    const segs = segmentsOf(compile(sample.args, markRecipe(BASELINE_RECIPE)).prompt);
    const balloon = segs.filter((s) => s.piece === "bubbles.speech").map((s) => s.text).join("|");
    assert.ok(balloon && !balloon.includes("neighbours"), "the balloon's words are not inside the wording");
    assert.ok(segs.some((s) => s.piece === null && s.text.includes("neighbours")), "the gag's own text is unmarked");
  });
});
