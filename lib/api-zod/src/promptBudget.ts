/**
 * Rendered-text prompt budget (rev-7 plan §10) — the save-time contract that
 * guarantees moderator-authored content can never overflow the engine's 6000-char
 * prompt at compile.
 *
 * The budget is enforced on RENDERED text (after token expansion), split into:
 *
 *   PROMPT_TOTAL_BUDGET (6900, = the compiler's MAX_PROMPT_CHARS)
 *     = FIXED_REQUIRED_RESERVE_BUDGET   (compiler-owned fixed sections, MEASURED)
 *     + CORE_SCENE_RENDERED_MAX          (the moderator Concept reserve)
 *     + MODERATOR_ADDITIONS_RENDERED_MAX (all OTHER moderator content, aggregate)
 *     + BUBBLE_DIRECTIVES_RENDERED_MAX   (the SPEECH & THOUGHT BUBBLES reserve)
 *     + PROMPT_OUTER_MARGIN              (outer safety slack)
 *
 * The FIXED reserve is not guessed: `measureRequiredPromptBudget()`
 * (api-server, which owns the compiler) runs the real compiler across all three
 * subject modes at maximum fixed shape (max-bound identity, max style copy, the
 * longest fixed policy branches, the age-transform binding) and a proof test
 * asserts the LIVE measurement + these reserves + margin ≤ PROMPT_TOTAL_BUDGET,
 * so a compiler wording change that grows a required section fails the test
 * instead of silently eating the moderator pool.
 *
 * These reserve numbers are the moderator authoring limits — set behind the §21
 * pre-merge gate (PR generates them from the measurement; David approves them
 * before merge).
 *
 * The save projection (`projectWorstCaseRenderedLength`, promptIdentityBudget.ts)
 * is guaranteed ≥ actual rendered length for every identity within prompt
 * bounds, so any content the save validator accepts cannot overflow at compile;
 * the compiler's own terminal `required_budget_overflow` gate is the final
 * backstop for legacy/pre-cap content.
 */

import { projectWorstCaseRenderedLength } from "./promptIdentityBudget";
import { collectRenderedTextEntries, type VisualPromptStrategyOverride } from "./visualStrategyOverride";

/** Bump when any reserve below changes, so budget fixtures/tests re-derive. */
export const PROMPT_BUDGET_VERSION = 2 as const;

/**
 * The engine's hard prompt ceiling (mirrors the compiler's MAX_PROMPT_CHARS).
 * Raised from the original 4000 (David, 2026-07-21): NB2's actual context
 * window is ~131K tokens (4000 chars is <1% of it) — the ceiling is an editorial
 * forcing function against bloated/redundant authoring, not an engine capacity
 * constraint, so it should have real headroom rather than zero slack.
 * Raised again 6000 → 6900 (David, 2026-07-22) to fund the dedicated
 * SPEECH & THOUGHT BUBBLES reserve below without shrinking any existing
 * moderator pool or the safety margin.
 */
export const PROMPT_TOTAL_BUDGET = 6900;

/**
 * The compiler-owned fixed required overhead reserved out of the budget.
 * DERIVED from `measureRequiredPromptBudget()`: the measured worst case across
 * modes was 1704 chars (human i2i + age-transform binding + 20-char identity +
 * 180-char style + longest fixed policy branches); reserved with cushion.
 * §21-gated.
 */
export const FIXED_REQUIRED_RESERVE_BUDGET = 1750;

/** Outer safety margin (plan §10.4 requires ≥ 100). */
export const PROMPT_OUTER_MARGIN = 750;

/**
 * The rendered-length reserve for the moderator CORE SCENE (Concept). A save is
 * rejected when the Concept's WORST-CASE rendered length exceeds this, even if
 * its raw length is under `CORE_SCENE_RAW_MAX` (100 repeated {NAME} tokens
 * render far longer than 100 chars). §21-gated.
 */
export const CORE_SCENE_RENDERED_MAX = 2000;

/**
 * The aggregate rendered-length reserve for ALL OTHER moderator content
 * (roleBindings, requiredVisualDetails, subjectRealization description,
 * compositionGuidance, styleAgnosticPromptAdditions, negativePromptAdditions,
 * both policy guidances, forbiddenVisualDetails). §21-gated.
 */
