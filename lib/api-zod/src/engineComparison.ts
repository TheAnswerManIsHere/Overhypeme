/**
 * Launch Phase 8 — the engine comparison's wire vocabulary (plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D).
 * Shared by the admin routes and the admin page.
 */
import { z } from "zod";
import { RENDER_SCENARIO_KEYS, renderScenarioKeySchema, type RenderScenarioKey } from "./renderScenarios";

/**
 * The six engine families David shortlisted (2026-11-06), the control last;
 * GPT Image 2.6 in place of 2.5 (David, 2026-11-10).
 */
export const COMPARISON_DEFAULT_FAMILIES = [
  "gpt-image-2-6",
  "nano-banana-2-1",
  "flux-3",
  "seedream-5-pro",
  "muse-image",
  "nano-banana-2",
] as const;

/** The plan's rounds: round 1 is every scenario unstyled, round 2 the stylisation round. */
export const COMPARISON_ROUND_PRESETS: Record<1 | 2, { scenarioKeys: readonly RenderScenarioKey[]; lookStyleIds: readonly string[] }> = {
  1: { scenarioKeys: RENDER_SCENARIO_KEYS, lookStyleIds: ["none"] },
  2: { scenarioKeys: ["generic_t2i", "i2i_male_default"], lookStyleIds: ["anime", "3d-cartoon", "caricature"] },
};

/**
 * The size a set's pictures are drawn at: the evaluation's own (about 1
 * megapixel) or a member's (about 4), so a set can measure what members'
 * pictures really cost (David, 2026-11-11).
 */
export const COMPARISON_IMAGE_SIZES = ["comparison", "final"] as const;
export type ComparisonImageSize = (typeof COMPARISON_IMAGE_SIZES)[number];

/** What a set compares: engines, each with its live wording, or prompt versions on one engine. */
export const COMPARISON_SET_KINDS = ["engine", "prompt"] as const;
export type ComparisonSetKind = (typeof COMPARISON_SET_KINDS)[number];

export const comparisonSetCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  factIds: z.array(z.number().int().positive()).min(1).max(10),
  scenarioKeys: z.array(renderScenarioKeySchema).min(1),
  lookStyleIds: z.array(z.string().trim().min(1).max(64)).min(1),
  engineFamilies: z.array(z.string().trim().min(1).max(64)).min(1),
  /** Omitted means "comparison". */
  imageSize: z.enum(COMPARISON_IMAGE_SIZES).optional(),
  /**
   * "engine" (the default): each family draws with its live prompt wording.
   * "prompt": one family, and each of `recipeVersionIds` (null for the
   * baseline) draws the same scene (the prompt tuner).
   */
  kind: z.enum(COMPARISON_SET_KINDS).optional(),
  recipeVersionIds: z.array(z.number().int().positive().nullable()).min(2).max(4).optional(),
}).strict().superRefine((v, ctx) => {
  if (v.kind === "prompt") {
    if (v.engineFamilies.length !== 1) ctx.addIssue({ code: "custom", path: ["engineFamilies"], message: "a prompt comparison names exactly one engine family" });
    if (!v.recipeVersionIds) ctx.addIssue({ code: "custom", path: ["recipeVersionIds"], message: "a prompt comparison names two or more versions" });
    else if (new Set(v.recipeVersionIds.map((id) => id ?? 0)).size !== v.recipeVersionIds.length) ctx.addIssue({ code: "custom", path: ["recipeVersionIds"], message: "each version once" });
  } else if (v.recipeVersionIds) {
    ctx.addIssue({ code: "custom", path: ["recipeVersionIds"], message: "versions are named only on a prompt comparison" });
  }
});
export type ComparisonSetCreate = z.infer<typeof comparisonSetCreateSchema>;

export const comparisonRunPlanSchema = z.object({
  /**
   * "prepare": every panel still to prepare; "render": every cell still to
   * render; "full": both at once, each cell queued the moment its panel is
   * prepared (the Eval page's one Generate Images button, PLAN_EVAL_PAGE.md C). No allowance or week figure: pricing does not gate a comparison
   * run (David, 2026-11-07, `decisions.md`).
   */
  kind: z.enum(["prepare", "render", "full"]),
}).strict();
export type ComparisonRunPlanRequest = z.infer<typeof comparisonRunPlanSchema>;

export const COMPARISON_PANEL_STATES = ["pending", "preparing", "planning", "prepared", "failed", "skipped"] as const;
/** "waiting": admitted with its panel's preparation, queued once the panel is prepared. */
export const COMPARISON_CELL_STATES = ["expected", "waiting", "enqueued", "rendered", "failed", "skipped"] as const;
export type ComparisonPanelState = (typeof COMPARISON_PANEL_STATES)[number];
export type ComparisonCellState = (typeof COMPARISON_CELL_STATES)[number];

const blindTokenSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** A score David gives one image: 1 (worst) to 5 (best). */
export const COMPARISON_SCORE_MIN = 1;
export const COMPARISON_SCORE_MAX = 5;

/**
 * A blind judgement (plan *Proposed Design* E): a score of 1 to 5 for every
 * image the panel shows (David, 2026-11-10, in place of a single "best" pick).
 * Cells are named by the opaque tokens the blind view issued, never by id or
 * engine.
 */
export const comparisonPickSchema = z.object({
  ratings: z.array(z.object({
    token: blindTokenSchema,
    score: z.number().int().min(COMPARISON_SCORE_MIN).max(COMPARISON_SCORE_MAX),
  }).strict()).min(1).max(12),
  /** Images whose face is not the person; human-reference panels only. */
  faceMismatchTokens: z.array(blindTokenSchema).max(12).default([]),
  /** Images that captured the panel's look style; styled panels only (David, 2026-11-11). */
  styleCapturedTokens: z.array(blindTokenSchema).max(12).default([]),
}).strict();
export type ComparisonPickRequest = z.infer<typeof comparisonPickSchema>;

/**
 * How a set is judged. Edition 1 is the single 1-to-5 score per picture with
 * face and style marks (every set made before the prompt tuner); edition 2,
 * every set made since, scores each picture on five categories, picks one
 * picture per panel and can mark pictures broken (David, 2026-11-11 and
 * 2026-11-12; plan `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* C).
 */
export const COMPARISON_JUDGING_EDITIONS = [1, 2] as const;
export type ComparisonJudgingEdition = (typeof COMPARISON_JUDGING_EDITIONS)[number];

/**
 * When a category is asked: on every picture, only on a panel with a look
 * style, or only on a panel whose engines were given a photo (a person, a pet
 * or an object).
 */
export type JudgingCategoryScope = "always" | "styled" | "photo";

/** The five categories, in the order the judging page asks them, with the words David agreed. */
export const JUDGING_CATEGORIES = [
  {
    key: "visualQuality",
    label: "Visual quality",
    help: "Craft: clean hands, faces, textures and lighting, with no smears or artifacts. Photoreal: does it look natural? Styled: are the details drawn the way the style means them to look?",
    scope: "always",
  },
  {
    key: "gagFidelity",
    label: "Gag fidelity",
    help: "Does the picture show the gag above, with the details, framing and placement it calls for? Judged against the gag, not the prompt.",
    scope: "always",
  },
  {
    key: "realism",
    label: "Realism",
    help: "Physics and plausibility only: weight, contact, motion and objects staying consistent, even in a supernatural scene. On a styled picture, judged within the style's own rules.",
    scope: "always",
  },
  {
    key: "styleInterpretation",
    label: "Style interpretation",
    help: "How well the requested style comes through.",
    scope: "styled",
  },
  {
    key: "likeness",
    label: "Likeness",
    help: "How well the picture keeps the likeness of the supplied photo.",
    scope: "photo",
  },
] as const satisfies ReadonlyArray<{ key: string; label: string; help: string; scope: JudgingCategoryScope }>;
export type JudgingCategoryKey = (typeof JUDGING_CATEGORIES)[number]["key"];
export const JUDGING_CATEGORY_KEYS = JUDGING_CATEGORIES.map((c) => c.key) as JudgingCategoryKey[];

/** The categories asked on a panel, from whether it is styled and whether it has a photo. */
export function judgingCategoriesFor(panel: { styled: boolean; hasPhoto: boolean }): JudgingCategoryKey[] {
  return JUDGING_CATEGORIES
    .filter((c) => c.scope === "always" || (c.scope === "styled" && panel.styled) || (c.scope === "photo" && panel.hasPhoto))
    .map((c) => c.key);
}

const scoreSchema = z.number().int().min(COMPARISON_SCORE_MIN).max(COMPARISON_SCORE_MAX);

/**
 * A second-edition judgement of one panel: every picture shown scored on each
 * category that applies to the panel (the server checks which), one picture
 * picked as the one to send, and any pictures marked broken. Pictures are
 * named by blind token, never by id or engine.
 */
export const comparisonJudgementSchema = z.object({
  scores: z.array(z.object({
    token: blindTokenSchema,
    visualQuality: scoreSchema,
    gagFidelity: scoreSchema,
    realism: scoreSchema,
    styleInterpretation: scoreSchema.optional(),
    likeness: scoreSchema.optional(),
  }).strict()).min(1).max(12),
  /** "Which would you send to a friend?" */
  bestToken: blindTokenSchema,
  /** Hard failures: the wrong person, extra limbs, stray text or a watermark. */
  brokenTokens: z.array(blindTokenSchema).max(12).default([]),
}).strict();
export type ComparisonJudgementRequest = z.infer<typeof comparisonJudgementSchema>;

