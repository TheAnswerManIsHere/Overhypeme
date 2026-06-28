/**
 * Review-scoped render-scenario orchestration (the Step-2 visual-review engine).
 *
 * Wraps the entity-agnostic policy in `factRenderScenarios.ts` with the
 * review-specific wiring: enqueueing default-scenario test renders against a
 * review's staging fact, deriving the scenario grid the admin UI polls, and the
 * `review_render_scenarios_prepare` async job that fires automatically when
 * enrichment advances a review into `production_review`.
 *
 * Durable + server-side: `image_prompt_attempts` rows are the source of truth
 * (no browser localStorage). Idempotent: the same review+scenario+input-hash is
 * enqueued at most once for the default batch — re-running prep or polling never
 * double-spends. Manual reruns intentionally create fresh attempts.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, imagePromptAttemptsTable, pendingReviewsTable, factsTable, type ImagePromptAttempt } from "@workspace/db";
import {
  defaultIdentityPolicyForRenderMode,
  validateEnrichment,
  RENDER_SCENARIO_DESCRIPTORS,
  REQUIRED_RENDER_SCENARIO_KEYS,
  SOURCE_IMAGE_ANALYZER_VERSION,
  type ContentMode,
  type FactEnrichment,
  type FallbackSubjectGender,
  type NonHumanApplicability,
  type ReferenceIdentityType,
  type RenderScenarioCard,
  type RenderScenarioGrid,
  type RenderScenarioKey,
  type RenderScenarioStatus,
  type SourceImageAnalysis,
  type SubjectRenderMode,
} from "@workspace/api-zod";
import {
  DEFAULT_REFERENCE_ASSET_VERSION,
  actualImageEngineIdForGenerationMode,
  buildScenarioInputHash,
  deriveScenarioStatus,
  generationModeForSubjectRenderMode,
  isAttemptStale,
  nonHumanScenarioKeyForApplicability,
  resolveNonHumanScenarioApplicability,
} from "./factRenderScenarios";
import {
  ReferenceAssetUnavailableError,
  resolveDefaultReferenceUrl,
} from "./defaultReferenceResolver";
import {
  buildAndEnqueueImagePromptAttempt,
  buildRenderStatusPayload,
  type RenderControlsWithRefs,
} from "./imagePromptAttempts";
import { resolveRenderReviewInput } from "./imagePrompt/resolveRenderReviewInput";
import { RUNTIME_PREVIEW_DEFAULT_NAME, RUNTIME_PREVIEW_DEFAULT_PRONOUNS } from "./imagePrompt/preview";
import { renderPersonalized } from "./renderCanonical";
import { enqueueJob, registerJobHandler, type HandlerResult, type JobHandler } from "./asyncJobs";
import { logger } from "./logger";

export const REVIEW_RENDER_PREPARE_QUEUE = "review_render_scenarios_prepare";

// ─── Canonical default render controls (must match enqueue + hash + grid) ────

function defaultScenarioRenderControls(scenarioKey: RenderScenarioKey): {
  aspectRatio: string;
  contentMode: ContentMode;
  fallbackSubjectGender: FallbackSubjectGender | null;
} {
  const mode = RENDER_SCENARIO_DESCRIPTORS[scenarioKey].subjectRenderMode;
  return {
    aspectRatio: "portrait",
    contentMode: "sfw",
    // t2i needs a gender to build a protagonist; i2i ignores it (the reference is the subject).
    fallbackSubjectGender: mode === "t2i_fallback" ? "neutral" : null,
  };
}

/** Synthetic analysis for a KNOWN default reference — avoids a network analyze call. */
function syntheticAnalysisForReference(identityType: ReferenceIdentityType): SourceImageAnalysis {
  const isHuman = identityType === "male" || identityType === "female";
  const subjectKind = isHuman
    ? "human_face"
    : identityType === "nonhuman_animal"
      ? "animal_subject"
      : "object_subject";
  return {
    subjectKind,
    confidence: "high",
    hasUsableHumanFace: isHuman,
    hasUsableSubject: true,
    subjectCount: 1,
    subjectDescription: `default ${identityType} reference`,
    suggestedRenderMode: isHuman ? "human_identity_i2i" : "nonhuman_subject_i2i",
    warnings: [],
    classificationMethod: "manual_user_choice",
    analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
  };
}

// ─── Pure input hash (no network) — shared by enqueue, idempotency, staleness ─

