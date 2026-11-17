// The direct path (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md, Proposed Design A):
// a prompt compiled from one selected gag's content and fixed wording, with no
// planner. These tests hold what the plan's acceptance names for it: the gag
// leads verbatim; every planner-only section and everything increment 3
// removes is absent; the cast binds bubble speakers; an existing bubble's
// directive is the planned path's, byte for byte; the one violence sentence is
// always present; the pet line appears for a pet's photo only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  compileDirect,
  composeBubbleDirective,
  DIRECT_FILL_INSTRUCTION,
  DIRECT_PET_INSTRUCTION,
  type DirectCompileArgs,
} from "../lib/imagePrompt/compilers/nanoBanana2.js";
import { BASELINE_RECIPE, baselineRecipeFor, fillPiece } from "../lib/imagePrompt/recipe.js";
import { VIOLENCE_RULE } from "../lib/imagePrompt/violenceRule.js";

const base = (over: Partial<DirectCompileArgs> = {}): DirectCompileArgs => ({
  gag: { scene: "{NAME} drives {POSS} mom home from the hospital, tiny hands on the wheel.", bubbles: [] },
  cast: [],
  subjectRenderMode: "human_identity_i2i",
  renderedSubject: { name: "David", pronouns: "he/him" },
  referenceImageUrl: "https://example.test/ref.jpg",
  ...over,
});

const ids = (out: ReturnType<typeof compileDirect>) =>
  (out.promptBreakdown ?? []).filter((s) => s.status === "included").map((s) => s.id);

describe("compileDirect", () => {
  it("leads with the gag's scene, token-rendered and otherwise verbatim", () => {
    const out = compileDirect(base());
    assert.ok(out.prompt.startsWith(fillPiece(BASELINE_RECIPE, "shape.section", {
      label: fillPiece(BASELINE_RECIPE, "label.coreScene"),
      body: "David drives his mom home from the hospital, tiny hands on the wheel.",
    })));
    assert.equal(out.referenceImageUrl, "https://example.test/ref.jpg");
  });

  it("emits no planner section and nothing the switch removes", () => {
    const out = compileDirect(base({ renderControls: { negativeSpacePreference: "top" } }));
    assert.deepEqual(ids(out), ["core_scene", "identity_reference", "additional_details", "composition", "render_style", "strict_constraints"]);
    for (const piece of ["binding.agePerson", "binding.singlePerson", "constraints.duplicate", "constraints.roles", "constraints.soleAgent", "constraints.activeAction"] as const) {
      const text = fillPiece(BASELINE_RECIPE, piece, { subject: "David", targetState: "a baby", noun: "baby" });
      assert.ok(!out.prompt.includes(text.slice(0, 40)), `${piece} is absent`);
    }
    assert.ok(out.prompt.includes(DIRECT_FILL_INSTRUCTION));
    assert.ok(out.prompt.includes(fillPiece(BASELINE_RECIPE, "composition.captionSpace", { side: "top" })));
  });

  it("always carries the one violence sentence, with the overlay-text exclusion", () => {
    const out = compileDirect(base({ gag: { scene: "{NAME} waters a houseplant.", bubbles: [] } }));
    assert.ok(out.prompt.includes(VIOLENCE_RULE));
    assert.ok(out.prompt.includes(fillPiece(BASELINE_RECIPE, "text.incidental")));
    assert.ok(!out.prompt.includes(fillPiece(BASELINE_RECIPE, "violence.allow")), "the retired conditional line is not used");
  });

  it("adds the pet line for a pet's photo only", () => {
    assert.ok(!compileDirect(base()).prompt.includes(DIRECT_PET_INSTRUCTION));
    const pet = compileDirect(base({ subjectRenderMode: "nonhuman_subject_i2i", renderedSubject: { name: "Whiskers", pronouns: "they/them" } }));
    assert.ok(pet.prompt.includes(DIRECT_PET_INSTRUCTION));
    assert.ok(pet.prompt.includes(fillPiece(BASELINE_RECIPE, "identity.pet")));
  });

  it("binds each speaker from the cast, and the bubble directive is the planned path's, byte for byte", () => {
    const bubbles = [
      { type: "speech" as const, entity: "mom", text: "Slow down, {NAME}!" },
      { type: "thought" as const, entity: "subject", text: "Nailed it." },
    ];
    const out = compileDirect(base({ gag: { scene: "{NAME} drives; mom grips the dashboard.", bubbles }, cast: [{ label: "mom", description: "the older woman in the passenger seat" }] }));
    assert.ok(out.prompt.includes("mom: the older woman in the passenger seat."));
    assert.ok(out.prompt.includes(composeBubbleDirective({ type: "speech", text: "Slow down, David!" }, "mom")));
    assert.ok(out.prompt.includes(composeBubbleDirective({ type: "thought", text: "Nailed it." }, "David")));
    assert.deepEqual(out.diagnostics?.warnings ?? [], []);
  });

  it("warns, and still renders the balloon, when a speaker has no cast entry", () => {
    const out = compileDirect(base({ gag: { scene: "{NAME} drives.", bubbles: [{ type: "speech", entity: "nurse", text: "Bye!" }] } }));
    assert.equal(out.diagnostics?.warnings?.[0]?.code, "bubble_entity_unresolved");
    assert.ok(out.prompt.includes(composeBubbleDirective({ type: "speech", text: "Bye!" }, "nurse")));
  });

  it("refuses a no-photo render and an empty scene", () => {
    assert.throws(() => compileDirect(base({ subjectRenderMode: "t2i_fallback" })), /retired/);
    assert.throws(() => compileDirect(base({ gag: { scene: "  ", bubbles: [] } })), /scene/);
  });

  it("uses a chosen look in place of the photoreal line, and fits each engine family's wording", () => {
    for (const family of ["gpt-image-2-6", "nano-banana-2-1", "nano-banana-2"]) {
      const r = baselineRecipeFor(family);
      const plain = compileDirect(base({ recipe: r }));
      assert.ok(plain.prompt.includes(fillPiece(r, "style.photoreal")), family);
      const styled = compileDirect(base({ recipe: r, stylePrompt: "Rendered as a 1950s comic book panel." }));
      assert.ok(styled.prompt.includes("Rendered as a 1950s comic book panel."), family);
      assert.equal(styled.diagnostics?.requiredBudgetOverflow, undefined, family);
    }
  });
});
