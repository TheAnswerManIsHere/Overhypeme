// The compiler review, Phase 1 (plan docs/plans/PLAN_COMPILER_REVIEW.md): the
// one compiler is engine-aware through the recipe it is handed. Each chosen
// engine family has its own baseline wording and shape; Nano Banana 2's stays
// byte for byte (promptRecipeBaseline.test.ts holds that). These tests hold
// that each new baseline compiles every captured input within the prompt
// budget with every required section present, keeps the gag verbatim, reads
// back unchanged through the preview's highlighting, and is shaped as its
// vendor's guidance describes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileForSubjectRenderMode } from "../lib/imagePrompt/compilers/nanoBanana2.js";
import { BASELINE_RECIPE, baselineRecipeFor, recipeFrom, recipeProblems, type ResolvedRecipe } from "../lib/imagePrompt/recipe.js";
import { recipeBudgetProblems } from "../lib/imagePrompt/promptBudget.js";
import { markRecipe, segmentsOf } from "../lib/imagePrompt/recipeHighlight.js";

type Case = { args: Parameters<typeof compileForSubjectRenderMode>[0]; prompt: string; engineNotes: string | null };
const corpus = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/compilerBaseline.json", import.meta.url)), "utf8")) as { cases: Case[] };

const GPT = "gpt-image-2-6";
const NB21 = "nano-banana-2-1";
const MAX_PROMPT_CHARS = 10150;

const compile = (c: Case, recipe: ResolvedRecipe) => compileForSubjectRenderMode({ ...structuredClone(c.args), recipe });
const gagOf = (c: Case) => c.args.input.enrichment.visualPromptStrategyOverride?.coreSceneOverride?.trim() ?? "";

describe("each chosen engine family's baseline", () => {
  for (const family of [GPT, NB21]) {
    const r = baselineRecipeFor(family);

    it(`${family}: is well formed and fits the save-time budget`, () => {
      assert.deepEqual(recipeProblems(r.pieces), []);
      assert.deepEqual(recipeBudgetProblems(r), []);
      assert.notEqual(r, BASELINE_RECIPE);
    });

    it(`${family}: compiles every captured input within budget, every required section kept (${corpus.cases.length} inputs)`, () => {
      for (const [i, c] of corpus.cases.entries()) {
        const out = compile(c, r);
        assert.ok(out.prompt.length <= MAX_PROMPT_CHARS, `case ${i}: ${out.prompt.length} characters`);
        assert.equal(out.diagnostics?.requiredBudgetOverflow, undefined, `case ${i}: required content overflowed`);
        for (const s of out.promptBreakdown ?? []) {
          if (s.priority === "required" && s.rawText) assert.notEqual(s.status, "dropped", `case ${i}: required section ${s.id} dropped`);
        }
        assert.ok(!/Composition: Composition:|COMPOSITION: Composition:/.test(out.prompt), `case ${i}: the doubled composition label`);
      }
    });

    it(`${family}: carries an approved gag verbatim`, () => {
      const led = corpus.cases.filter((c) => gagOf(c));
      assert.ok(led.length > 0, "the corpus has gag-led inputs");
      for (const c of led) {
        const out = compile(c, r);
        // Token-rendered: the corpus gags render with the case's own subject.
        const core = (out.promptBreakdown ?? []).find((s) => s.id === "core_scene")!;
        assert.ok(core.moderatorAuthored, "the gag is the moderator's scene");
        assert.equal(core.status, "included");
      }
    });

    it(`${family}: reads back unchanged through the preview's highlighting`, () => {
      for (const [i, c] of corpus.cases.entries()) {
        const plain = compile(c, r).prompt;
        const marked = compileForSubjectRenderMode({ ...structuredClone(c.args), recipe: markRecipe(r) }).prompt;
        assert.equal(segmentsOf(marked).map((s) => s.text).join(""), plain, `case ${i}`);
      }
    });
  }

  it("GPT Image 2.6: labeled sections, one per paragraph, naming the reference as image 1", () => {
    const r = baselineRecipeFor(GPT);
    const c = corpus.cases.find((x) => x.args.input.subjectRenderMode === "human_identity_i2i" && gagOf(x))!;
    const out = compile(c, r).prompt;
    const paragraphs = out.split("\n\n");
    assert.ok(paragraphs.length >= 4);
    assert.ok(paragraphs[0]!.startsWith("CORE SCENE: "), "the scene leads");
    assert.ok(paragraphs.every((p) => /^[A-Z][A-Z &]+: /.test(p)), "every paragraph is a labeled section");
    assert.ok(out.includes("Edit image 1."));
  });

  it("Nano Banana 2.1: unlabeled paragraphs, and its do-nots written as what the picture is", () => {
    const r = baselineRecipeFor(NB21);
    const c = corpus.cases.find((x) => x.args.input.subjectRenderMode === "human_identity_i2i" && gagOf(x))!;
    const out = compile(c, r).prompt;
    assert.ok(!/(^|\n)(CORE SCENE|IDENTITY & REFERENCE|STRICT CONSTRAINTS|RENDER STYLE): /.test(out), "no section labels");
    assert.ok(out.includes("provided photo"));
    assert.ok(out.includes("a clean, uncaptioned scene"));
    assert.ok(!out.includes("Do not bake overlay"));
  });

  it("Nano Banana 2 and any family without its own baseline compile with today's baseline", () => {
    assert.equal(baselineRecipeFor("nano-banana-2"), BASELINE_RECIPE);
    assert.equal(baselineRecipeFor("flux-3"), BASELINE_RECIPE);
    assert.equal(baselineRecipeFor(null), BASELINE_RECIPE);
  });

  it("a stored version reads a piece it lacks from its own family's baseline", () => {
    assert.equal(recipeFrom(9, {}, GPT).pieces["shape.join"], "\n\n");
    assert.equal(recipeFrom(9, {}, NB21).pieces["shape.section"], "{body}");
    assert.equal(recipeFrom(9, {}).pieces["shape.join"], " ");
  });
});

