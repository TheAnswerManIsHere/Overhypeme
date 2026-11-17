/**
 * Admission for the engine comparison's paid runs (launch Phase 8, plan
 * `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Settled Decisions*, "Spend
 * is bounded before dispatch, by reservation"). Pure: it prices work items at
 * their complete per-call bounds and decides what one run may take.
 *
 * - A panel's preparation compiles its gag directly and makes no paid call
 *   (plan PLAN_GAG_DIRECT_RENDER.md, D: the render planner was removed).
 * - An image call reserves its engine's `perCallBoundUsd`.
 * - A run takes every pending item (David's override, 2026-11-07: no per-run
 *   or weekly limit applies to comparison runs; the bounds are kept as the
 *   record of what each call could have cost).
 */

import { perCallBoundUsd, type PriceModel } from "../engines";

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
