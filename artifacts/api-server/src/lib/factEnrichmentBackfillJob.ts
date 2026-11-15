/**
 * Async-job handler for the `fact_enrichment_backfill` queue.
 *
 * Re-enriches an approved fact by calling `enrichFact({factText})`,
 * validating the result, and writing both the JSONB blob + the promoted
 * columns back to `facts`. Admin-edited rows (per `isEnrichmentAdminEdited`)
 * are skipped unless `forceOverwriteAdminEdited: true` is in the payload.
 *
 * Distinct from the existing `enrichment` queue which only handles
 * `pending_reviews` rows. Approved facts go through this queue.
 */

import { eq } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import { validateEnrichment, type EnrichmentOverrides, type FactEnrichment } from "@workspace/api-zod";
import { registerJobHandler, type JobHandler, type HandlerResult } from "./asyncJobs";
import { enrichFact, EnrichmentError, materializeEnrichment } from "./factEnrichment";
import { isEnrichmentAdminEdited } from "./taxonomyHealth";
import { renderCanonical } from "./renderCanonical";
import { charactersOverrideOnly } from "./factCharacters";
import { logger } from "./logger";

export const FACT_ENRICHMENT_BACKFILL_QUEUE = "fact_enrichment_backfill";

export interface FactEnrichmentBackfillPayload {
  factId: number;
  forceOverwriteAdminEdited?: boolean;
  /** Optional reason tag for the job log. */
  reason?: string;
}

/** Seam: classification is a network call, so tests inject a stub. */
export interface FactEnrichmentBackfillDeps {
  classify: typeof enrichFact;
}

export const factEnrichmentBackfillHandler: JobHandler = {
  run: (payload: unknown) => runFactEnrichmentBackfill(payload),
};

export async function runFactEnrichmentBackfill(
  payload: unknown,
  deps: FactEnrichmentBackfillDeps = { classify: enrichFact },
): Promise<HandlerResult> {
  {
    const p = payload as FactEnrichmentBackfillPayload;
    if (typeof p?.factId !== "number") {
      return { ok: false, error: "fact_enrichment_backfill: payload missing factId" };
    }

    const [row] = await db
      .select({
        id: factsTable.id,
        text: factsTable.text,
        enrichment: factsTable.enrichment,
        enrichmentAiDerived: factsTable.enrichmentAiDerived,
      })
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
      next = await deps.classify({
        factText: renderedText,
        priorCharacters: (row.enrichmentAiDerived ?? null) as FactEnrichment | null,
      });
    } catch (err) {
      const msg = err instanceof EnrichmentError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn({ err, factId: p.factId }, "[fact_enrichment_backfill] enrichFact failed");
      return { ok: false, error: `enrichFact failed: ${msg}` };
    }

    // Manual field-overrides intentionally reset here — this path only reaches
    // re-enrich when the row is not admin-edited or force is set — EXCEPT a
    // moderator's character correction, which re-enrichment must never wipe
    // (PLAN_BUBBLE_SPEAKERS.md, E). It is re-read under the row lock so one
    // saved during the classifier call survives too. The fact's gags live in
    // fact_gags (migration 0139) and are not touched.
    await db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ enrichmentOverrides: factsTable.enrichmentOverrides })
        .from(factsTable)
        .where(eq(factsTable.id, p.factId))
        .for("update")
        .limit(1);
      const kept = charactersOverrideOnly((locked?.enrichmentOverrides ?? {}) as EnrichmentOverrides);
      const { columns } = materializeEnrichment({ aiDerived: next, overrides: kept });
      await tx.update(factsTable).set(columns).where(eq(factsTable.id, p.factId));
    });

    return {
      ok: true,
      result: {
        factId: p.factId,
        archetype: next.primaryArchetype,
        subtype: next.subtype,
        confidence: next.taxonomyConfidence,
      },
    };
  }
}

export function registerFactEnrichmentBackfillHandler(): void {
  registerJobHandler(FACT_ENRICHMENT_BACKFILL_QUEUE, factEnrichmentBackfillHandler);
}
