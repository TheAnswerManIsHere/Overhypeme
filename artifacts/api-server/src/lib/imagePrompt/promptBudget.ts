/**
 * `measureRequiredPromptBudget()` — the measured proof behind the §10.4 / §21
 * budget numbers, on the direct compile (plan PLAN_GAG_DIRECT_RENDER.md, D).
 *
 * The api-zod `promptBudget.ts` declares the authoring reserves
 * (FIXED_REQUIRED_RESERVE_BUDGET, CORE_SCENE_RENDERED_MAX, …) but CANNOT measure
 * the compiler's fixed overhead — the compiler lives here. This helper runs the
 * REAL compiler in both subject render modes at MAXIMUM fixed shape:
 *   • the gag's scene and bubbles out (each has its own reserve), and no cast
 *     (speaker bindings have their own reserve);
 *   • the render identity at its bound (a RENDERED_IDENTITY_NAME_MAX-char name);
 *   • the render style at its bound (RENDER_STYLE_COPY_MAX_CHARS), and none;
 *   • caption space asked for, so its line emits.
 *
 * It returns the per-mode measured length and the worst-case max. A proof test
 * asserts the reserves fit PROMPT_TOTAL_BUDGET, so a compiler wording change
 * that grows a required section fails the test instead of silently eating the
 * scene's pool.
 */

import type { VisualPromptStrategyOverride } from "@workspace/api-zod";
import {
  RENDERED_IDENTITY_NAME_MAX,
  collectRenderedTextEntries,
  setRenderedTextAtPath,
  projectWorstCaseRenderedText,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  FIXED_REQUIRED_RESERVE_BUDGET,
  MAX_BUBBLES,
  validateVisualStrategyOverrideForSave,
  type VisualStrategyBubble,
  type VsoBudgetResult,
} from "@workspace/api-zod";
import { compileDirect } from "./compilers/nanoBanana2";
import { RENDER_STYLE_COPY_MAX_CHARS } from "./styleResolution";
import { BASELINE_RECIPE, type ResolvedRecipe } from "./recipe";

export type SubjectRenderModeKey = "human_identity_i2i" | "nonhuman_subject_i2i";

const MODES: readonly SubjectRenderModeKey[] = ["human_identity_i2i", "nonhuman_subject_i2i"];

export interface RequiredPromptBudgetMeasurement {
  /** Measured fixed-required prompt length per mode. */
  perMode: Record<SubjectRenderModeKey, number>;
  /** The worst-case (largest) fixed reserve across modes — the number to reserve. */
  worstCase: number;
}

/**
 * The scene stand-in a measurement compiles with: the direct compile needs a
 * scene, and the scene has its own reserve (CORE_SCENE_RENDERED_MAX), so its
 * one character is taken back off every fixed measurement.
 */
const SCENE_STAND_IN = "x";

/**
 * The length of the direct prompt for one fixed shape: no cast (speaker
 * bindings have their own reserve), the identity at its bound, caption space
 * asked for (its line emits), and the look given.
 */
function directLength(
  mode: SubjectRenderModeKey,
  bubbles: readonly VisualStrategyBubble[],
  recipe: ResolvedRecipe,
  stylePrompt: string,
): number {
  return compileDirect({
    gag: { scene: SCENE_STAND_IN, bubbles },
    cast: [],
    subjectRenderMode: mode,
    stylePrompt,
    renderControls: { negativeSpacePreference: "bottom" },
    referenceImageUrl: "https://example.com/ref.png",
    renderedSubject: { name: "N".repeat(RENDERED_IDENTITY_NAME_MAX), pronouns: "they/them" },
    recipe,
  }).imagePrompt!.length;
}

/**
 * The compiler's worst-case fixed reserve, per mode: the direct prompt with
 * the gag's scene and bubbles taken out. Each mode is measured with a chosen
 * look at its longest and with no look (the recipe's own photoreal line), and
 * the longer counts.
 */
export function measureRequiredPromptBudget(recipe: ResolvedRecipe = BASELINE_RECIPE): RequiredPromptBudgetMeasurement {
  const styles = ["S".repeat(RENDER_STYLE_COPY_MAX_CHARS), ""];
  const fixed = (mode: SubjectRenderModeKey) =>
    Math.max(...styles.map((s) => directLength(mode, [], recipe, s))) - SCENE_STAND_IN.length;
  const perMode = { human_identity_i2i: fixed("human_identity_i2i"), nonhuman_subject_i2i: fixed("nonhuman_subject_i2i") };
  return { perMode, worstCase: Math.max(perMode.human_identity_i2i, perMode.nonhuman_subject_i2i) };
}

/**
 * The number of characters the gag's SPEECH & THOUGHT BUBBLES actually add to
 * the compiled prompt at worst case — the compiler-emitted directives
 * (template wording + attribution + serialized literal + section label), with
 * bubble text projected to its worst-case token expansion. Delta method: the
 * prompt with the bubbles less the prompt without them, everything else held
 * fixed. This is the `bubbleEmittedLength` input to
 * `validateVisualStrategyOverrideForSave`.
 */
