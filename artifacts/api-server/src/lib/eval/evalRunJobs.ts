/**
 * Eval harness (Slice 2B) — controlled eval-run renderer.
 *
 * Option A (dedicated, NOT synthetic reviews): an eval run renders the golden
 * set under the CURRENT pipeline via the lower-level
 * `buildAndEnqueueImagePromptAttempt`, tagging each attempt with
 * `eval_run_id` / `eval_scenario_key` / `eval_input_hash` and leaving
 * `review_id` NULL — so eval renders never appear in the moderation grid. Golden
 * facts aren't attached to a review, so the review-scoped scenario helpers can't
 * be used directly; this mirrors their canonical controls/subject/hash.
 *
 * Per-item skip/fail WITHOUT failing the whole run (rule 8): a golden fact with
 * missing/invalid enrichment, a missing required reference asset, or a failed
 * subject/enqueue is marked skipped/failed with a reason and the run continues.
 */

import { randomUUID } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import { db } from "@workspace/db";
import { factsTable, evalRunsTable, imagePromptAttemptsTable } from "@workspace/db/schema";
import {
  validateEnrichment,
  REQUIRED_RENDER_SCENARIO_KEYS,
  RENDER_SCENARIO_DESCRIPTORS,
  type RenderScenarioKey,
  type ReferenceIdentityType,
  type FactEnrichment,
} from "@workspace/api-zod";
import type { SourceImageAnalysis } from "@workspace/api-zod";
import {
  defaultScenarioRenderControls,
  syntheticAnalysisForReference,
} from "../reviewRenderScenarios";
import { resolveDefaultReferenceUrl, ReferenceAssetUnavailableError } from "../defaultReferenceResolver";
import {
  buildScenarioInputHash,
  DEFAULT_REFERENCE_ASSET_VERSION,
  generationModeForSubjectRenderMode,
  actualImageEngineIdForGenerationMode,
} from "../factRenderScenarios";
import { resolveRenderReviewInput } from "../imagePrompt/resolveRenderReviewInput";
import { buildAndEnqueueImagePromptAttempt, buildRenderStatusPayload, type RenderControlsWithRefs } from "../imagePromptAttempts";
import { captureRunProfile } from "./signature";
import { logger } from "../logger";

export interface EvalRunItemResult {
  factId: number;
  scenarioKey: string;
  status: "enqueued" | "skipped" | "failed";
  attemptId?: number;
  reason?: string;
}

