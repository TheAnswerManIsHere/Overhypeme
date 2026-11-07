/**
 * Launch Phase 8 — the engine comparison's wire vocabulary (plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D).
 * Shared by the admin routes and the admin page.
 */
import { z } from "zod";
import { RENDER_SCENARIO_KEYS, renderScenarioKeySchema, type RenderScenarioKey } from "./renderScenarios";

/** The six engine families David shortlisted (2026-11-06), the control last. */
export const COMPARISON_DEFAULT_FAMILIES = [
  "gpt-image-2-5",
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

/** The paid-run budget (`uat-doc-format.md`, *Lanes*): per run, and per week across every product. */
export const PAID_RUN_ALLOWANCE_USD = 5;
export const PAID_WEEK_ALLOWANCE_USD = 25;

export const comparisonSetCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  round: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  factIds: z.array(z.number().int().positive()).min(1).max(10),
  scenarioKeys: z.array(renderScenarioKeySchema).min(1),
  lookStyleIds: z.array(z.string().trim().min(1).max(64)).min(1),
  engineFamilies: z.array(z.string().trim().min(1).max(64)).min(1),
}).strict();
export type ComparisonSetCreate = z.infer<typeof comparisonSetCreateSchema>;

export const comparisonRunPlanSchema = z.object({
  /** "prepare": plan the panels still to prepare; "render": the cells still to render. */
  kind: z.enum(["prepare", "render"]),
  /** Defaults to the per-run allowance; may only lower it. */
  allowanceUsd: z.number().positive().max(PAID_RUN_ALLOWANCE_USD).optional(),
  /** What the fleet paid-run ledger says is left this week, read by the operator. */
  weekRemainingUsd: z.number().min(0).max(PAID_WEEK_ALLOWANCE_USD),
  /**
   * On a start: the bound of the plan the operator was shown. A live plan
   * that has grown past it is refused, so a run is never larger than the
   * figure on the button that started it.
   */
  expectedBoundUsd: z.number().min(0).max(PAID_RUN_ALLOWANCE_USD).optional(),
}).strict();
export type ComparisonRunPlanRequest = z.infer<typeof comparisonRunPlanSchema>;

export const COMPARISON_PANEL_STATES = ["pending", "preparing", "planning", "prepared", "failed", "skipped"] as const;
export const COMPARISON_CELL_STATES = ["expected", "enqueued", "rendered", "failed", "skipped"] as const;
export type ComparisonPanelState = (typeof COMPARISON_PANEL_STATES)[number];
export type ComparisonCellState = (typeof COMPARISON_CELL_STATES)[number];
