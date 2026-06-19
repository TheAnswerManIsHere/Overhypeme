/**
 * Admin Taxonomy Health workbench routes.
 *
 *   GET  /admin/taxonomy-health/summary
 *   GET  /admin/taxonomy-health/facts
 *   POST /admin/taxonomy-health/actions/backfill-enrichment
 *   POST /admin/taxonomy-health/actions/repair-projections
 *
 * The reference-research bulk action is not exposed in v1 — the existing
 * per-row Research Reference button covers admin curation, and a bulk
 * fan-out invites cost surprises before the per-row tool is dialed in.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, ilike, inArray, sql } from "drizzle-orm";
import { db, factsTable } from "@workspace/db";
import { asyncJobsTable } from "@workspace/db/schema";
import {
  TAXONOMY_HEALTH_BULK_ACTION_MODE_VALUES,
  PROJECTION_REPAIR_MODE_VALUES,
  TAXONOMY_HEALTH_FILTER_VALUES,
  SUMMARY_COUNT_TO_FILTER,
  CLASSIFICATION_PROMPT_VERSION,
  matchesHealthFilter,
  type FactTaxonomyHealth,
  type TaxonomyHealthBulkActionMode,
  type TaxonomyHealthFilter,
  type TaxonomyHealthSummaryCounts,
  type ProjectionRepairMode,
  type TaxonomyHealthActionResponse,
  type QueuedJobDescriptor,
  type ActionOutcome,
  type AsyncJobStatusValue,
  type JobStatusEntry,
  type JobStatusResponse,
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
/**
 * Projection repair is a fast, idempotent, no-model DB write. Up to this many
 * targets are repaired inline (returned as terminal `outcomes` immediately);
 * larger sets are queued onto `PROJECTION_REPAIR_QUEUE` and observed via job ids.
 */
const INLINE_PROJECTION_REPAIR_LIMIT = 25;

function deriveActionMode(
  jobs: QueuedJobDescriptor[],
  outcomes: ActionOutcome[],
): "queued" | "inline" | "mixed" {
  if (jobs.length > 0 && outcomes.length > 0) return "mixed";
  if (jobs.length > 0) return "queued";
  return "inline";
}

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
      staleEnrichmentVersion: 0,
      projectionMismatch: 0,
      incompleteCulturalReferences: 0,
      semanticEntitiesNeedReview: 0,
      lowConfidence: 0,
    };
    // Every count goes through the same `matchesHealthFilter` predicate the
    // facts-list endpoint uses, so a card's number can never disagree with the
    // rows it lists (the old Healthy/semantic-entities mismatches).
    for (const row of facts) {
      const h = evaluateFactTaxonomyHealth(toHealthInput(row));
      for (const [countKey, filter] of Object.entries(SUMMARY_COUNT_TO_FILTER) as Array<
        [Exclude<keyof TaxonomyHealthSummaryCounts, "totalFacts">, TaxonomyHealthFilter]
      >) {
        if (matchesHealthFilter(h, filter)) summary[countKey]++;
      }
    }
    res.json(summary);
  } catch (err) {
    logger.error({ err }, "[adminTaxonomyHealth/summary] failed");
    res.status(500).json({ error: "summary_failed" });
  }
});

// ─── GET /admin/taxonomy-health/facts ────────────────────────────────────

