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
 * - A run takes items in order while the running total stays within the
 *   per-run allowance; an item that alone exceeds it refuses the run with the
 *   figure. The week's remaining budget (read by the operator from the fleet
 *   ledger) must cover the run plus every reservation still unresolved.
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
  boundUsd: number;
  allowanceUsd: number;
  /** Work left after this run, priced. */
  remainingItems: number;
  remainingBoundUsd: number;
  /** Runs of this kind needed to finish everything pending, this one included. */
  runsNeeded: number;
  refusal: string | null;
}

export const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** How many runs a list of items needs, packed greedily in order. */
function countRuns(items: WorkItem[], allowanceUsd: number): number {
  let runs = 0;
  let total = Infinity;
  for (const item of items) {
    if (total + item.boundUsd > allowanceUsd) {
      runs += 1;
      total = 0;
    }
    total += item.boundUsd;
  }
  return runs;
}

export function planRun(
  pending: WorkItem[],
  opts: { allowanceUsd: number; weekRemainingUsd: number; unresolvedReservedUsd: number },
): RunPlan {
  const base = { allowanceUsd: opts.allowanceUsd };
  if (pending.length === 0) {
    return { ...base, admitted: false, items: [], boundUsd: 0, remainingItems: 0, remainingBoundUsd: 0, runsNeeded: 0, refusal: "nothing left to do" };
  }
  const totalLeft = pending.reduce((s, i) => s + i.boundUsd, 0);
  const tooBig = pending.find((i) => i.boundUsd > opts.allowanceUsd);
  if (tooBig) {
    return {
      ...base, admitted: false, items: [], boundUsd: 0, remainingItems: pending.length, remainingBoundUsd: round4(totalLeft), runsNeeded: 0,
      refusal: `${tooBig.label} alone is bounded at $${tooBig.boundUsd.toFixed(4)}, above the $${opts.allowanceUsd.toFixed(2)} per-run allowance`,
    };
  }
  const items: WorkItem[] = [];
  let total = 0;
  for (const item of pending) {
    if (total + item.boundUsd > opts.allowanceUsd) break;
    items.push(item);
    total += item.boundUsd;
  }
  const rest = pending.slice(items.length);
  const restBound = rest.reduce((s, i) => s + i.boundUsd, 0);
  const runsNeeded = countRuns(pending, opts.allowanceUsd);
  const weekNeeded = total + opts.unresolvedReservedUsd;
  const shape = { items, boundUsd: round4(total), remainingItems: rest.length, remainingBoundUsd: round4(restBound), runsNeeded };
  if (weekNeeded > opts.weekRemainingUsd) {
    return {
      ...base, ...shape, admitted: false,
      refusal: `this run is bounded at $${total.toFixed(4)} and $${opts.unresolvedReservedUsd.toFixed(4)} is still reserved, $${weekNeeded.toFixed(4)} in all, above the $${opts.weekRemainingUsd.toFixed(2)} left this week`,
    };
  }
  return { ...base, ...shape, admitted: true, refusal: null };
}