export const MODERATOR_ADDITIONS_RENDERED_MAX = 1500;

/**
 * The rendered-length reserve for the SPEECH & THOUGHT BUBBLES section — the
 * COMPILER-EMITTED length of every bubble directive (template wording +
 * attribution + serialized literal text + section label), measured like the
 * additions pool via `measureBubbleDirectivesEmission()` (api-server). Sized
 * for 3 worst-case directives (~300 rendered chars each); `MAX_BUBBLES` (4)
 * stays the schema cap — four bubbles save when their combined measured
 * emission fits this pool, else the save fails with a bubble-specific error.
 * §21-gated (David approved 6900/900, 2026-07-22).
 */
export const BUBBLE_DIRECTIVES_RENDERED_MAX = 900;

/**
 * Raw (pre-render) storage cap for the moderator Concept. Matches the VSO
 * schema's `coreSceneOverride` cap (1500, `visualStrategyOverride.ts`) — with
 * the roomier rendered budget above, a new save is never stricter than legacy
 * content (David, 2026-07-21: restored from the original plan's 1200).
 */
export const CORE_SCENE_RAW_MAX = 1500;

// Compile-time guard: the reserves + margin must fit the total budget. This is a
// literal arithmetic check on the constants above (the LIVE-compiler proof lives
// in the api-server budget test). Kept here as executable documentation.
const _RESERVE_SUM =
  FIXED_REQUIRED_RESERVE_BUDGET +
  CORE_SCENE_RENDERED_MAX +
  MODERATOR_ADDITIONS_RENDERED_MAX +
  BUBBLE_DIRECTIVES_RENDERED_MAX +
  PROMPT_OUTER_MARGIN;
if (_RESERVE_SUM > PROMPT_TOTAL_BUDGET) {
  throw new Error(
    `prompt budget reserves (${_RESERVE_SUM}) exceed PROMPT_TOTAL_BUDGET (${PROMPT_TOTAL_BUDGET}); re-derive the §21 numbers`,
  );
}

// ─── Save-time VSO budget validation (§10.2 / §10.3) ────────────────────────

export type VsoBudgetErrorCode =
  | "core_scene_raw_too_long"
  | "core_scene_rendered_too_long"
  | "moderator_additions_rendered_too_long"
  | "bubble_directives_rendered_too_long";

export interface VsoBudgetError {
  code: VsoBudgetErrorCode;
  /** The offending field path (or "moderatorAdditions" for the aggregate). */
  field: string;
  /** Measured value that broke the cap. */
  actual: number;
  /** The cap that was exceeded. */
  limit: number;
  message: string;
}

export interface VsoBudgetResult {
  ok: boolean;
  errors: VsoBudgetError[];
  /** Diagnostics for a UI counter: projected rendered usage of each pool. */
  usage: {
    coreSceneRendered: number;
    moderatorAdditionsRendered: number;
    bubbleDirectivesRendered: number;
  };
}

/**
 * Naive lower-bound of the additions' rendered length: the sum of each non-core
 * rendered field's worst-case TOKEN expansion, with NO compiler wrapping. This
 * UNDERCOUNTS what the compiler actually emits (it omits the "Do not …"
 * negation prefixes, "label: " role forms, "; " list joins, and the per-section
 * labels that only appear once a field is populated), so it must NOT be used as
 * the save gate — pass `measureModeratorAdditionsEmission()` (api-server, which
 * runs the real compiler) into `validateVisualStrategyOverrideForSave` instead.
 * Exposed only for a cheap client-side "you're getting close" hint.
 */
export function naiveAdditionsRenderedLowerBound(ov: VisualPromptStrategyOverride): number {
  let total = 0;
  for (const { path, value } of collectRenderedTextEntries(ov)) {
    // Core scene and bubbles each have their OWN pool — never counted here.
    if (path === "coreSceneOverride" || path.startsWith("bubbles[")) continue;
    total += projectWorstCaseRenderedLength(value);
  }
  return total;
}

/** Naive lower-bound of the bubbles' rendered length (token expansion only, no
 *  directive-template wrapping) — same caveat as the additions bound: a cheap
 *  client-side "getting close" hint, never the save gate. */