function computeScenarioInputHash(
  scenarioKey: RenderScenarioKey,
  stagingFactId: number,
  factText: string,
  enrichment: FactEnrichment,
): string {
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const mode: SubjectRenderMode = desc.subjectRenderMode;
  const referenceIdentityType = desc.referenceIdentityType;
  const referenceAssetVersion = referenceIdentityType
    ? (DEFAULT_REFERENCE_ASSET_VERSION[referenceIdentityType] ?? "1")
    : null;
  return buildScenarioInputHash({
    stagingFactId,
    scenarioKey,
    subjectRenderMode: mode,
    renderedFactText: renderPersonalized(factText, RUNTIME_PREVIEW_DEFAULT_NAME, RUNTIME_PREVIEW_DEFAULT_PRONOUNS),
    enrichment,
    referenceIdentityType,
    referenceAssetVersion,
    renderControls: defaultScenarioRenderControls(scenarioKey),
    lookStyleId: null,
    styleSuffixVersion: null,
    identityPolicy: defaultIdentityPolicyForRenderMode(mode),
    actualImageEngineId: actualImageEngineIdForGenerationMode(generationModeForSubjectRenderMode(mode)),
  });
}

// ─── Attempt queries ─────────────────────────────────────────────────────────

async function latestAttemptForScenario(
  reviewId: number,
  scenarioKey: RenderScenarioKey,
): Promise<ImagePromptAttempt | null> {
  const [row] = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(and(
      eq(imagePromptAttemptsTable.reviewId, reviewId),
      eq(imagePromptAttemptsTable.reviewRenderScenarioKey, scenarioKey),
    ))
    .orderBy(desc(imagePromptAttemptsTable.createdAt))
    .limit(1);
  return row ?? null;
}

async function scenarioAttemptExists(
  reviewId: number,
  scenarioKey: RenderScenarioKey,
  inputHash: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: imagePromptAttemptsTable.id })
    .from(imagePromptAttemptsTable)
    .where(and(
      eq(imagePromptAttemptsTable.reviewId, reviewId),
      eq(imagePromptAttemptsTable.reviewRenderScenarioKey, scenarioKey),
      eq(imagePromptAttemptsTable.reviewRenderInputHash, inputHash),
    ))
    .limit(1);
  return !!row;
}

// ─── Enqueue one scenario render ─────────────────────────────────────────────

export interface EnqueueScenarioResult {
  scenarioKey: RenderScenarioKey;
  attemptId: number;
  renderJobId: string | null;
  failed?: boolean;
  reason?: string;
}

interface EnqueueScenarioArgs {
  reviewId: number;
  stagingFactId: number;
  factText: string;
  enrichment: FactEnrichment;
  scenarioKey: RenderScenarioKey;
  adminUserId: string;
  batchId: string;
}

/** Record a scenario attempt that failed before any paid work (missing reference). */
async function insertFailedScenarioAttempt(args: EnqueueScenarioArgs, errorMessage: string): Promise<EnqueueScenarioResult> {
  const desc = RENDER_SCENARIO_DESCRIPTORS[args.scenarioKey];
  const mode = desc.subjectRenderMode;
  const inputHash = computeScenarioInputHash(args.scenarioKey, args.stagingFactId, args.factText, args.enrichment);
  const [attempt] = await db
    .insert(imagePromptAttemptsTable)
    .values({
      factId: args.stagingFactId,
      userId: null,
      renderJobId: randomUUID(),
      requestId: `admin-review-scenario:${args.reviewId}:${args.scenarioKey}:${randomUUID()}`,
      generationMode: generationModeForSubjectRenderMode(mode),
      subjectRenderMode: mode,
      targetEngine: "nano_banana_2",
      sourceImageAnalysis: syntheticAnalysisForReference(desc.referenceIdentityType as ReferenceIdentityType),
      identityPolicy: defaultIdentityPolicyForRenderMode(mode),
      renderControls: {
        ...defaultScenarioRenderControls(args.scenarioKey),
        mirrorToLegacyStorage: false,
        reviewAudit: { reviewId: args.reviewId, adminUserId: args.adminUserId },
      } satisfies RenderControlsWithRefs,
      factEnrichmentSnapshot: args.enrichment,
      renderedFactText: renderPersonalized(args.factText, RUNTIME_PREVIEW_DEFAULT_NAME, RUNTIME_PREVIEW_DEFAULT_PRONOUNS),
      archetypeStrategyVersion: "v2",
      error: errorMessage,
      reviewId: args.reviewId,
      reviewRenderScenarioKey: args.scenarioKey,
      reviewRenderInputHash: inputHash,
      reviewReferenceIdentityType: desc.referenceIdentityType,
      reviewReferenceAssetVersion: desc.referenceIdentityType
        ? (DEFAULT_REFERENCE_ASSET_VERSION[desc.referenceIdentityType] ?? "1")
        : null,
      reviewRenderBatchId: args.batchId,
    })
    .returning({ id: imagePromptAttemptsTable.id });
  return { scenarioKey: args.scenarioKey, attemptId: attempt!.id, renderJobId: null, failed: true, reason: errorMessage };
}

