// The prompt tuner, part 2 (plan PLAN_PROMPT_TUNER.md, *Testing*): the
// baseline recipe reproduces, byte for byte, the prompt today's compiler made
// for every input in the corpus captured BEFORE the recipe refactor
// (fixtures/compilerBaseline.json, committed ahead of it). A recipe that
// changes one piece changes only that piece's wording.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileForSubjectRenderMode } from "../lib/imagePrompt/compilers/nanoBanana2.js";
import { BASELINE_RECIPE, recipeFrom, recipeProblems, changedPolicyPieces, fillPiece, BASELINE_PIECES, RECIPE_PIECES } from "../lib/imagePrompt/recipe.js";
import { measureRequiredPromptBudget, recipeBudgetNeed, recipeBudgetProblems } from "../lib/imagePrompt/promptBudget.js";
import { FIXED_REQUIRED_RESERVE_BUDGET } from "@workspace/api-zod";

type Case = { args: Parameters<typeof compileForSubjectRenderMode>[0]; prompt: string; engineNotes: string | null };
const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/compilerBaseline.json", import.meta.url)), "utf8")) as { cases: Case[] };

describe("the baseline recipe", () => {
  it(`reproduces every captured prompt exactly (${corpus.cases.length} inputs, all three photo modes)`, () => {
    assert.ok(corpus.cases.length >= 100);
    for (const [i, c] of corpus.cases.entries()) {
      const implicit = compileForSubjectRenderMode(structuredClone(c.args));
      assert.equal(implicit.prompt, c.prompt, `case ${i} (${c.args.input.subjectRenderMode}) changed with no recipe given`);
      assert.equal(implicit.engineNotes ?? null, c.engineNotes, `case ${i}: engine notes changed`);
      const explicit = compileForSubjectRenderMode({ ...structuredClone(c.args), recipe: BASELINE_RECIPE });
      assert.equal(explicit.prompt, c.prompt, `case ${i} changed under the explicit baseline`);
    }
  });

  it("an unknown or missing stored piece reads its baseline text", () => {
    assert.deepEqual(recipeFrom(7, { "nope": "x" }).pieces, BASELINE_PIECES);
    assert.equal(recipeFrom(7, {}).versionId, 7);
  });
});

describe("a recipe that changes pieces", () => {
  const sample = corpus.cases.find((c) => c.args.input.subjectRenderMode === "human_identity_i2i")!;

  it("changes only the wording it holds: the identity paragraph and a section label", () => {
    const r = recipeFrom(1, { "identity.person": "Use the photo as the person's face.", "label.coreScene": "THE SCENE" });
    const out = compileForSubjectRenderMode({ ...structuredClone(sample.args), recipe: r }).prompt;
    assert.ok(out.includes("Use the photo as the person's face."));
    assert.ok(!out.includes(BASELINE_PIECES["identity.person"]));
    assert.ok(out.startsWith("THE SCENE: "));
    assert.equal(
      out.replace("Use the photo as the person's face.", BASELINE_PIECES["identity.person"]).replace(/^THE SCENE: /, "CORE SCENE: "),
      sample.prompt,
      "nothing else moves",
    );
  });

  it("emits engine notes as their own section before RENDER STYLE, only when there are some", () => {
    const r = recipeFrom(2, { "notes.engine": "Prefer natural skin texture." });
    const out = compileForSubjectRenderMode({ ...structuredClone(sample.args), recipe: r });
    assert.match(out.prompt, /ENGINE NOTES: Prefer natural skin texture\. RENDER STYLE: /);
    assert.ok((out.promptBreakdown ?? []).some((s) => s.id === "engine_notes"));
    const none = compileForSubjectRenderMode({ ...structuredClone(sample.args), recipe: recipeFrom(3, { "notes.engine": "   " }) });
    assert.ok(!(none.promptBreakdown ?? []).some((s) => s.id === "engine_notes"));
  });

  it("the photoreal line applies whether the look-less style arrives empty or already resolved", () => {
    const r = recipeFrom(4, { "style.photoreal": "Shot on a 35mm film camera." });
    const resolved = compileForSubjectRenderMode({ ...structuredClone(sample.args), input: { ...structuredClone(sample.args.input), stylePrompt: BASELINE_PIECES["style.photoreal"] }, recipe: r }).prompt;
    const empty = compileForSubjectRenderMode({ ...structuredClone(sample.args), input: { ...structuredClone(sample.args.input), stylePrompt: "" }, recipe: r }).prompt;
    for (const p of [resolved, empty]) assert.match(p, /RENDER STYLE: Shot on a 35mm film camera\./);
    const styled = compileForSubjectRenderMode({ ...structuredClone(sample.args), input: { ...structuredClone(sample.args.input), stylePrompt: "Anime illustration." }, recipe: r }).prompt;
    assert.match(styled, /RENDER STYLE: Anime illustration\./, "a chosen look's own text is never replaced");
  });
});