async function enqueueEvalScenario(args: {
  runId: number;
  factId: number;
  factText: string;
  enrichment: FactEnrichment;
  scenarioKey: RenderScenarioKey;
}): Promise<EvalRunItemResult> {
  const { runId, factId, factText, enrichment, scenarioKey } = args;
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const mode = desc.subjectRenderMode;

  let referenceImageUrl: string | null = null;
  let referenceAssetVersion: string | null = null;
  let analysis: SourceImageAnalysis | undefined;
  if (desc.referenceIdentityType) {
    try {
      const ref = await resolveDefaultReferenceUrl(desc.referenceIdentityType);
      referenceImageUrl = ref.url;
      referenceAssetVersion = ref.version;
    } catch (err) {
      if (err instanceof ReferenceAssetUnavailableError) {
        return { factId, scenarioKey, status: "skipped", reason: `reference_asset_unavailable: ${err.detail}` };
      }
      return { factId, scenarioKey, status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
    analysis = syntheticAnalysisForReference(desc.referenceIdentityType as ReferenceIdentityType);
  }

  const renderControls = defaultScenarioRenderControls(scenarioKey);
  let resolved;
  try {
    resolved = await resolveRenderReviewInput(factText, enrichment, {
      subjectRenderMode: mode,
      sourceImageAnalysis: analysis,
      referenceImageUrl,
      lookStyleId: null,
      renderControls,
    });
  } catch (err) {
    return { factId, scenarioKey, status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }

  const inputHash = buildScenarioInputHash({
    stagingFactId: factId,
    scenarioKey,
    subjectRenderMode: mode,
    renderedFactText: resolved.renderedFactText,
    enrichment,
    referenceIdentityType: desc.referenceIdentityType,
    referenceAssetVersion,
    renderControls: resolved.renderControls,
    lookStyleId: null,
    styleSuffixVersion: null,
    identityPolicy: resolved.identityPolicy,
    actualImageEngineId: actualImageEngineIdForGenerationMode(generationModeForSubjectRenderMode(mode)),
  });

  const controls: RenderControlsWithRefs = {
    ...resolved.renderControls,
    mirrorToLegacyStorage: false,
    reviewRenderSubject: { name: resolved.renderedSubject.name, pronouns: resolved.renderedSubject.pronouns },
  };

  try {
    const { attemptId } = await buildAndEnqueueImagePromptAttempt({
      factId,
      userId: null,
      enrichment,
      renderedFactText: resolved.renderedFactText,
      analysis: resolved.analysis,
      subjectRenderMode: resolved.subjectRenderMode,
      userSelectedSubjectRenderMode: resolved.userSelectedSubjectRenderMode,
      identityPolicy: resolved.identityPolicy,
      renderControls: controls,
      requestId: `admin-eval:${runId}:${scenarioKey}:${randomUUID()}`,
      eval: { evalRunId: runId, scenarioKey, inputHash },
    });
    return { factId, scenarioKey, status: "enqueued", attemptId };
  } catch (err) {
    return { factId, scenarioKey, status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Create an eval run and enqueue a render of every golden fact under the
 * approval-required scenarios (generic t2i, male i2i, female i2i). Best-effort
 * per item. Returns the run id + the per-item enqueue outcome (rule-8 status).
 */
export async function startEvalRun(args: { label: string | null; adminUserId: string }): Promise<{
  runId: number;
  items: EvalRunItemResult[];
}> {
  const runProfile = await captureRunProfile();
  const [run] = await db
    .insert(evalRunsTable)
    .values({ label: args.label, runProfile, createdBy: args.adminUserId })
    .returning({ id: evalRunsTable.id });
  const runId = run!.id;

  const goldenFacts = await db
    .select({ id: factsTable.id, text: factsTable.text, enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(and(eq(factsTable.evalGolden, true), eq(factsTable.isActive, true)));

  const items: EvalRunItemResult[] = [];
  for (const fact of goldenFacts) {
    const ev = validateEnrichment(fact.enrichment);
    if (!ev.ok) {
      items.push({ factId: fact.id, scenarioKey: "*", status: "skipped", reason: `enrichment_invalid: ${ev.error}` });
      continue;
    }
    for (const scenarioKey of REQUIRED_RENDER_SCENARIO_KEYS) {
      items.push(await enqueueEvalScenario({ runId, factId: fact.id, factText: fact.text, enrichment: ev.data, scenarioKey }));
    }
  }

  logger.info(
    { runId, goldenFacts: goldenFacts.length, enqueued: items.filter((i) => i.status === "enqueued").length },
    "[eval] started eval run",
  );
  return { runId, items };
}

export async function listEvalRuns(limit = 50): Promise<Array<{ id: number; label: string | null; createdAt: string; createdBy: string | null }>> {
  const rows = await db
    .select({ id: evalRunsTable.id, label: evalRunsTable.label, createdAt: evalRunsTable.createdAt, createdBy: evalRunsTable.createdBy })
    .from(evalRunsTable)
    .orderBy(desc(evalRunsTable.createdAt))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy }));
}

/**
 * Per-item live status for one run (rule-8): each eval attempt's render state +
 * any moderator rating/tag, plus an aggregate tally.
 */
export async function getEvalRunStatus(runId: number): Promise<{
  run: { id: number; label: string | null; createdAt: string; runProfile: unknown };
  items: Array<{
    attemptId: number;
    factId: number;
    scenarioKey: string | null;
    status: string;
    rating: number | null;
    failureTag: string | null;
    generatedImageObjectPath: string | null;
  }>;
  tally: { total: number; done: number; failed: number; blocked: number; working: number };
} | null> {
  const [run] = await db.select().from(evalRunsTable).where(eq(evalRunsTable.id, runId)).limit(1);
  if (!run) return null;

  const attempts = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(eq(imagePromptAttemptsTable.evalRunId, runId))
    .orderBy(desc(imagePromptAttemptsTable.createdAt));

  const items = attempts.map((a) => {
    const payload = buildRenderStatusPayload(a);
    return {
      attemptId: a.id,
      factId: a.factId,
      scenarioKey: a.evalScenarioKey,
      status: payload.status,
      rating: a.moderatorRating ?? null,
      failureTag: a.failureTag ?? null,
      generatedImageObjectPath: a.generatedImageObjectPath ?? null,
    };
  });

  const tally = {
    total: items.length,
    done: items.filter((i) => i.status === "image_ready").length,
    failed: items.filter((i) => i.status === "failed").length,
    blocked: items.filter((i) => i.status === "blocked").length,
    working: items.filter((i) => i.status === "pending" || i.status === "prompt_ready").length,
  };

  return {
    run: { id: run.id, label: run.label, createdAt: run.createdAt.toISOString(), runProfile: run.runProfile },
    items,
    tally,
  };
}
