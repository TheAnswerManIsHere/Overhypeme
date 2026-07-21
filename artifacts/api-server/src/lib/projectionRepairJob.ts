/**
 * Async-job handler for the `projection_repair` queue.
 *
 * One job per fact id. Calls `repairFactEnrichmentProjection(factId)` and
 * stores the outcome on the job result row. Failure modes (fact not found,
 * missing/invalid enrichment) return ok=false so the queue records the
 * reason without retrying forever.
 */

import { registerJobHandler, type JobHandler, type HandlerResult } from "./asyncJobs";
import { repairFactEnrichmentProjection } from "./taxonomyHealth/projectionRepair";

export const PROJECTION_REPAIR_QUEUE = "projection_repair";

export interface ProjectionRepairJobPayload {
  factId: number;
}

export const projectionRepairHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const p = payload as ProjectionRepairJobPayload;
    if (typeof p?.factId !== "number") {
      return { ok: false, error: "projection_repair: payload missing factId" };
    }
    const outcome = await repairFactEnrichmentProjection(p.factId);
    if (outcome.error) {
      // fact_not_found / missing_enrichment / invalid_enrichment / DB error.
      // Don't retry on these — they're determined by data state, not transient.
      return { ok: false, error: outcome.error };
    }
    return {
      ok: true,
      result: {
        factId: outcome.factId,
        repaired: outcome.repaired,
        before: outcome.before,
        after: outcome.after,
      },
    };
  },
};

export function registerProjectionRepairHandler(): void {
  // `fast` lane: pure-DB projection repair (no model/image wait).
  registerJobHandler(PROJECTION_REPAIR_QUEUE, projectionRepairHandler, { lane: "fast" });
}