export async function enqueueScenarioRender(args: EnqueueScenarioArgs): Promise<EnqueueScenarioResult> {
  const desc = RENDER_SCENARIO_DESCRIPTORS[args.scenarioKey];
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
        return insertFailedScenarioAttempt(args, `reference_asset_unavailable: ${err.detail}`);
      }
      throw err;
    }
    analysis = syntheticAnalysisForReference(desc.referenceIdentityType);
  }

  const renderControls = defaultScenarioRenderControls(args.scenarioKey);
  const resolved = await resolveRenderReviewInput(args.factText, args.enrichment, {
    subjectRenderMode: mode,
    sourceImageAnalysis: analysis,
    referenceImageUrl,
    lookStyleId: null,
    renderControls,
  });

  const inputHash = computeScenarioInputHash(args.scenarioKey, args.stagingFactId, args.factText, args.enrichment);

  const controls: RenderControlsWithRefs = {
    ...resolved.renderControls,
    mirrorToLegacyStorage: false,
    reviewRenderSubject: { name: resolved.renderedSubject.name, pronouns: resolved.renderedSubject.pronouns },
    reviewAudit: { reviewId: args.reviewId, adminUserId: args.adminUserId },
  };

  const { renderJobId, attemptId } = await buildAndEnqueueImagePromptAttempt({
    factId: args.stagingFactId,
    userId: null,
    enrichment: args.enrichment,
    renderedFactText: resolved.renderedFactText,
    analysis: resolved.analysis,
    subjectRenderMode: resolved.subjectRenderMode,
    userSelectedSubjectRenderMode: resolved.userSelectedSubjectRenderMode,
    identityPolicy: resolved.identityPolicy,
    renderControls: controls,
    requestId: `admin-review-scenario:${args.reviewId}:${args.scenarioKey}:${randomUUID()}`,
    scenario: {
      reviewId: args.reviewId,
      scenarioKey: args.scenarioKey,
      inputHash,
      referenceAssetVersion,
      referenceIdentityType: desc.referenceIdentityType,
      batchId: args.batchId,
    },
  });
  return { scenarioKey: args.scenarioKey, attemptId, renderJobId };
}

// ─── Load review + staging fact + enrichment ─────────────────────────────────

interface ReviewRenderContext {
  reviewId: number;
  stagingFactId: number;
  factText: string;
  enrichment: FactEnrichment;
  stage: string;
}

/**
 * Load the renderable context for a review. `enrichmentOverride` lets a caller
 * (e.g. the approval gate, when the request body carries edited Advanced-Options
 * enrichment) compute the grid/staleness against the enrichment that will be
 * PUBLISHED — not the older blob the staging fact still holds — so stale renders
 * can't pass the gate.
 */
async function loadReviewRenderContext(
  reviewId: number,
  enrichmentOverride?: FactEnrichment,
): Promise<
  | { ok: true; ctx: ReviewRenderContext }
  | { ok: false; reason: string; stage?: string }
> {
  const [review] = await db
    .select({ id: pendingReviewsTable.id, workflowStage: pendingReviewsTable.workflowStage, stagingFactId: pendingReviewsTable.stagingFactId })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  if (!review) return { ok: false, reason: "review_not_found" };
  if (review.stagingFactId == null) return { ok: false, reason: "no_staging_fact", stage: review.workflowStage };
  const [stagingFact] = await db
    .select({ text: factsTable.text, enrichment: factsTable.enrichment })
    .from(factsTable)
    .where(eq(factsTable.id, review.stagingFactId))
    .limit(1);
  if (!stagingFact) return { ok: false, reason: "staging_fact_missing", stage: review.workflowStage };
  let enrichment = enrichmentOverride;
  if (!enrichment) {
    const ev = validateEnrichment(stagingFact.enrichment);
    if (!ev.ok) return { ok: false, reason: `enrichment_invalid: ${ev.error}`, stage: review.workflowStage };
    enrichment = ev.data;
  }
  return {
    ok: true,
    ctx: { reviewId, stagingFactId: review.stagingFactId, factText: stagingFact.text, enrichment, stage: review.workflowStage },
  };
}

// ─── Idempotent auto-enqueue of the default batch ────────────────────────────

/**
 * Enqueue the default render scenarios for a review exactly once per
 * scenario/input-hash. Safe to call repeatedly (the enrichment transition fires
 * it; a defensive backstop may too). No-op when the review isn't ready.
 */
