/**
 * Async-job handler for the `fact_enrichment_backfill` queue.
 *
 * Re-enriches an approved fact by calling `enrichFact({factText, status:"new_fact"})`,
 * validating the result, and writing both the JSONB blob + the promoted
 * columns back to `facts`. Admin-edited rows (per `isEnrichmentAdminEdited`)
 * are skipped unless `forceOverwriteAdminEdited: true` is in the payload.
 *
 * Distinct from the existing `enrichment` queue which only handles
 * `pending_reviews` rows. Approved facts go through this queue.
 */

import { eq } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import { validateEnrichment, type FactEnrichment } from "@workspace/api-zod";
import { registerJobHandler, type JobHandler, type HandlerResult } from "./asyncJobs";
import { enrichFact, EnrichmentError, buildFactEnrichmentColumns } from "./factEnrichment";
import { isEnrichmentAdminEdited } from "./taxonomyHealth";
import { renderCanonical } from "./renderCanonical";
import { logger } from "./logger";

export const FACT_ENRICHMENT_BACKFILL_QUEUE = "fact_enrichment_backfill";

export interface FactEnrichmentBackfillPayload {
  factId: number;
  forceOverwriteAdminEdited?: boolean;
  /** Optional reason tag for the job log. */
  reason?: string;
}

export const factEnrichmentBackfillHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const p = payload as FactEnrichmentBackfillPayload;
    if (typeof p?.factId !== "number") {
      return { ok: false, error: "fact_enrichment_backfill: payload missing factId" };
    }

    const [row] = await db
      .select({ id: factsTable.id, text: factsTable.text, enrichment: factsTable.enrichment })
      .from(factsTable)
      .where(eq(factsTable.id, p.factId))
      .limit(1);
    if (!row) {
      return { ok: false, error: `fact_enrichment_backfill: fact ${p.factId} not found` };
    }

    // Admin-edited guardrail. Honor `forceOverwriteAdminEdited` to bypass.
    if (row.enrichment != null && !p.forceOverwriteAdminEdited) {
      const validation = validateEnrichment(row.enrichment);
      if (validation.ok && isEnrichmentAdminEdited(validation.data)) {
        return {
          ok: true,
          result: {
            factId: p.factId,
            skipped: true,
            reason: "admin_edited",
          },
        };
      }
    }

    // Render template tokens ({NAME}/{SUBJ}/…) to canonical plain English
    // before classification — the enrichment LLM expects rendered fact text.
    const renderedText = renderCanonical(row.text);

    let next: FactEnrichment;
    try {
      next = await enrichFact({ factText: renderedText, status: "new_fact" });
    } catch (err) {
      const msg = err instanceof EnrichmentError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn({ err, factId: p.factId }, "[fact_enrichment_backfill] enrichFact failed");
      return { ok: false, error: `enrichFact failed: ${msg}` };
    }

    const projected = buildFactEnrichmentColumns(next);
    await db
      .update(factsTable)
      .set({
        enrichment: next,
        primaryArchetype: projected.primaryArchetype,
        subtype: projected.subtype,
        overhypeFit: projected.overhypeFit,
        adultSuitability: projected.adultSuitability,
      })
      .where(eq(factsTable.id, p.factId));

    return {
      ok: true,
      result: {
        factId: p.factId,
        archetype: next.primaryArchetype,
        subtype: next.subtype,
        confidence: next.taxonomyConfidence,
      },
    };
  },
};

export function registerFactEnrichmentBackfillHandler(): void {
  registerJobHandler(FACT_ENRICHMENT_BACKFILL_QUEUE, factEnrichmentBackfillHandler);
}