export function naiveBubbleRenderedLowerBound(ov: VisualPromptStrategyOverride): number {
  let total = 0;
  for (const { path, value } of collectRenderedTextEntries(ov)) {
    if (path.startsWith("bubbles[")) total += projectWorstCaseRenderedLength(value);
  }
  return total;
}

/**
 * Validate a visual-strategy override's rendered-text budget at SAVE time
 * (§10.2 / §10.3). Applies, on the override's CURRENT content:
 *   • the CORE SCENE raw cap AND its projected-rendered cap, and
 *   • the aggregate cap for ALL other moderator content, measured as the actual
 *     COMPILER-EMITTED length (`additionsEmittedLength`, from
 *     `measureModeratorAdditionsEmission()` in api-server) — NOT a raw field
 *     sum, so the "Do not …"/"label: "/join/section-label overhead the compiler
 *     adds is counted (Codex P1, PR#224). The caller measures because only
 *     api-server owns the compiler; this function stays pure/testable.
 *
 * Field-level raw caps (roleBinding lengths, list sizes) stay owned by the zod
 * schema. Returns every violation (not just the first) plus projected usage.
 */
export function validateVisualStrategyOverrideForSave(
  ov: VisualPromptStrategyOverride,
  additionsEmittedLength: number,
  bubbleEmittedLength: number,
): VsoBudgetResult {
  const errors: VsoBudgetError[] = [];

  const coreRaw = (ov.coreSceneOverride ?? "").length;
  if (coreRaw > CORE_SCENE_RAW_MAX) {
    errors.push({
      code: "core_scene_raw_too_long",
      field: "coreSceneOverride",
      actual: coreRaw,
      limit: CORE_SCENE_RAW_MAX,
      message: `The Visual Concept is ${coreRaw} characters; the maximum is ${CORE_SCENE_RAW_MAX}.`,
    });
  }

  const coreRendered = ov.coreSceneOverride ? projectWorstCaseRenderedLength(ov.coreSceneOverride) : 0;
  if (coreRendered > CORE_SCENE_RENDERED_MAX) {
    errors.push({
      code: "core_scene_rendered_too_long",
      field: "coreSceneOverride",
      actual: coreRendered,
      limit: CORE_SCENE_RENDERED_MAX,
      message: `The Visual Concept expands to up to ${coreRendered} characters once names/pronouns are filled in; the maximum is ${CORE_SCENE_RENDERED_MAX}. Shorten it or use fewer personalization tokens.`,
    });
  }

  // The COMPILER-EMITTED length of all other moderator content (measured by the
  // caller, wrappers included) — not the raw field sum.
  if (additionsEmittedLength > MODERATOR_ADDITIONS_RENDERED_MAX) {
    errors.push({
      code: "moderator_additions_rendered_too_long",
      field: "moderatorAdditions",
      actual: additionsEmittedLength,
      limit: MODERATOR_ADDITIONS_RENDERED_MAX,
      message: `Your visual guidance (role bindings, required/forbidden details, composition, additions, policy guidance) adds up to ${additionsEmittedLength} characters to the prompt; the combined maximum is ${MODERATOR_ADDITIONS_RENDERED_MAX}. Trim some entries.`,
    });
  }

  // The COMPILER-EMITTED length of the bubble directives (dedicated pool,
  // measured by the caller via measureBubbleDirectivesEmission).
  if (bubbleEmittedLength > BUBBLE_DIRECTIVES_RENDERED_MAX) {
    errors.push({
      code: "bubble_directives_rendered_too_long",
      field: "bubbles",
      actual: bubbleEmittedLength,
      limit: BUBBLE_DIRECTIVES_RENDERED_MAX,
      message: `Your speech/thought bubbles add up to ${bubbleEmittedLength} characters of prompt directives; the combined maximum is ${BUBBLE_DIRECTIVES_RENDERED_MAX}. Shorten the bubble text or remove a bubble.`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    usage: {
      coreSceneRendered: coreRendered,
      moderatorAdditionsRendered: additionsEmittedLength,
      bubbleDirectivesRendered: bubbleEmittedLength,
    },
  };
}