export async function ensureDefaultReviewRenders(reviewId: number): Promise<{ enqueued: EnqueueScenarioResult[] }> {
  const loaded = await loadReviewRenderContext(reviewId);
  if (!loaded.ok) {
    logger.info({ reviewId, reason: loaded.reason }, "[moderation] ensureDefaultReviewRenders skipped");
    return { enqueued: [] };
  }
  const { ctx } = loaded;
  // Stage guard: a delayed/retried prepare job (or any re-entry) must NOT enqueue
  // paid renders once the review has left production_review (e.g. rejected). The
  // manual route guards at the HTTP layer; this guards the async/auto path.
  if (ctx.stage !== "production_review") {
    logger.info({ reviewId, stage: ctx.stage }, "[moderation] ensureDefaultReviewRenders skipped (not production_review)");
    return { enqueued: [] };
  }
  const applicability = resolveNonHumanScenarioApplicability(ctx.enrichment, ctx.factText);
  const keys: RenderScenarioKey[] = [...REQUIRED_RENDER_SCENARIO_KEYS];
  if (applicability.autoRun) keys.push(nonHumanScenarioKeyForApplicability(applicability));

  const batchId = randomUUID();
  const enqueued: EnqueueScenarioResult[] = [];
  for (const scenarioKey of keys) {
    const inputHash = computeScenarioInputHash(scenarioKey, ctx.stagingFactId, ctx.factText, ctx.enrichment);
    if (await scenarioAttemptExists(reviewId, scenarioKey, inputHash)) continue; // idempotent
    enqueued.push(await enqueueScenarioRender({
      reviewId,
      stagingFactId: ctx.stagingFactId,
      factText: ctx.factText,
      enrichment: ctx.enrichment,
      scenarioKey,
      adminUserId: "system",
      batchId,
    }));
  }
  if (enqueued.length) {
    logger.info({ reviewId, count: enqueued.length, batchId }, "[moderation] default review render scenarios enqueued");
  }
  return { enqueued };
}

// ─── Manual (selective) rerun ────────────────────────────────────────────────

/**
 * Run the named scenarios on demand (the checkbox "Run" + per-tile rerun).
 * Always creates fresh attempts. `force` lets a moderator run a non-applicable
 * non-human scenario anyway.
 */
export async function runReviewScenarios(
  reviewId: number,
  scenarioKeys: RenderScenarioKey[],
  adminUserId: string,
): Promise<{ enqueued: EnqueueScenarioResult[] } | { error: string; stage?: string }> {
  const loaded = await loadReviewRenderContext(reviewId);
  if (!loaded.ok) return { error: loaded.reason, stage: loaded.stage };
  const { ctx } = loaded;
  const batchId = randomUUID();
  const enqueued: EnqueueScenarioResult[] = [];
  for (const scenarioKey of scenarioKeys) {
    enqueued.push(await enqueueScenarioRender({
      reviewId,
      stagingFactId: ctx.stagingFactId,
      factText: ctx.factText,
      enrichment: ctx.enrichment,
      scenarioKey,
      adminUserId,
      batchId,
    }));
  }
  return { enqueued };
}

// ─── Scenario grid (derived, read-only) ──────────────────────────────────────

function imageUrlForAttempt(reviewId: number, attempt: ImagePromptAttempt, status: RenderScenarioStatus): string | null {
  if (status !== "done" || !attempt.renderJobId) return null;
  return `/api/admin/reviews/${reviewId}/renders/${attempt.renderJobId}/image`;
}

async function buildCard(
  reviewId: number,
  scenarioKey: RenderScenarioKey,
  ctx: ReviewRenderContext,
  applicability: NonHumanApplicability | null,
): Promise<RenderScenarioCard> {
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const attempt = await latestAttemptForScenario(reviewId, scenarioKey);
  const currentHash = computeScenarioInputHash(scenarioKey, ctx.stagingFactId, ctx.factText, ctx.enrichment);

  let status: RenderScenarioStatus;
  let stale = false;
  let message: string | null = null;
  let latestAttemptId: number | null = null;
  let imageUrl: string | null = null;

  if (!attempt) {
    // No attempt: a non-applicable optional (non-human, not autoRun) is "skipped"; else "missing".
    status = !desc.required && applicability && !applicability.autoRun ? "skipped" : "missing";
  } else {
    status = deriveScenarioStatus(attempt);
    stale = isAttemptStale(attempt, currentHash);
    latestAttemptId = attempt.id;
    imageUrl = imageUrlForAttempt(reviewId, attempt, status);
    if (status === "failed") message = attempt.error;
    else if (status === "blocked") message = buildRenderStatusPayload(attempt).blockReason;
  }

  return {
    key: scenarioKey,
    label: desc.label,
    purpose: desc.purpose,
    referenceIdentityType: desc.referenceIdentityType,
    required: desc.required,
    status,
    stale,
    latestAttemptId,
    imageUrl,
    message,
    applicability,
  };
}

