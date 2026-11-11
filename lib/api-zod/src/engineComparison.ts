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

export const comparisonSetCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  factIds: z.array(z.number().int().positive()).min(1).max(10),
  scenarioKeys: z.array(renderScenarioKeySchema).min(1),
  lookStyleIds: z.array(z.string().trim().min(1).max(64)).min(1),
  engineFamilies: z.array(z.string().trim().min(1).max(64)).min(1),
  /** Omitted means "comparison". */
  imageSize: z.enum(COMPARISON_IMAGE_SIZES).optional(),
}).strict();
export type ComparisonSetCreate = z.infer<typeof comparisonSetCreateSchema>;

export const comparisonRunPlanSchema = z.object({
  /**
   * "prepare": every panel still to prepare; "render": every cell still to
   * render. No allowance or week figure: pricing does not gate a comparison
   * run (David, 2026-11-07, `decisions.md`).
   */
  kind: z.enum(["prepare", "render"]),
}).strict();
export type ComparisonRunPlanRequest = z.infer<typeof comparisonRunPlanSchema>;

export const COMPARISON_PANEL_STATES = ["pending", "preparing", "planning", "prepared", "failed", "skipped"] as const;
export const COMPARISON_CELL_STATES = ["expected", "enqueued", "rendered", "failed", "skipped"] as const;
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
}).strict();
export type ComparisonPickRequest = z.infer<typeof comparisonPickSchema>;

/** Results across one or more sets, e.g. round 1 and round 2 together. */
export const comparisonResultsQuerySchema = z.object({
  setIds: z.string().regex(/^\d+(,\d+)*$/).transform((s) => [...new Set(s.split(",").map(Number))]).pipe(z.array(z.number().int().positive()).min(1).max(10)),
}).strict();