describe("recipe pieces", () => {
  it("fill each slot once, never re-reading a value", () => {
    const r = recipeFrom(1, { "constraints.duplicate": "No copies of {subject}." });
    assert.equal(fillPiece(r, "constraints.duplicate", { subject: "{subject} Alex" }), "No copies of {subject} Alex.");
  });

  it("refuse a missing or unknown slot, an emptied policy line, an empty label and an unknown piece", () => {
    assert.deepEqual(recipeProblems(BASELINE_PIECES), [], "the baseline is well formed");
    const problems = recipeProblems({
      "constraints.duplicate": "Never clone them.",
      "identity.person": "Use {photo} as the face.",
      "text.overlay": "  ",
      "label.coreScene": "",
      "made.up": "x",
    });
    assert.ok(problems.some((p) => /must contain \{subject\}/.test(p)));
    assert.ok(problems.some((p) => /\{photo\} is not something/.test(p)));
    assert.ok(problems.some((p) => /policy line can be reworded but not emptied/.test(p)));
    assert.ok(problems.some((p) => /section label cannot be empty/.test(p)));
    assert.ok(problems.some((p) => /"made\.up" is not a piece/.test(p)));
    assert.deepEqual(recipeProblems({ "notes.engine": "", "constraints.causal": "" }), [], "a non-policy piece may be emptied");
  });

  it("name the policy pieces that differ", () => {
    const changed = recipeFrom(1, { "violence.allow": "Show it, no gore.", "identity.none": "x" }).pieces;
    assert.deepEqual(changedPolicyPieces(BASELINE_PIECES, changed), ["violence.allow"]);
  });
});

describe("the save-time budget check covers every piece (Codex, PR #926 round 1)", () => {
  /**
   * Pieces that can only land in sections the compiler trims or drops when a
   * prompt runs long, so a long one is shortened rather than breaking a render;
   * and the engine-notes label, emitted only with notes, which are measured.
   */
  const TRIMMABLE = new Set([
    "label.subjectDetails", "label.environment", "label.lighting",
    "composition.framing", "composition.captionSpace", "composition.keyElements",
    "label.engineNotes",
  ]);
  const pad = (key: string, by: number) => {
    const base = BASELINE_PIECES[key as keyof typeof BASELINE_PIECES];
    return key.startsWith("label.") ? base + "X".repeat(by) : `${base} ${"x".repeat(by)}`.trim();
  };

  /**
   * The class oracle, run against the tight reserve the check was built under
   * (1,750, today's wording needing 1,704), so a 1,000-character growth must be
   * refused wherever it is measured at all. The live reserve is roomier (David,
   * 2026-11-12), which leaves this property unchanged.
   */
  it("refuses every piece that reaches a section never trimmed, when it alone grows by 1,000 characters", () => {
    const accepted: string[] = [];
    for (const p of RECIPE_PIECES) {
      if (TRIMMABLE.has(p.key)) continue;
      const r = recipeFrom(1, { [p.key]: pad(p.key, 1000) });
      if (recipeBudgetProblems(r, 1750).length === 0) accepted.push(p.key);
    }
    assert.deepEqual(accepted, [], "each of these grew by 1,000 characters unmeasured");
  });

  it("refuses lines that appear together on their sum, lets each alone through, and keeps today's number", () => {
    const keys = ["constraints.crowd", "constraints.causal", "constraints.reversal"];
    for (const k of keys) {
      assert.deepEqual(recipeBudgetProblems(recipeFrom(1, { [k]: pad(k, 1200) })), [], `${k} 1,200 characters longer saves on its own`);
    }
    const together = recipeFrom(1, Object.fromEntries(keys.map((k) => [k, pad(k, 1200)])));
    assert.equal(recipeBudgetProblems(together).length, 1, "three lines that can appear together are charged on their sum");
    assert.equal(measureRequiredPromptBudget().worstCase, 1704, "the baseline's measured reserve is unchanged");
    assert.equal(recipeBudgetNeed(BASELINE_RECIPE), 1704);
    assert.deepEqual(recipeBudgetProblems(BASELINE_RECIPE), []);
  });

  it("leaves real room for tuning: a version can add well over a thousand characters (David, 2026-11-12)", () => {
    assert.ok(FIXED_REQUIRED_RESERVE_BUDGET - recipeBudgetNeed(BASELINE_RECIPE) >= 3000);
    assert.deepEqual(recipeBudgetProblems(recipeFrom(1, { "identity.person": pad("identity.person", 1200), "notes.engine": "x".repeat(1200) })), []);
  });
});