interface ListQuery {
  status?: TaxonomyHealthFilter;
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
    const rawStatus = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
    const status: TaxonomyHealthFilter | undefined =
      rawStatus && (TAXONOMY_HEALTH_FILTER_VALUES as readonly string[]).includes(rawStatus)
        ? (rawStatus as TaxonomyHealthFilter)
        : undefined;
    const q: ListQuery = {
      status,
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
      if (q.status && q.status !== "any" && !matchesHealthFilter(health, q.status)) continue;
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
      const jobs: QueuedJobDescriptor[] = [];
      const outcomes: ActionOutcome[] = [];
      let failed = 0;
      for (const factId of targets.toEnqueue) {
        try {
          const r = await enqueueJob({
            queue: FACT_ENRICHMENT_BACKFILL_QUEUE,
            payload: { factId, forceOverwriteAdminEdited: force, reason: "taxonomy_health_backfill" },
            dedupeKey: `fact_enrichment_backfill:${factId}`,
          });
          jobs.push({
            factId, jobId: r.jobId, queue: r.queue, dedupeKey: r.dedupeKey,
            action: "re_enrich", status: r.status, deduped: !r.inserted,
          });
        } catch (err) {
          logger.warn({ err, factId }, "[backfill-enrichment] enqueue failed");
          failed++;
          outcomes.push({ factId, action: "re_enrich", status: "failed", error: "Could not queue the enrichment job." });
        }
      }
      // Admin-edited rows are protected by default — surface them as first-class
      // skipped outcomes (not failed, not invisible) so the UI can explain why.
      for (const factId of targets.skippedAdminEdited) {
        outcomes.push({
          factId, action: "re_enrich", status: "skipped",
          reason: "admin_edited", message: "Admin-edited enrichment is protected by default.",
        });
      }
      const response: TaxonomyHealthActionResponse = {
        mode: deriveActionMode(jobs, outcomes),
        jobs,
        outcomes,
        summary: {
          requested: targets.toEnqueue.length + targets.skippedAdminEdited.length,
          queued: jobs.length,
          done: 0,
          failed,
          skipped: targets.skippedAdminEdited.length,
          skippedAdminEdited: targets.skippedAdminEdited.length,
        },
      };
      res.json(response);
    } catch (err) {
      logger.error({ err }, "[adminTaxonomyHealth/backfill-enrichment] failed");
      res.status(500).json({ error: "backfill_failed" });
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
      // Inline for small sets (fast, idempotent, no model call); queue large sets.
      if (targets.length <= INLINE_PROJECTION_REPAIR_LIMIT) {
        const outcomes: ActionOutcome[] = [];
        let done = 0;
        let failedCount = 0;
        let skipped = 0;
        for (const factId of targets) {
          const outcome = await repairFactEnrichmentProjection(factId);
          if (outcome.repaired) {
            done++;
            outcomes.push({ factId, action: "repair_projections", status: "done", message: "Projection columns repaired from stored enrichment." });
          } else if (outcome.error) {
            failedCount++;
            outcomes.push({ factId, action: "repair_projections", status: "failed", error: outcome.error });
          } else {
            skipped++;
            outcomes.push({ factId, action: "repair_projections", status: "skipped", reason: "already_current", message: "Projection columns already match the stored enrichment." });
          }
        }
        const response: TaxonomyHealthActionResponse = {
          mode: "inline",
          jobs: [],
          outcomes,
          summary: { requested: targets.length, queued: 0, done, failed: failedCount, skipped, alreadyCurrent: skipped },
        };
        res.json(response);
        return;
      }
      const jobs: QueuedJobDescriptor[] = [];
      const outcomes: ActionOutcome[] = [];
      let failed = 0;
      for (const factId of targets) {
        try {
          const r = await enqueueJob({
            queue: PROJECTION_REPAIR_QUEUE,
            payload: { factId },
            dedupeKey: `projection_repair:${factId}`,
          });
          jobs.push({
            factId, jobId: r.jobId, queue: r.queue, dedupeKey: r.dedupeKey,
            action: "repair_projections", status: r.status, deduped: !r.inserted,
          });
        } catch (err) {
          logger.warn({ err, factId }, "[repair-projections] enqueue failed");
          failed++;
          outcomes.push({ factId, action: "repair_projections", status: "failed", error: "Could not queue the projection-repair job." });
        }
      }
      const response: TaxonomyHealthActionResponse = {
        mode: deriveActionMode(jobs, outcomes),
        jobs,
        outcomes,
        summary: { requested: targets.length, queued: jobs.length, done: 0, failed, skipped: 0 },
      };
      res.json(response);
    } catch (err) {
      logger.error({ err }, "[adminTaxonomyHealth/repair-projections] failed");
      res.status(500).json({ error: "repair_projections_failed" });
    }
  },
);