/** Results across one or more sets, e.g. round 1 and round 2 together. */
export const comparisonResultsQuerySchema = z.object({
  setIds: z.string().regex(/^\d+(,\d+)*$/).transform((s) => [...new Set(s.split(",").map(Number))]).pipe(z.array(z.number().int().positive()).min(1).max(10)),
}).strict();


// ─── The Eval page's wizards (plan docs/plans/PLAN_EVAL_PAGE.md) ────────────

/**
 * The engines an evaluation can compare, decided with David in conversation
 * (2026-11-12: "Recommended"): GPT Image 2.6 for photoreal, Nano Banana 2.1
 * for styled, Muse in reserve. Changed only by a PR.
 */
export const EVALUATION_CANDIDATE_FAMILIES = ["gpt-image-2-6", "nano-banana-2-1", "muse-image"] as const;

/**
 * The photo types an evaluation can draw from (David, 2026-11-12: female and
 * non-binary dropped, "they're not necessary for judging the engine").
 */
export const EVALUATION_PHOTO_TYPES = [
  { scenarioKey: "i2i_male_default", label: "Male" },
  { scenarioKey: "i2i_nonhuman_animal", label: "Pet" },
  { scenarioKey: "i2i_nonhuman_object_vehicle", label: "Vehicle" },
] as const satisfies ReadonlyArray<{ scenarioKey: RenderScenarioKey; label: string }>;
const PHOTO_TYPE_KEYS = EVALUATION_PHOTO_TYPES.map((t) => t.scenarioKey) as [RenderScenarioKey, ...RenderScenarioKey[]];

/** Above this many pictures the wizard shows the count as a warning. */
export const EVALUATION_IMAGE_WARNING = 50;

/** The wizard's selection: what an evaluation would draw. */
export const evaluationSelectionSchema = z.object({
  kind: z.enum(COMPARISON_SET_KINDS),
  factIds: z.array(z.number().int().positive()).min(1).max(50),
  engineFamilies: z.array(z.enum(EVALUATION_CANDIDATE_FAMILIES)).min(1),
  scenarioKeys: z.array(z.enum(PHOTO_TYPE_KEYS)).min(1),
  lookStyleIds: z.array(z.string().trim().min(1).max(64)).min(1),
  /** A prompt evaluation's versions, null for the baseline. */
  recipeVersionIds: z.array(z.number().int().positive().nullable()).min(2).max(4).optional(),
}).strict().superRefine((v, ctx) => {
  const unique = <T>(xs: T[]) => new Set(xs).size === xs.length;
  if (!unique(v.factIds)) ctx.addIssue({ code: "custom", path: ["factIds"], message: "each fact once" });
  if (!unique(v.engineFamilies)) ctx.addIssue({ code: "custom", path: ["engineFamilies"], message: "each engine once" });
  if (!unique(v.scenarioKeys)) ctx.addIssue({ code: "custom", path: ["scenarioKeys"], message: "each photo type once" });
  if (!unique(v.lookStyleIds)) ctx.addIssue({ code: "custom", path: ["lookStyleIds"], message: "each look once" });
  if (v.kind === "prompt") {
    if (v.engineFamilies.length !== 1) ctx.addIssue({ code: "custom", path: ["engineFamilies"], message: "a prompt evaluation names exactly one engine" });
    if (v.lookStyleIds.length !== 1) ctx.addIssue({ code: "custom", path: ["lookStyleIds"], message: "a prompt evaluation uses exactly one look" });
    if (!v.recipeVersionIds) ctx.addIssue({ code: "custom", path: ["recipeVersionIds"], message: "a prompt evaluation names two to four versions" });
    else if (new Set(v.recipeVersionIds.map((id) => id ?? 0)).size !== v.recipeVersionIds.length) ctx.addIssue({ code: "custom", path: ["recipeVersionIds"], message: "each version once" });
  } else if (v.recipeVersionIds) {
    ctx.addIssue({ code: "custom", path: ["recipeVersionIds"], message: "versions are named only on a prompt evaluation" });
  }
});
export type EvaluationSelection = z.infer<typeof evaluationSelectionSchema>;

/** Generate Images: the selection, a description, and the wizard's idempotency token. */
export const evaluationCreateSchema = z.object({
  requestToken: z.string().trim().min(8).max(64),
  description: z.string().trim().min(1).max(200),
  selection: evaluationSelectionSchema,
}).strict();
export type EvaluationCreate = z.infer<typeof evaluationCreateSchema>;

/** Where an evaluation stands, derived from its panels, cells and judgements. */
export const EVALUATION_STATUSES = ["generating", "needs_action", "ready", "judging", "finished", "nothing_to_judge"] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];