export async function buildReviewScenarioGrid(
  reviewId: number,
  enrichmentOverride?: FactEnrichment,
): Promise<RenderScenarioGrid> {
  const loaded = await loadReviewRenderContext(reviewId, enrichmentOverride);
  const empty: RenderScenarioGrid = {
    reviewId,
    cards: [],
    tally: { requested: 0, done: 0, rendering: 0, queued: 0, failed: 0, blocked: 0, skipped: 0, stale: 0 },
  };
  if (!loaded.ok) return empty;
  const { ctx } = loaded;

  const applicability = resolveNonHumanScenarioApplicability(ctx.enrichment, ctx.factText);
  const nonHumanKey = nonHumanScenarioKeyForApplicability(applicability);
  const orderedKeys: RenderScenarioKey[] = [...REQUIRED_RENDER_SCENARIO_KEYS, nonHumanKey];

  const cards: RenderScenarioCard[] = [];
  for (const key of orderedKeys) {
    const app = key === nonHumanKey ? applicability : null;
    cards.push(await buildCard(reviewId, key, ctx, app));
  }

  const tally = {
    requested: cards.length,
    done: cards.filter((c) => c.status === "done").length,
    rendering: cards.filter((c) => c.status === "rendering").length,
    queued: cards.filter((c) => c.status === "queued" || c.status === "missing").length,
    failed: cards.filter((c) => c.status === "failed").length,
    blocked: cards.filter((c) => c.status === "blocked").length,
    skipped: cards.filter((c) => c.status === "skipped").length,
    stale: cards.filter((c) => c.stale).length,
  };
  return { reviewId, cards, tally };
}

// ─── Frozen per-attempt diagnostics ──────────────────────────────────────────

export async function getScenarioAttemptDiagnostics(
  reviewId: number,
  scenarioKey: RenderScenarioKey,
  attemptId: number,
): Promise<Record<string, unknown> | null> {
  const [attempt] = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(and(
      eq(imagePromptAttemptsTable.id, attemptId),
      eq(imagePromptAttemptsTable.reviewId, reviewId),
      eq(imagePromptAttemptsTable.reviewRenderScenarioKey, scenarioKey),
    ))
    .limit(1);
  if (!attempt) return null;

  const loaded = await loadReviewRenderContext(reviewId);
  const currentHash = loaded.ok
    ? computeScenarioInputHash(scenarioKey, loaded.ctx.stagingFactId, loaded.ctx.factText, loaded.ctx.enrichment)
    : "";
  const payload = buildRenderStatusPayload(attempt);
  return {
    ...payload,
    scenarioKey,
    referenceIdentityType: attempt.reviewReferenceIdentityType,
    referenceAssetVersion: attempt.reviewReferenceAssetVersion,
    actualImageEngineId: actualImageEngineIdForGenerationMode(
      generationModeForSubjectRenderMode(attempt.subjectRenderMode as SubjectRenderMode),
    ),
    stale: currentHash ? isAttemptStale(attempt, currentHash) : false,
    status: deriveScenarioStatus(attempt),
  };
}

// ─── Async job: prepare default renders on enrichment success ────────────────

export const reviewRenderScenariosPrepareHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const p = payload as { reviewId?: number };
    if (typeof p.reviewId !== "number") {
      return { ok: false, error: `${REVIEW_RENDER_PREPARE_QUEUE}: payload missing reviewId` };
    }
    try {
      const { enqueued } = await ensureDefaultReviewRenders(p.reviewId);
      return { ok: true, result: { enqueued: enqueued.length } };
    } catch (err) {
      return { ok: false, error: `${REVIEW_RENDER_PREPARE_QUEUE}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export function registerReviewRenderScenarioHandlers(): void {
  registerJobHandler(REVIEW_RENDER_PREPARE_QUEUE, reviewRenderScenariosPrepareHandler);
}

/** Enqueue the prepare job (idempotent via dedupeKey). Called from the enrichment transition. */
export async function enqueueReviewRenderPrepare(reviewId: number): Promise<void> {
  await enqueueJob({
    queue: REVIEW_RENDER_PREPARE_QUEUE,
    payload: { reviewId },
    dedupeKey: `review_render_prep:${reviewId}`,
  });
}
