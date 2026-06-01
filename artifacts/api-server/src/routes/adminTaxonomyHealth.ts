/**
 * Admin Taxonomy Health workbench routes.
 *
 *   GET  /admin/taxonomy-health/summary
 *   GET  /admin/taxonomy-health/facts
 *   POST /admin/taxonomy-health/actions/backfill-enrichment
 *   POST /admin/taxonomy-health/actions/regenerate-previews
 *   POST /admin/taxonomy-health/actions/repair-projections
 *
 * The reference-research bulk action is not exposed in v1 — the existing
 * per-row Research Reference button covers admin curation, and a bulk
 * fan-out invites cost surprises before the per-row tool is dialed in.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, count, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import {
  TAXONOMY_HEALTH_BULK_ACTION_MODE_VALUES,
  PROJECTION_REPAIR_MODE_VALUES,
  type FactTaxonomyHealth,
  type TaxonomyHealthBulkActionMode,
  type TaxonomyHealthStatus,
  type TaxonomyHealthSummaryCounts,
  type ProjectionRepairMode,
} from "@workspace/api-zod";
import { requireAdmin } from "./admin";
import { evaluateFactTaxonomyHealth, isEnrichmentAdminEdited } from "../lib/taxonomyHealth";
import { repairFactEnrichmentProjection } from "../lib/taxonomyHealth/projectionRepair";
import { validateEnrichment } from "@workspace/api-zod";
import { enqueueJob } from "../lib/asyncJobs";
import { FACT_ENRICHMENT_BACKFILL_QUEUE } from "../lib/factEnrichmentBackfillJob";
import { PROJECTION_REPAIR_QUEUE } from "../lib/projectionRepairJob";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SYNC_PROJECTION_REPAIR_LIMIT = 25;

interface FactRowSelect {
  id: number;
  text: string;
  enrichment: unknown;
  primaryArchetype: string | null;
  subtype: string | null;
  overhypeFit: string | null;
  adultSuitability: string | null;
  updatedAt: Date | null;
}

function toHealthInput(row: FactRowSelect): Parameters<typeof evaluateFactTaxonomyHealth>[0] {
  return {
    fact: {
      factId: row.id,
      factText: row.text,
      enrichment: row.enrichment,
      primaryArchetype: row.primaryArchetype,
      subtype: row.subtype,
      overhypeFit: row.overhypeFit,
      adultSuitability: row.adultSuitability,
    },
  };
}

async function loadAllApprovedFactsForHealth(): Promise<FactRowSelect[]> {
  // Approved facts only — pending reviews live in pending_reviews and
  // already have their own moderation UX. The facts table holds the
  // post-approval rows.
  return db
    .select({
      id: factsTable.id,
      text: factsTable.text,
      enrichment: factsTable.enrichment,
      primaryArchetype: factsTable.primaryArchetype,
      subtype: factsTable.subtype,
      overhypeFit: factsTable.overhypeFit,
      adultSuitability: factsTable.adultSuitability,
      updatedAt: factsTable.updatedAt,
    })
    .from(factsTable);
}

// ─── GET /admin/taxonomy-health/summary ──────────────────────────────────

router.get("/admin/taxonomy-health/summary", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const facts = await loadAllApprovedFactsForHealth();
    const summary: TaxonomyHealthSummaryCounts = {
      totalFacts: facts.length,
      healthy: 0,
      missingEnrichment: 0,
      invalidEnrichment: 0,
      needsAdminReview: 0,
      missingVisualPreview: 0,
      staleVisualPreview: 0,
      staleEnrichmentVersion: 0,
      projectionMismatch: 0,
      incompleteCulturalReferences: 0,
      semanticEntitiesNeedReview: 0,
      lowConfidence: 0,
    };
    for (const row of facts) {
      const h = evaluateFactTaxonomyHealth(toHealthInput(row));
      if (h.overallStatus === "healthy") summary.healthy++;
      if (h.statuses.includes("missing_enrichment")) summary.missingEnrichment++;
      if (h.reviewFlags.invalidEnrichment) summary.invalidEnrichment++;
      if (h.statuses.includes("needs_admin_review")) summary.needsAdminReview++;
      if (h.reviewFlags.missingPreview) summary.missingVisualPreview++;
      if (h.reviewFlags.stalePreview) summary.staleVisualPreview++;
      if (h.reviewFlags.staleEnrichmentVersion) summary.staleEnrichmentVersion++;
      if (h.reviewFlags.projectionMismatch) summary.projectionMismatch++;
      if (h.reviewFlags.culturalReferenceNeedsResearch) summary.incompleteCulturalReferences++;
      if (h.reviewFlags.semanticEntityNeedsReview) summary.semanticEntitiesNeedReview++;
      if (h.reviewFlags.lowConfidence) summary.lowConfidence++;
    }
    res.json(summary);
  } catch (err) {
    logger.error({ err }, "[adminTaxonomyHealth/summary] failed");
    res.status(500).json({ error: "summary_failed" });
  }
});

// ─── GET /admin/taxonomy-health/facts ────────────────────────────────────

interface ListQuery {
  status?: TaxonomyHealthStatus | "any";
  severity?: "info" | "warning" | "error";
  archetype?: string;
  subtype?: string;
  overhypeFit?: string;
  adultSuitability?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

router.get("/admin/taxonomy-health/facts", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const q: ListQuery = {
      status: (typeof req.query["status"] === "string" ? (req.query["status"] as TaxonomyHealthStatus | "any") : undefined),
      severity: (typeof req.query["severity"] === "string" ? (req.query["severity"] as ListQuery["severity"]) : undefined),
      archetype: typeof req.query["archetype"] === "string" ? req.query["archetype"] : undefined,
      subtype: typeof req.query["subtype"] === "string" ? req.query["subtype"] : undefined,
      overhypeFit: typeof req.query["overhypeFit"] === "string" ? req.query["overhypeFit"] : undefined,
      adultSuitability: typeof req.query["adultSuitability"] === "string" ? req.query["adultSuitability"] : undefined,
      search: typeof req.query["search"] === "string" ? req.query["search"] : undefined,
      limit: Math.min(Math.max(Number(req.query["limit"]) || DEFAULT_LIMIT, 1), MAX_LIMIT),
      offset: Math.max(Number(req.query["offset"]) || 0, 0),
    };

    // SQL pre-filter for the promoted columns + search. The health-status
    // filter is applied in memory because it's derived from the enrichment
    // blob and the version constants.
    const whereParts = [];
    if (q.archetype) whereParts.push(eq(factsTable.primaryArchetype, q.archetype));
    if (q.subtype) whereParts.push(eq(factsTable.subtype, q.subtype));
    if (q.overhypeFit) whereParts.push(eq(factsTable.overhypeFit, q.overhypeFit));
    if (q.adultSuitability) whereParts.push(eq(factsTable.adultSuitability, q.adultSuitability));
    if (q.search) whereParts.push(ilike(factsTable.text, `%${q.search}%`));
    const where = whereParts.length === 0 ? undefined : whereParts.length === 1 ? whereParts[0] : and(...whereParts);

    const allRows = await db
      .select({
        id: factsTable.id,
        text: factsTable.text,
        enrichment: factsTable.enrichment,
        primaryArchetype: factsTable.primaryArchetype,
        subtype: factsTable.subtype,
        overhypeFit: factsTable.overhypeFit,
        adultSuitability: factsTable.adultSuitability,
        updatedAt: factsTable.updatedAt,
      })
      .from(factsTable)
      .where(where ?? sql`true`);

    const matching: Array<{
      factId: number;
      factText: string;
      primaryArchetype: string | null;
      subtype: string | null;
      overhypeFit: string | null;
      adultSuitability: string | null;
      taxonomyConfidence: number | null;
      health: FactTaxonomyHealth;
      updatedAt: string | null;
    }> = [];

    for (const row of allRows) {
      const health = evaluateFactTaxonomyHealth(toHealthInput(row));
      if (q.status && q.status !== "any" && !health.statuses.includes(q.status)) continue;
      if (q.severity && !health.issues.some((i) => i.severity === q.severity)) continue;
      matching.push({
        factId: row.id,
        factText: row.text,
        primaryArchetype: row.primaryArchetype,
        subtype: row.subtype,
        overhypeFit: row.overhypeFit,
        adultSuitability: row.adultSuitability,
        taxonomyConfidence: health.summary.taxonomyConfidence,
        health,
        updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
      });
    }

    const total = matching.length;
    const slice = matching.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? DEFAULT_LIMIT));
    res.json({ rows: slice, total, limit: q.limit ?? DEFAULT_LIMIT, offset: q.offset ?? 0 });
  } catch (err) {
    logger.error({ err }, "[adminTaxonomyHealth/facts] failed");
    res.status(500).json({ error: "list_failed" });
  }
});

// ─── POST /admin/taxonomy-health/actions/backfill-enrichment ─────────────

interface BackfillEnrichmentBody {
  mode?: TaxonomyHealthBulkActionMode;
  factIds?: number[];
  forceOverwriteAdminEdited?: boolean;
}

router.post(
  "/admin/taxonomy-health/actions/backfill-enrichment",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as BackfillEnrichmentBody;
      const mode: TaxonomyHealthBulkActionMode = body.mode ?? "missing_only";
      if (!TAXONOMY_HEALTH_BULK_ACTION_MODE_VALUES.includes(mode)) {
        res.status(400).json({ error: `invalid mode: ${mode}` });
        return;
      }
      const force = body.forceOverwriteAdminEdited === true;
      const targets = await pickEnrichmentTargets(mode, body.factIds, force);
      let queued = 0;
      let failed = 0;
      for (const factId of targets.toEnqueue) {
        try {
          await enqueueJob({
            queue: FACT_ENRICHMENT_BACKFILL_QUEUE,
            payload: { factId, forceOverwriteAdminEdited: force, reason: "taxonomy_health_backfill" },
            dedupeKey: `fact_enrichment_backfill:${factId}`,
          });
          queued++;
        } catch (err) {
          logger.warn({ err, factId }, "[backfill-enrichment] enqueue failed");
          failed++;
        }
      }
      res.json({ queued, skipped: targets.skipped, failed });
    } catch (err) {
      logger.error({ err }, "[adminTaxonomyHealth/backfill-enrichment] failed");
      res.status(500).json({ error: "backfill_failed" });
    }
  },
);

// ─── POST /admin/taxonomy-health/actions/regenerate-previews ─────────────

interface RegeneratePreviewsBody {
  mode?: TaxonomyHealthBulkActionMode;
  factIds?: number[];
}

router.post(
  "/admin/taxonomy-health/actions/regenerate-previews",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as RegeneratePreviewsBody;
      const mode: TaxonomyHealthBulkActionMode = body.mode ?? "missing_only";
      if (!TAXONOMY_HEALTH_BULK_ACTION_MODE_VALUES.includes(mode)) {
        res.status(400).json({ error: `invalid mode: ${mode}` });
        return;
      }
      const targets = await pickPreviewTargets(mode, body.factIds);
      let queued = 0;
      let failed = 0;
      for (const factId of targets) {
        try {
          await enqueueJob({
            queue: "preview",
            payload: { targetType: "fact", targetId: factId },
            dedupeKey: `preview:fact:${factId}`,
          });
          queued++;
        } catch (err) {
          logger.warn({ err, factId }, "[regenerate-previews] enqueue failed");
          failed++;
        }
      }
      res.json({ queued, failed });
    } catch (err) {
      logger.error({ err }, "[adminTaxonomyHealth/regenerate-previews] failed");
      res.status(500).json({ error: "regenerate_previews_failed" });
    }
  },
);

// ─── POST /admin/taxonomy-health/actions/repair-projections ──────────────

interface RepairProjectionsBody {
  mode?: ProjectionRepairMode;
  factIds?: number[];
}

router.post(
  "/admin/taxonomy-health/actions/repair-projections",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as RepairProjectionsBody;
      const mode: ProjectionRepairMode = body.mode ?? "mismatches_only";
      if (!PROJECTION_REPAIR_MODE_VALUES.includes(mode)) {
        res.status(400).json({ error: `invalid mode: ${mode}` });
        return;
      }
      const targets = await pickProjectionRepairTargets(mode, body.factIds);
      // Sync if small, queue if large.
      if (targets.length <= SYNC_PROJECTION_REPAIR_LIMIT) {
        const outcomes = [];
        let repaired = 0;
        let skipped = 0;
        const errors: Array<{ factId: number; error: string }> = [];
        for (const factId of targets) {
          const outcome = await repairFactEnrichmentProjection(factId);
          if (outcome.repaired) repaired++;
          else if (outcome.error) errors.push({ factId, error: outcome.error });
          else skipped++;
          outcomes.push(outcome);
        }
        res.json({ mode: "sync", repaired, skipped, errors, outcomes });
        return;
      }
      let queued = 0;
      let failed = 0;
      for (const factId of targets) {
        try {
          await enqueueJob({
            queue: PROJECTION_REPAIR_QUEUE,
            payload: { factId },
            dedupeKey: `projection_repair:${factId}`,
          });
          queued++;
        } catch (err) {
          logger.warn({ err, factId }, "[repair-projections] enqueue failed");
          failed++;
        }
      }
      res.json({ mode: "async", queued, failed });
    } catch (err) {
      logger.error({ err }, "[adminTaxonomyHealth/repair-projections] failed");
      res.status(500).json({ error: "repair_projections_failed" });
    }
  },
);

// ─── Internal target pickers ──────────────────────────────────────────────

interface EnrichmentTargetPick {
  toEnqueue: number[];
  skipped: number;
}

async function pickEnrichmentTargets(
  mode: TaxonomyHealthBulkActionMode,
  factIds: number[] | undefined,
  force: boolean,
): Promise<EnrichmentTargetPick> {
  if (mode === "selected_fact_ids") {
    return { toEnqueue: factIds ?? [], skipped: 0 };
  }
  const facts = await loadAllApprovedFactsForHealth();
  const toEnqueue: number[] = [];
  let skipped = 0;
  for (const row of facts) {
    const h = evaluateFactTaxonomyHealth(toHealthInput(row));
    const isMissing = h.statuses.includes("missing_enrichment");
    const isStale =
      h.reviewFlags.staleEnrichmentVersion || h.reviewFlags.invalidEnrichment;
    const include =
      (mode === "missing_only" && isMissing) ||
      (mode === "stale_only" && isStale) ||
      (mode === "missing_or_stale" && (isMissing || isStale));
    if (!include) continue;
    if (!force && row.enrichment != null) {
      const validation = validateEnrichment(row.enrichment);
      if (validation.ok && isEnrichmentAdminEdited(validation.data)) {
        skipped++;
        continue;
      }
    }
    toEnqueue.push(row.id);
  }
  return { toEnqueue, skipped };
}

async function pickPreviewTargets(
  mode: TaxonomyHealthBulkActionMode,
  factIds: number[] | undefined,
): Promise<number[]> {
  if (mode === "selected_fact_ids") return factIds ?? [];
  const facts = await loadAllApprovedFactsForHealth();
  const out: number[] = [];
  for (const row of facts) {
    const h = evaluateFactTaxonomyHealth(toHealthInput(row));
    const isMissing = h.reviewFlags.missingPreview;
    const isStale = h.reviewFlags.stalePreview;
    const include =
      (mode === "missing_only" && isMissing) ||
      (mode === "stale_only" && isStale) ||
      (mode === "missing_or_stale" && (isMissing || isStale));
    if (include) out.push(row.id);
  }
  return out;
}

async function pickProjectionRepairTargets(
  mode: ProjectionRepairMode,
  factIds: number[] | undefined,
): Promise<number[]> {
  if (mode === "selected_fact_ids") return factIds ?? [];
  const facts = await loadAllApprovedFactsForHealth();
  const out: number[] = [];
  for (const row of facts) {
    const h = evaluateFactTaxonomyHealth(toHealthInput(row));
    if (h.reviewFlags.projectionMismatch) out.push(row.id);
  }
  return out;
}

export default router;