export function measureBubbleDirectivesEmission(ov: VisualPromptStrategyOverride, recipe: ResolvedRecipe = BASELINE_RECIPE): number {
  if ((ov.bubbles ?? []).length === 0) return 0;
  let projected: VisualPromptStrategyOverride = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, bubbles: ov.bubbles };
  for (const { path, value } of collectRenderedTextEntries(projected)) {
    if (!path.startsWith("bubbles[")) continue;
    if (path.endsWith(".entity")) {
      // Entities are never escaped (composeBubbleDirective inserts the
      // attribution noun raw); only their worst-case ATTRIBUTION TARGET length
      // matters: a role label emits as itself, but "subject" emits as the
      // rendered subject name (up to RENDERED_IDENTITY_NAME_MAX).
      projected = setRenderedTextAtPath(projected, path, "x".repeat(Math.max(value.length, RENDERED_IDENTITY_NAME_MAX)));
      continue;
    }
    // Text runs through `serializeLiteralPromptString`, which escapes every
    // embedded `"`/`\` to two characters, so the placeholder keeps the real
    // literal characters and substitutes only the token expansion (Codex P2,
    // PR #229).
    projected = setRenderedTextAtPath(projected, path, projectWorstCaseRenderedText(value));
  }
  let worst = 0;
  for (const mode of MODES) {
    worst = Math.max(worst, directLength(mode, projected.bubbles ?? [], recipe, "") - directLength(mode, [], recipe, ""));
  }
  return Math.max(0, worst);
}

// ─── The one server-side VSO persistence preflight ──────────────────────────

/**
 * The single authoritative save/pick gate for a gag's content: measures the
 * bubble emission through the REAL compiler and runs the pure api-zod budget
 * validator on it. The eleven old "More art direction" fields reach no prompt
 * since the switch (plan PLAN_GAG_DIRECT_RENDER.md, D), so they emit nothing. Every surface that persists
 * or promises to persist a VSO — the admin fact enrichment PATCH, the
 * review-candidate enrichment PATCH, and candidate-concept pickability — calls
 * THIS helper, so "valid to pick" and "valid to save" can never drift.
 * An all-empty override validates trivially (nothing is emitted at compile);
 * the core scene has its own raw/rendered caps, checked independent of anything.
 */
export function validateVisualStrategyOverridePersistence(
  ov: VisualPromptStrategyOverride,
): VsoBudgetResult {
  return validateVisualStrategyOverrideForSave(
    ov,
    0,
    measureBubbleDirectivesEmission(ov),
  );
}

// ─── Prompt recipes (the prompt tuner) ───────────────────────────────────────

/**
 * The balloon probes: the most balloons a gag can have, all of one kind
 * (either template can grow alone, and the two never both fill the section).
 * What a recipe is charged is its GROWTH over the baseline's own lines, which
 * the outer margin already absorbs. Every recipe piece the direct compile can
 * emit is in the fixed shape or in one of these (the per-piece sweep in
 * promptRecipes.test.ts holds that true as pieces are added).
 */
const balloons = (type: "speech" | "thought"): VisualPromptStrategyOverride =>
  ({ ...EMPTY_VISUAL_STRATEGY_OVERRIDE, bubbles: Array.from({ length: MAX_BUBBLES }, () => ({ entity: "subject", text: "x", type })) }) as VisualPromptStrategyOverride;

/** How much longer a balloon probe's lines are under `recipe` than under the baseline, at worst. */
function recipeGrowth(probe: VisualPromptStrategyOverride, recipe: ResolvedRecipe): number {
  return measureBubbleDirectivesEmission(probe, recipe) - measureBubbleDirectivesEmission(probe, BASELINE_RECIPE);
}

/**
 * The characters of fixed wording a recipe needs at its longest: its fixed
 * sections measured at maximum shape, plus the most its balloon lines grow
 * beyond the baseline's.
 */
export function recipeBudgetNeed(recipe: ResolvedRecipe): number {
  const fixed = measureRequiredPromptBudget(recipe).worstCase;
  const growth = Math.max(0, recipeGrowth(balloons("speech"), recipe), recipeGrowth(balloons("thought"), recipe));
  return fixed + growth;
}

/**
 * Whether a prompt recipe keeps the prompt-budget guarantee (plan
 * `docs/plans/PLAN_PROMPT_TUNER.md`, *Security, permissions, validation*:
 * "across every mode and conditional clause"). Charged: the recipe's fixed
 * wording at its longest (with a chosen look and with none), plus the most
 * its balloon lines grow beyond the baseline's. The total must
 * fit `FIXED_REQUIRED_RESERVE_BUDGET`. Together with the form rule that a
 * slot filled with a fact's own text appears no more often than today's
 * wording uses it (`recipeProblems`), every scene and balloon already valid
 * to save still fits. A one-fact preview is never the gate. Empty
 * means it fits.
 */
export function recipeBudgetProblems(recipe: ResolvedRecipe, reserve: number = FIXED_REQUIRED_RESERVE_BUDGET): string[] {
  const total = recipeBudgetNeed(recipe);
  if (total <= reserve) return [];
  const baseline = measureRequiredPromptBudget().worstCase;
  return [
    `This wording is too long for the prompt: at its longest it needs ${total} characters of fixed wording, and ${reserve} are set aside (today's wording needs ${baseline}). Shorten it by at least ${total - reserve} characters.`,
  ];
}