describe("a slot filled with a fact's own text appears no more often than today's wording uses it (Codex, PR #926 round 2)", () => {
  it("refuses the reviewer's eight-fold {guidance}, keeps the baseline, and lets the name repeat", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `${i}: {guidance}`).join(" ");
    const problems = recipeProblems({ "text.requireGuided": eight });
    assert.ok(problems.some((p) => /\{guidance\} may appear once/.test(p)), JSON.stringify(problems));
    assert.deepEqual(recipeProblems(BASELINE_PIECES), []);
    assert.deepEqual(recipeProblems({ "constraints.duplicate": "Do not clone {subject}; one {subject} only." }), [], "the name is measured at its longest");
    assert.deepEqual(recipeProblems({ "constraints.agePerson": BASELINE_PIECES["constraints.agePerson"] }), [], "today's double {noun} stays allowed");
  });

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

describe("a recipe cannot drop the fact's own text (build report, PR #926)", () => {
  it("refuses an emptied balloon or guidance piece, and still allows emptying a do-not", () => {
    for (const key of ["bubbles.speech", "bubbles.thought", "text.requireGuided", "text.literal", "text.graphic"]) {
      assert.ok(recipeProblems({ [key]: "  " }).some((p) => /fact's own text/.test(p)), key);
    }
    assert.deepEqual(recipeProblems({ "constraints.causal": "" }), []);
  });
});

describe("the preview's highlighting (plan, A: the recipe's pieces highlighted)", () => {
  it("leaves every captured prompt unchanged once the marks are read out, and marks only wording", async () => {
    const { markRecipe, segmentsOf } = await import("../lib/imagePrompt/recipeHighlight.js");
    const marked = markRecipe(BASELINE_RECIPE);
    let wordingSeen = 0;
    for (const [i, c] of corpus.cases.entries()) {
      const out = compileForSubjectRenderMode({ ...structuredClone(c.args), recipe: marked });
      const segs = segmentsOf(out.prompt);
      assert.equal(segs.map((s) => s.text).join(""), c.prompt, `case ${i}: highlighting changed the prompt`);
      assert.ok(!/[-]/.test(segs.map((s) => s.text).join("")), `case ${i}: a marker leaked`);
      wordingSeen += segs.filter((s) => s.piece).length;
    }
    assert.ok(wordingSeen > corpus.cases.length, "wording is marked in the prompts");
  });

  it("marks a slot's filled value as the fact's text, not as wording", async () => {
    const { markRecipe, segmentsOf } = await import("../lib/imagePrompt/recipeHighlight.js");
    const sample = corpus.cases.find((c) => c.args.input.subjectRenderMode === "human_identity_i2i")!;
    const out = compileForSubjectRenderMode({ ...structuredClone(sample.args), recipe: markRecipe(BASELINE_RECIPE) });
    const segs = segmentsOf(out.prompt);
    const dup = segs.filter((s) => s.piece === "constraints.duplicate").map((s) => s.text).join("|");
    if (dup) assert.ok(!dup.includes(String(sample.args.renderedSubject?.name ?? "\u0000")), "the subject's name is not inside the wording");
    assert.ok(segs.some((s) => s.piece === null && s.text.trim().length > 0), "the fact's own text is unmarked");
  });
});
