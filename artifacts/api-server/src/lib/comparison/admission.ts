/**
 * Admission for the engine comparison's paid runs (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Settled Decisions*, "Spend
 * is bounded before dispatch, by reservation"). Pure: it prices work items at
 * their complete per-call bounds and decides what one run may take.
 *
 * - A planner preparation reserves two calls (the generator makes one
 *   corrective call on a validation failure), each at its output ceiling: the
 *   completion-token ceiling the real request sends, derived by the same
 *   request-shaping rule from the planner's resolved settings, at the model's
 *   output rate, plus its input bounded at 12,000 tokens.
 * - An image call reserves its engine's `perCallBoundUsd`.
 * - A run takes every pending item (David's override, 2026-11-07: no per-run
 *   or weekly limit applies to comparison runs; the bounds are kept as the
 *   record of what each call could have cost).
 */

import { perCallBoundUsd, type PriceModel } from "../engines";
import { chatModelTuningParams } from "../openaiChatParams";
import { OPENAI_PRICES } from "../aiDouble/recorder";

/**
 * The planner's input (system prompt, schema and user message) is bounded at
 * this. Recorded planner calls used 7,333 to 7,501 prompt tokens
 * (`aiDouble/recordings/openai.chat--*`); the system prompt is admin-editable
 * and the user message grows with a fact's enrichment, so the bound keeps
 * about 60% headroom over them.
 */
const PLANNER_INPUT_TOKEN_BOUND = 12_000;
/** One validation failure buys one corrective call (`imagePrompt/generator.ts`, its header). */
const PLANNER_CALLS_PER_PANEL = 2;

/** The planner settings that shape its request: what `resolveImagePromptLLMSettings()` resolves. */
export interface PlannerRequestSettings {
  model: string;
  maxTokens: number;
  temperature: number;
  reasoningEffort?: string;
}

/** One planner call at the completion ceiling its request would actually send. */
function plannerCallBoundUsd(settings: PlannerRequestSettings): number {
  const price = OPENAI_PRICES[settings.model];
  if (!price) throw new Error(`no price for the planner model "${settings.model}", so no run can bound its cost`);
  const tuning = chatModelTuningParams(settings);
  const outputTokens = tuning.max_completion_tokens ?? tuning.max_tokens ?? settings.maxTokens;
  return (outputTokens * price.output + PLANNER_INPUT_TOKEN_BOUND * price.input) / 1_000_000;
}

export function panelPreparationBoundUsd(settings: PlannerRequestSettings): number {
  return PLANNER_CALLS_PER_PANEL * plannerCallBoundUsd(settings);
}

/**
 * What one scene's preparation usually costs: one planner call (a corrective
 * second call is rare) at the token counts the recorded planner calls show
 * — 7,333 to 7,501 prompt tokens and 2,972 to 4,221 completion tokens,
 * reasoning included (`aiDouble/recordings/openai.chat--*`). A typical
 * figure shown beside the bound (David, 2026-11-13: "How is it possible that
 * it costs $1.54 in inference to generate the prompt?"); never a limit.
 */
const TYPICAL_PLANNER_INPUT_TOKENS = 7_500;
const TYPICAL_PLANNER_OUTPUT_TOKENS = 3_500;

export function panelPreparationTypicalUsd(settings: PlannerRequestSettings): number {
  const price = OPENAI_PRICES[settings.model];
  if (!price) throw new Error(`no price for the planner model "${settings.model}"`);
  return (TYPICAL_PLANNER_OUTPUT_TOKENS * price.output + TYPICAL_PLANNER_INPUT_TOKENS * price.input) / 1_000_000;
}

export function cellBoundUsd(priceModel: unknown): number {
  if (!priceModel) throw new Error("an engine without a price model is never admitted");
  return perCallBoundUsd(priceModel as PriceModel);
}

export interface WorkItem {
  /** "panel:<id>" or "cell:<id>" */
  ref: string;
  label: string;
  boundUsd: number;
  /** The engine a cell renders on; absent on a panel's preparation. */
  engineId?: string;
}

export interface RunPlan {
  admitted: boolean;
  items: WorkItem[];
  /** The run's worst case: the sum of its calls' bounds. A record, never a limit. */
  boundUsd: number;
  refusal: string | null;
}

export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * A run takes every pending item of its kind. Since David's override of
 * 2026-11-07 (*"Ignore pricing entirely. Doesn't matter right now."*,
 * `decisions.md`) no allowance, week figure or bill limits a comparison run;
 * each call is still priced at its bound so the record says what it could
 * have cost.
 */
export function planRun(pending: WorkItem[]): RunPlan {
  if (pending.length === 0) return { admitted: false, items: [], boundUsd: 0, refusal: "nothing left to do" };
  return { admitted: true, items: pending, boundUsd: round4(pending.reduce((s, i) => s + i.boundUsd, 0)), refusal: null };
}
