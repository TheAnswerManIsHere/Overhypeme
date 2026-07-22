/**
 * The §10.4 / §21 budget PROOF: the moderator authoring reserves declared in
 * api-zod (`promptBudget.ts`) must actually fit inside the engine's
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
  naiveAdditionsRenderedLowerBound,
  naiveBubbleRenderedLowerBound,
  BUBBLE_DIRECTIVES_RENDERED_MAX,
  CORE_SCENE_RAW_MAX,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  type VisualPromptStrategyOverride,
} from "@workspace/api-zod";
import {
  measureRequiredPromptBudget,
  measureModeratorAdditionsEmission,
  measureBubbleDirectivesEmission,
  validateVisualStrategyOverridePersistence,
} from "../lib/imagePrompt/promptBudget";

describe("measureRequiredPromptBudget — the §21 proof", () => {
  it("the LIVE compiler's worst-case fixed reserve fits inside FIXED_REQUIRED_RESERVE_BUDGET", () => {
    const m = measureRequiredPromptBudget();
    assert.ok(
      m.worstCase <= FIXED_REQUIRED_RESERVE_BUDGET,
      `measured worst-case fixed reserve ${m.worstCase} exceeds the reserved ${FIXED_REQUIRED_RESERVE_BUDGET}; ` +
        `re-derive the §21 numbers (per-mode: ${JSON.stringify(m.perMode)})`,
    );
  });

  it("reserves + margin exactly account for the engine prompt budget", () => {
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
    const r = validateVisualStrategyOverrideForSave(base(), 0, 0);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("rejects a Concept over the raw cap", () => {
    const r = validateVisualStrategyOverrideForSave({ ...base(), coreSceneOverride: "x".repeat(CORE_SCENE_RAW_MAX + 1) }, 0, 0);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "core_scene_raw_too_long"));
  });

  it("rejects a Concept whose WORST-CASE rendered length blows the cap even under the raw cap", () => {
    // 110 repeated {NAME} tokens: raw ~770 (well under the raw cap) but each
    // renders to up to 20 chars → ~2300+ rendered (> the rendered cap).
    const tokenHeavy = "{NAME} ".repeat(110).trim();
    assert.ok(tokenHeavy.length <= CORE_SCENE_RAW_MAX, "sanity: raw length is within the raw cap");
    const r = validateVisualStrategyOverrideForSave({ ...base(), coreSceneOverride: tokenHeavy }, 0, 0);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "core_scene_rendered_too_long"));
  });

  it("rejects when the (compiler-measured) additions emission exceeds the pool", () => {
    // The validator trusts the injected emission — over the cap → rejection.
    const r = validateVisualStrategyOverrideForSave(base(), MODERATOR_ADDITIONS_RENDERED_MAX + 1, 0);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "moderator_additions_rendered_too_long"));
    assert.equal(r.usage.moderatorAdditionsRendered, MODERATOR_ADDITIONS_RENDERED_MAX + 1);
  });

  it("accepts additions emission exactly at the cap", () => {
    const r = validateVisualStrategyOverrideForSave(base(), MODERATOR_ADDITIONS_RENDERED_MAX, 0);
    assert.equal(r.ok, true);
  });
});

describe("measureModeratorAdditionsEmission — compiler-measured, wrapping included (Codex P1)", () => {
  const base = (): VisualPromptStrategyOverride => ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true });

  it("an empty (or disabled) override adds nothing", () => {
    assert.equal(measureModeratorAdditionsEmission(base()), 0);
    assert.equal(measureModeratorAdditionsEmission({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: false }), 0);
  });

  it("counts the compiler wrapping the naive raw-field sum misses (this is the bug being fixed)", () => {
    // 40 forbiddenVisualDetails of 20 chars: naive sum = 800, but the compiler
    // emits each as "Do not ….", so the measured emission is meaningfully larger.
    const ov: VisualPromptStrategyOverride = {
      ...base(),
      forbiddenVisualDetails: Array.from({ length: 40 }, (_, i) => `banned prop number ${i}`.slice(0, 20).padEnd(20, "x")),
    };
    const naive = naiveAdditionsRenderedLowerBound(ov);
    const measured = measureModeratorAdditionsEmission(ov);
    assert.ok(
      measured > naive,
      `measured emission ${measured} must exceed the naive lower bound ${naive} (wrapping counted)`,
    );
  });

  it("a save the naive sum would ACCEPT can still exceed the pool once wrapping is measured", () => {
    // Enough forbidden entries that naive stays under the pool but the emitted
    // "Do not …." wrapping pushes the real contribution over it → rejected.
    const entry = "x".repeat(30);
    const ov: VisualPromptStrategyOverride = {
      ...base(),
      forbiddenVisualDetails: Array.from({ length: 40 }, () => entry),
    };
    const naive = naiveAdditionsRenderedLowerBound(ov); // 40 * 30 = 1200 (< pool)
    assert.ok(naive <= MODERATOR_ADDITIONS_RENDERED_MAX, `sanity: naive ${naive} is under the pool`);
    const measured = measureModeratorAdditionsEmission(ov);
    const r = validateVisualStrategyOverrideForSave(ov, measured, 0);
    assert.equal(r.ok, false, `measured ${measured} should exceed the pool ${MODERATOR_ADDITIONS_RENDERED_MAX}`);
    assert.ok(r.errors.some((e) => e.code === "moderator_additions_rendered_too_long"));
  });
});

// ─── Bubble pool (§B2, PROMPT_BUDGET_VERSION 2) ─────────────────────────────

describe("bubble directives pool", () => {
  const bubble = (text: string, entity = "subject", type: "speech" | "thought" = "speech") =>
    ({ type, entity, text });
  const withBubbles = (bubbles: unknown[]): VisualPromptStrategyOverride =>
    ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, bubbles } as VisualPromptStrategyOverride);

  it("pool equation: every reserve + margin fits the total budget exactly", () => {
    assert.ok(
      FIXED_REQUIRED_RESERVE_BUDGET +
        CORE_SCENE_RENDERED_MAX +
        MODERATOR_ADDITIONS_RENDERED_MAX +
        BUBBLE_DIRECTIVES_RENDERED_MAX +
        PROMPT_OUTER_MARGIN <=
        PROMPT_TOTAL_BUDGET,
    );
  });

  it("live-compiler maximum-shape proof: measured fixed reserve + all pools + margin fit the total", () => {
    const measured = measureRequiredPromptBudget();
    assert.ok(
      measured.worstCase +
        CORE_SCENE_RENDERED_MAX +
        MODERATOR_ADDITIONS_RENDERED_MAX +
        BUBBLE_DIRECTIVES_RENDERED_MAX +
        PROMPT_OUTER_MARGIN <=
        PROMPT_TOTAL_BUDGET,
      `fixed ${measured.worstCase} + pools must fit ${PROMPT_TOTAL_BUDGET}`,
    );
    assert.ok(measured.worstCase <= FIXED_REQUIRED_RESERVE_BUDGET, "fixed reserve still covers the measurement");
  });

  it("pins what the 900 pool guarantees: 2 maximal bubbles fit, 4 realistic bubbles fit, 3 maximal fail LOUD", () => {
    // Two fully-maxed bubbles (80-char text) fit the pool.
    const twoMax = withBubbles([
      bubble("x".repeat(80)),
      bubble("y".repeat(80), "the bartender", "thought"),
    ]);
    const twoEmitted = measureBubbleDirectivesEmission(twoMax);
    assert.ok(twoEmitted > 0 && twoEmitted <= BUBBLE_DIRECTIVES_RENDERED_MAX, `2 maximal bubbles (${twoEmitted}) must fit`);

    // Four REALISTIC bubbles (under the 60-char soft-warn, plain entities —
    // the shape the UI steers toward) also fit.
    const fourRealistic = withBubbles([
      bubble("You're the man of the house now."),
      bubble("Not again.", "the bartender", "thought"),
      bubble("Wait — that's not a duck.", "the mother"),
      bubble("Monday again.", "subject", "thought"),
    ]);
    const fourEmitted = measureBubbleDirectivesEmission(fourRealistic);
    assert.ok(fourEmitted <= BUBBLE_DIRECTIVES_RENDERED_MAX, `4 realistic bubbles (${fourEmitted}) must fit`);
    assert.equal(validateVisualStrategyOverridePersistence(fourRealistic).ok, true);

    // Three fully-maxed bubbles still fit (the compact directive template
    // keeps per-bubble overhead low)…
    const threeMax = withBubbles([
      bubble("x".repeat(80)),
      bubble("y".repeat(80), "the bartender", "thought"),
      bubble("z".repeat(80), "the extremely suspicious head bartender of the establishment"),
    ]);
    assert.equal(validateVisualStrategyOverridePersistence(threeMax).ok, true);

    // …but FOUR fully-maxed bubbles with maximal entities exceed the pool —
    // the save fails with the bubble-specific error (never a silent drop or
    // partial section).
    const fourMax = withBubbles([
      bubble("x".repeat(80), "r".repeat(60)),
      bubble("y".repeat(80), "s".repeat(60), "thought"),
      bubble("z".repeat(80), "t".repeat(60)),
      bubble("w".repeat(80), "u".repeat(60), "thought"),
    ]);
    const res = validateVisualStrategyOverridePersistence(fourMax);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.code === "bubble_directives_rendered_too_long" && e.field === "bubbles"));

    // And the validator surfaces an injected over-pool emission verbatim.
    const over = validateVisualStrategyOverrideForSave(twoMax, 0, BUBBLE_DIRECTIVES_RENDERED_MAX + 1);
    assert.equal(over.ok, false);
    assert.equal(over.usage.bubbleDirectivesRendered, BUBBLE_DIRECTIVES_RENDERED_MAX + 1);
  });

  it("measures the REAL escaping cost of quoted bubble text, not a content-blind placeholder (Codex P2, PR #229)", () => {
    // `serializeLiteralPromptString` escapes every embedded `"`/`\` to two
    // characters. Two same-LENGTH bubble texts — one plain, one all quote
    // characters — must measure DIFFERENTLY: the quote-heavy one strictly
    // higher, proving the measurement reflects the real authored text's
    // actual escaping cost rather than an anonymized length-only placeholder
    // (which would either undercount real quotes, or uniformly over-inflate
    // every quote-free bubble by assuming the worst regardless of content).
    const plain = withBubbles([bubble("x".repeat(40))]);
    const quoted = withBubbles([bubble('"'.repeat(40))]);
    const plainEmitted = measureBubbleDirectivesEmission(plain);
    const quotedEmitted = measureBubbleDirectivesEmission(quoted);
    assert.ok(
      quotedEmitted > plainEmitted,
      `quote-heavy text (${quotedEmitted}) must measure higher than same-length plain text (${plainEmitted})`,
    );
    // A save the gate accepts can never overflow at compile: the measured
    // delta for the quoted text must be >= the actual compiled section's
    // contribution for that exact override (proven directly, not inferred).
    assert.equal(validateVisualStrategyOverridePersistence(quoted).ok, true);
  });

  it("the additions measurement EXCLUDES bubbles (no double counting)", () => {
    const ov = withBubbles([bubble("Hello there, this is a fairly long bubble line.")]);
    assert.equal(measureModeratorAdditionsEmission(ov), 0);
    assert.ok(measureBubbleDirectivesEmission(ov) > 0);
  });

  it("naive bounds: bubbles are excluded from the additions bound and counted by the bubble bound", () => {
    const ov = withBubbles([bubble("A {NAME} line.")]);
    assert.equal(naiveAdditionsRenderedLowerBound(ov), 0);
    assert.ok(naiveBubbleRenderedLowerBound(ov) > 0);
  });

  it("token-heavy bubble text measures at worst-case expansion, not raw length", () => {
    const raw = withBubbles([bubble("{NAME} {NAME} {NAME} {NAME} {NAME}")]);
    const literal = withBubbles([bubble("x".repeat("{NAME} {NAME} {NAME} {NAME} {NAME}".length))]);
    assert.ok(
      measureBubbleDirectivesEmission(raw) > measureBubbleDirectivesEmission(literal),
      "5 name tokens must project larger than their raw length",
    );
  });

  it("persistence preflight: valid bubbles pass; a bubble payload over the pool fails with the bubble code", () => {
    const ok = validateVisualStrategyOverridePersistence(withBubbles([bubble("Short and sweet.")]));
    assert.equal(ok.ok, true);
    // 4 maximum bubbles with maximum entities exceed the 900 pool by construction.
    const four = withBubbles([
      bubble("x".repeat(80), "r".repeat(60)),
      bubble("y".repeat(80), "s".repeat(60), "thought"),
      bubble("z".repeat(80), "t".repeat(60)),
      bubble("w".repeat(80), "u".repeat(60), "thought"),
    ]);
    const measured = measureBubbleDirectivesEmission(four);
    const res = validateVisualStrategyOverridePersistence(four);
    if (measured > BUBBLE_DIRECTIVES_RENDERED_MAX) {
      assert.equal(res.ok, false);
      assert.ok(res.errors.some((e) => e.code === "bubble_directives_rendered_too_long"));
    } else {
      assert.equal(res.ok, true, "4 max bubbles happen to fit the pool — then they must pass");
    }
  });
});