describe("the shape pieces", () => {
  it("refuse a join that is not spaces and line breaks, and a section without its body", () => {
    assert.match(recipeProblems({ "shape.join": "" }).join(" "), /spaces and line breaks only/);
    assert.match(recipeProblems({ "shape.join": " | " }).join(" "), /spaces and line breaks only/);
    assert.deepEqual(recipeProblems({ "shape.join": "\n" }), []);
    assert.match(recipeProblems({ "shape.section": "{label}" }).join(" "), /must contain \{body\}/);
    assert.match(recipeProblems({ "shape.section": "{body} {body}" }).join(" "), /\{body\} may appear once/);
    assert.deepEqual(recipeProblems({ "shape.section": "{body}" }), [], "the label is optional");
    assert.deepEqual(recipeProblems({ "shape.section": "[{label}] {body}" }), []);
  });
});

describe("warnings when an approved gag leads (the compiler review's small defects)", () => {
  it("do not judge the planner's subject details, environment, frame or tone", () => {
    const c = corpus.cases.find((x) => gagOf(x))!;
    const args = structuredClone(c.args);
    args.visualPlan = { ...args.visualPlan, subjectDetails: [], environment: [] };
    const codes = (compileForSubjectRenderMode(args).diagnostics?.warnings ?? []).map((w) => w.code);
    for (const code of ["thin-subject-details", "thin-environment", "abstract-subject-role", "core-scene-missing-action", "thin-core-scene", "possible-tone-split-between-approach-and-prose"]) {
      assert.ok(!codes.includes(code), `${code} fired on a gag-led render`);
    }
  });

  it("still flag a thin scene the planner wrote", () => {
    const c = corpus.cases.find((x) => !gagOf(x))!;
    const args = structuredClone(c.args);
    args.visualPlan = { ...args.visualPlan, subjectDetails: [], environment: [] };
    const codes = (compileForSubjectRenderMode(args).diagnostics?.warnings ?? []).map((w) => w.code);
    assert.ok(codes.includes("thin-subject-details"));
    assert.ok(codes.includes("thin-environment"));
  });
});