// ─── POST /admin/taxonomy-health/job-status ──────────────────────────────
//
// Poll async_jobs by concrete id. The frontend keeps the jobId → {factId,
// action} mapping locally (from the action response), so this endpoint returns
// only generic job fields and never assumes taxonomy-specific payload shape.

interface JobStatusRequestBody {
  jobs?: Array<{ jobId?: number }>;
}

/** First line only, capped — never leak a multi-line stack trace to the UI. */
function conciseJobError(raw: string | null): string | null {
  if (!raw) return null;
  const oneLine = raw.split("\n")[0]!.trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 297)}…` : oneLine;
}

router.post(
  "/admin/taxonomy-health/job-status",
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as JobStatusRequestBody;
      const ids = Array.from(
        new Set(
          (Array.isArray(body.jobs) ? body.jobs : [])
            .map((j) => Number(j?.jobId))
            .filter((n) => Number.isInteger(n) && n > 0),
        ),
      );
      if (ids.length === 0) {
        res.json({ jobs: [] } satisfies JobStatusResponse);
        return;
      }
      const rows = await db
        .select({
          id: asyncJobsTable.id,
          queue: asyncJobsTable.queue,
          dedupeKey: asyncJobsTable.dedupeKey,
          status: asyncJobsTable.status,
          attempts: asyncJobsTable.attempts,
          maxAttempts: asyncJobsTable.maxAttempts,
          lastError: asyncJobsTable.lastError,
          updatedAt: asyncJobsTable.updatedAt,
        })
        .from(asyncJobsTable)
        .where(inArray(asyncJobsTable.id, ids));
      const jobs: JobStatusEntry[] = rows.map((r) => ({
        jobId: r.id,
        queue: r.queue,
        dedupeKey: r.dedupeKey,
        status: r.status as AsyncJobStatusValue,
        attempts: r.attempts,
        maxAttempts: r.maxAttempts,
        error: conciseJobError(r.lastError),
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
      }));
      res.json({ jobs } satisfies JobStatusResponse);
    } catch (err) {
      logger.error({ err }, "[adminTaxonomyHealth/job-status] failed");
      res.status(500).json({ error: "job_status_failed" });
    }
  },
);

// ─── Internal target pickers ──────────────────────────────────────────────

interface EnrichmentTargetPick {
  toEnqueue: number[];
  /** Fact ids skipped because they're admin-edited and force is off. */
  skippedAdminEdited: number[];
}

async function pickEnrichmentTargets(
  mode: TaxonomyHealthBulkActionMode,
  factIds: number[] | undefined,
  force: boolean,
): Promise<EnrichmentTargetPick> {
  const facts = await loadAllApprovedFactsForHealth();
  // `selected_fact_ids` now runs through the same admin-edited guard as the
  // bulk modes (it used to pass ids verbatim and silently overwrite).
  let candidates: FactRowSelect[];
  if (mode === "selected_fact_ids") {
    const byId = new Map(facts.map((f) => [f.id, f] as const));
    candidates = (factIds ?? [])
      .map((id) => byId.get(id))
      .filter((f): f is FactRowSelect => f != null);
  } else {
    candidates = facts.filter((row) => {
      const h = evaluateFactTaxonomyHealth(toHealthInput(row));
      const isMissing = h.statuses.includes("missing_enrichment");
      const isStale = h.reviewFlags.staleEnrichmentVersion || h.reviewFlags.invalidEnrichment;
      return (
        (mode === "missing_only" && isMissing) ||
        (mode === "stale_only" && isStale) ||
        (mode === "missing_or_stale" && (isMissing || isStale))
      );
    });
  }
  const toEnqueue: number[] = [];
  const skippedAdminEdited: number[] = [];
  for (const row of candidates) {
    if (!force && row.enrichment != null) {
      const validation = validateEnrichment(row.enrichment);
      if (validation.ok && isEnrichmentAdminEdited(validation.data)) {
        skippedAdminEdited.push(row.id);
        continue;
      }
    }
    toEnqueue.push(row.id);
  }
  return { toEnqueue, skippedAdminEdited };
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
