/**
 * Per-gag test-render orchestration (the Test Renders engine).
 *
 * Wraps the entity-agnostic policy in `factRenderScenarios.ts` with the
 * wiring: enqueueing default-scenario test renders of ONE GAG, deriving that
 * gag's scenario grid the admin UI polls, and the
 * `review_render_scenarios_prepare` async job that fires the batches when a
 * review's gags step is approved.
 *
 * Since migration 0139 (plan docs/plans/PLAN_THREE_GAGS.md) renders belong to a
 * gag, not a review: attempts are looked up by gag and scenario, so one gag's
 * renders never replace another's and a review transition detaches nothing. An
 * attempt still records the open review it was made in (null for a live fact
 * with no review open), which the moderation list's coarse state reads.
 *
 * Durable + server-side: `image_prompt_attempts` rows are the source of truth.
 * Idempotent: the same gag+scenario+input-hash is enqueued at most once by a
 * non-force batch. Manual reruns intentionally create fresh attempts.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, imagePromptAttemptsTable, pendingReviewsTable, factGagsTable, type ImagePromptAttempt, type FactGag } from "@workspace/db";
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
  type RenderReviewState,
  type SourceImageAnalysis,
  type SubjectRenderMode,
} from "@workspace/api-zod";
import {
  DEFAULT_REFERENCE_ASSET_VERSION,
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
import { defaultPreviewSubjectForGender, resolveRenderReviewInput } from "./imagePrompt/resolveRenderReviewInput";
import { gagRenderInput, loadGagRenderContext, loadGags, stripGag, workingContent } from "./gags/resolver";
import { renderPersonalized } from "./renderCanonical";
import { enqueueJob, registerJobHandler, type EnqueueJobResult, type HandlerResult, type JobHandler } from "./asyncJobs";
import { logger } from "./logger";
import { attemptImageEngineId, currentRenderRouting, type ImageEngineIds } from "./imageEngineRouting";

export const REVIEW_RENDER_PREPARE_QUEUE = "review_render_scenarios_prepare";

// ─── Canonical default render controls (must match enqueue + hash + grid) ────

export function defaultScenarioRenderControls(scenarioKey: RenderScenarioKey): {
  aspectRatio: string;
  contentMode: ContentMode;
  fallbackSubjectGender: FallbackSubjectGender | null;
} {
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const mode = desc.subjectRenderMode;
  // t2i: always neutral (Alex Franklin / they/them) so the protagonist is gender-agnostic.
  // i2i: the reference image IS the visual subject, but the rendered fact text still
  // substitutes a name + pronouns. Derive them from the reference's known gender so
  // the text is coherent ("Susan Franklin … her gold pants" for the female reference,
  // not the incoherent "David Franklin … his gold pants"). Male / non-human references
  // keep null → David Franklin / he/him (historical default).
  let fallbackSubjectGender: FallbackSubjectGender | null;
  if (mode === "t2i_fallback") {
    fallbackSubjectGender = "neutral";
  } else if (desc.referenceIdentityType === "female") {
    fallbackSubjectGender = "female";
  } else {
    fallbackSubjectGender = null;
  }
  return {
    aspectRatio: "portrait",
    contentMode: "sfw",
    fallbackSubjectGender,
  };
}

/** Synthetic analysis for a KNOWN default reference — avoids a network analyze call. */
export function syntheticAnalysisForReference(identityType: ReferenceIdentityType): SourceImageAnalysis {
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

export function computeScenarioInputHash(
  scenarioKey: RenderScenarioKey,
  stagingFactId: number,
  factText: string,
  enrichment: FactEnrichment,
  imageEngines: ImageEngineIds,
): string {
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const mode: SubjectRenderMode = desc.subjectRenderMode;
  const referenceIdentityType = desc.referenceIdentityType;
  const referenceAssetVersion = referenceIdentityType
    ? (DEFAULT_REFERENCE_ASSET_VERSION[referenceIdentityType] ?? "1")
    : null;
  const renderControls = defaultScenarioRenderControls(scenarioKey);
  // Hash the SAME sampled subject the render path resolves (gender-matched name
  // + pronouns), or staleness/idempotency compares against text no render uses.
  const subject = defaultPreviewSubjectForGender(renderControls.fallbackSubjectGender);
  return buildScenarioInputHash({
    stagingFactId,
    scenarioKey,
    subjectRenderMode: mode,
    renderedFactText: renderPersonalized(factText, subject.name, subject.pronouns),
    enrichment,
    referenceIdentityType,
    referenceAssetVersion,
    renderControls,
    lookStyleId: null,
    styleSuffixVersion: null,
    identityPolicy: defaultIdentityPolicyForRenderMode(mode),
    // The engine a render would be routed to NOW: a changed default makes an
    // older attempt read stale, while its own stored engine stays as it was.
    actualImageEngineId: imageEngines[generationModeForSubjectRenderMode(mode)],
    recipeVersionId: imageEngines.recipeVersions?.[generationModeForSubjectRenderMode(mode)] ?? null, // the same mode as the line above
  });
}

// ─── Attempt queries ─────────────────────────────────────────────────────────

async function latestAttemptForScenario(
  gagId: number,
  scenarioKey: RenderScenarioKey,
): Promise<ImagePromptAttempt | null> {
  const [row] = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(and(
      eq(imagePromptAttemptsTable.gagId, gagId),
      eq(imagePromptAttemptsTable.reviewRenderScenarioKey, scenarioKey),
    ))
    .orderBy(desc(imagePromptAttemptsTable.createdAt))
    .limit(1);
  return row ?? null;
}

async function scenarioAttemptExists(
  gagId: number,
  scenarioKey: RenderScenarioKey,
  inputHash: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: imagePromptAttemptsTable.id })
    .from(imagePromptAttemptsTable)
    .where(and(
      eq(imagePromptAttemptsTable.gagId, gagId),
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
  /** The open review the render is made in; null for a live fact with no review open. */
  reviewId: number | null;
  /** The gag this render draws; `enrichment` is its render input. */
  gagId: number;
  stagingFactId: number;
  factText: string;
  enrichment: FactEnrichment;
  scenarioKey: RenderScenarioKey;
  adminUserId: string;
  batchId: string;
  /** The engine per mode, read once with the review context. */
  imageEngines: ImageEngineIds;
}

/** Record a scenario attempt that failed before any paid work (missing reference). */
async function insertFailedScenarioAttempt(args: EnqueueScenarioArgs, errorMessage: string): Promise<EnqueueScenarioResult> {
  const desc = RENDER_SCENARIO_DESCRIPTORS[args.scenarioKey];
  const mode = desc.subjectRenderMode;
  const inputHash = computeScenarioInputHash(args.scenarioKey, args.stagingFactId, args.factText, args.enrichment, args.imageEngines);
  const renderControls = defaultScenarioRenderControls(args.scenarioKey);
  const subject = defaultPreviewSubjectForGender(renderControls.fallbackSubjectGender);
  const [attempt] = await db
    .insert(imagePromptAttemptsTable)
    .values({
      factId: args.stagingFactId,
      userId: null,
      renderJobId: randomUUID(),
      requestId: `admin-gag-scenario:${args.gagId}:${args.scenarioKey}:${randomUUID()}`,
      generationMode: generationModeForSubjectRenderMode(mode),
      subjectRenderMode: mode,
      targetEngine: "nano_banana_2",
      // Failed before any paid work; records the engine it was routed to.
      actualImageEngineId: args.imageEngines[generationModeForSubjectRenderMode(mode)],
      sourceImageAnalysis: syntheticAnalysisForReference(desc.referenceIdentityType as ReferenceIdentityType),
      identityPolicy: defaultIdentityPolicyForRenderMode(mode),
      renderControls: {
        ...renderControls,
        mirrorToLegacyStorage: false,
        reviewAudit: { reviewId: args.reviewId, adminUserId: args.adminUserId, gagId: args.gagId },
      } satisfies RenderControlsWithRefs,
      factEnrichmentSnapshot: args.enrichment,
      renderedFactText: renderPersonalized(args.factText, subject.name, subject.pronouns),
      archetypeStrategyVersion: "v2",
      error: errorMessage,
      gagId: args.gagId,
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

  const inputHash = computeScenarioInputHash(args.scenarioKey, args.stagingFactId, args.factText, args.enrichment, args.imageEngines);

  const controls: RenderControlsWithRefs = {
    ...resolved.renderControls,
    mirrorToLegacyStorage: false,
    reviewRenderSubject: { name: resolved.renderedSubject.name, pronouns: resolved.renderedSubject.pronouns },
    reviewAudit: { reviewId: args.reviewId, adminUserId: args.adminUserId, gagId: args.gagId },
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
    requestId: `admin-gag-scenario:${args.gagId}:${args.scenarioKey}:${randomUUID()}`,
    gagId: args.gagId,
    imageEngineId: args.imageEngines[generationModeForSubjectRenderMode(mode)],
    // The wording the hash above froze, so a promotion in between cannot split them.
    ...(args.imageEngines.recipeVersions ? { recipeVersionId: args.imageEngines.recipeVersions[generationModeForSubjectRenderMode(mode)] ?? null } : {}),
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

// ─── Load a gag + its fact + the render input ────────────────────────────────

export interface GagRenderTarget {
  gagId: number;
  /** The open review renders are recorded against; null outside a review. */
  reviewId: number | null;
  stagingFactId: number;
  factText: string;
  /** The render input: the classification renders are drawn against, with this gag's working content. */
  enrichment: FactEnrichment;
  /** The open review's stage, or null with no review. */
  stage: string | null;
  /** The engine per mode a render would be routed to now; folded into every hash. */
  imageEngines: ImageEngineIds;
}

/**
 * Load what a gag's renders are drawn from. The classification is the open
 * refresh candidate's while one is under review, else the fact's own; the
 * gag's content is its working content (the pending change if there is one,
 * else the approved version). Grid, staleness and enqueue all read this, so
 * they cannot drift from the render.
 */
export async function loadGagRenderTarget(
  gagId: number,
  imageEngines?: ImageEngineIds,
): Promise<{ ok: true; target: GagRenderTarget; gag: FactGag } | { ok: false; reason: string; stage?: string | null }> {
  const [gag] = await db.select().from(factGagsTable).where(eq(factGagsTable.id, gagId)).limit(1);
  if (!gag || gag.removedAt) return { ok: false, reason: "gag_not_found" };
  const ctx = await loadGagRenderContext(gag.factId);
  if (!ctx) return { ok: false, reason: "fact_missing" };
  const content = workingContent(gag);
  if (!content) return { ok: false, reason: "gag_empty", stage: ctx.stage };
  const ev = validateEnrichment(ctx.classification);
  if (!ev.ok) return { ok: false, reason: `enrichment_invalid: ${ev.error}`, stage: ctx.stage };
  return {
    ok: true,
    gag,
    target: {
      gagId,
      reviewId: ctx.reviewId,
      stagingFactId: gag.factId,
      factText: ctx.factText,
      enrichment: gagRenderInput(stripGag(ev.data), content),
      stage: ctx.stage,
      imageEngines: imageEngines ?? await currentRenderRouting(),
    },
  };
}

/** A review and its staging fact, for the review-level entry points below. */
async function loadReviewRow(reviewId: number) {
  const [review] = await db
    .select({
      id: pendingReviewsTable.id,
      workflowStage: pendingReviewsTable.workflowStage,
      stagingFactId: pendingReviewsTable.stagingFactId,
      candidateVersionId: pendingReviewsTable.candidateVersionId,
    })
    .from(pendingReviewsTable)
    .where(eq(pendingReviewsTable.id, reviewId))
    .limit(1);
  return review ?? null;
}

/**
 * The gag whose grid a review's production gate reads: the default gag as it
 * will stand once this review is approved. That is the lowest-slot gag that
 * will have an approved version (counting a pick this review made, and
 * leaving out a removal this review requested), else, while nothing is
 * approved yet, the lowest-slot gag.
 */
export function gateGag(gags: FactGag[], reviewId: number): FactGag | null {
  const surviving = gags.filter((g) => !(g.pendingRemove && g.pendingReviewId === reviewId));
  const willBeApproved = surviving.find((g) =>
    g.approvedContent != null || (g.pendingExampleAttemptId != null && g.pendingReviewId === reviewId));
  return willBeApproved ?? surviving[0] ?? null;
}

// ─── Idempotent auto-enqueue of the default batch ────────────────────────────

/** The scenario keys a default batch for this render target renders. */
function defaultBatchKeys(target: GagRenderTarget): RenderScenarioKey[] {
  const applicability = resolveNonHumanScenarioApplicability(target.enrichment, target.factText);
  const keys: RenderScenarioKey[] = [...REQUIRED_RENDER_SCENARIO_KEYS];
  if (applicability.autoRun) keys.push(nonHumanScenarioKeyForApplicability(applicability));
  return keys;
}

/**
 * Enqueue one gag's default render batch. `force` always creates fresh
 * attempts; otherwise each scenario is enqueued at most once per input hash.
 */
export async function enqueueGagDefaultBatch(
  gagId: number,
  opts: { force?: boolean; adminUserId?: string; imageEngines?: ImageEngineIds } = {},
): Promise<{ enqueued: EnqueueScenarioResult[] } | { error: string; stage?: string | null }> {
  const loaded = await loadGagRenderTarget(gagId, opts.imageEngines);
  if (!loaded.ok) return { error: loaded.reason, stage: loaded.stage };
  const { target } = loaded;
  const batchId = randomUUID();
  const enqueued: EnqueueScenarioResult[] = [];
  for (const scenarioKey of defaultBatchKeys(target)) {
    if (opts.force !== true) {
      const inputHash = computeScenarioInputHash(scenarioKey, target.stagingFactId, target.factText, target.enrichment, target.imageEngines);
      if (await scenarioAttemptExists(gagId, scenarioKey, inputHash)) continue; // idempotent
    }
    enqueued.push(await enqueueScenarioRender({
      reviewId: target.reviewId,
      gagId,
      stagingFactId: target.stagingFactId,
      factText: target.factText,
      enrichment: target.enrichment,
      scenarioKey,
      // The admin whose action started this batch; "system" only for an
      // unattended transition (image tracing, plan PLAN_IMAGE_TRACING.md).
      adminUserId: opts.adminUserId ?? "system",
      batchId,
      imageEngines: target.imageEngines,
    }));
  }
  if (enqueued.length) {
    logger.info({ gagId, reviewId: target.reviewId, count: enqueued.length, batchId, force: opts.force === true }, "[moderation] gag render batch enqueued");
  }
  return { enqueued };
}

/**
 * The batches a review's approved gags step fires: one per gag that has a
 * pending change, and one for the gate gag (the default gag as it will stand),
 * so a one-gag fact renders exactly as it did before gags had their own table.
 * Stage-guarded to production_review: a delayed or retried prepare job must
 * not spend once the review has left it.
 */
export async function ensureDefaultReviewRenders(
  reviewId: number,
  opts?: { force?: boolean; adminUserId?: string },
): Promise<{ enqueued: EnqueueScenarioResult[] }> {
  const review = await loadReviewRow(reviewId);
  if (!review || review.stagingFactId == null) {
    logger.info({ reviewId }, "[moderation] ensureDefaultReviewRenders skipped (no review or staging fact)");
    return { enqueued: [] };
  }
  if (review.workflowStage !== "production_review") {
    logger.info({ reviewId, stage: review.workflowStage }, "[moderation] ensureDefaultReviewRenders skipped (not production_review)");
    return { enqueued: [] };
  }
  const gags = await loadGags(review.stagingFactId);
  const gate = gateGag(gags, reviewId);
  const chosen = gags.filter((g) => g.pendingContent != null || g.id === gate?.id);
  const imageEngines = await currentRenderRouting();
  const enqueued: EnqueueScenarioResult[] = [];
  for (const gag of chosen) {
    const r = await enqueueGagDefaultBatch(gag.id, { force: opts?.force, adminUserId: opts?.adminUserId, imageEngines });
    if ("enqueued" in r) enqueued.push(...r.enqueued);
  }
  return { enqueued };
}

// ─── Manual (selective) rerun ────────────────────────────────────────────────

/**
 * Run the named scenarios of one gag on demand (the checkbox "Run" + per-tile
 * rerun). Always creates fresh attempts. `force` lets a moderator run a
 * non-applicable non-human scenario anyway.
 */
export async function runGagScenarios(
  gagId: number,
  scenarioKeys: RenderScenarioKey[],
  adminUserId: string,
): Promise<{ enqueued: EnqueueScenarioResult[] } | { error: string; stage?: string | null }> {
  const loaded = await loadGagRenderTarget(gagId);
  if (!loaded.ok) return { error: loaded.reason, stage: loaded.stage };
  const { target } = loaded;
  const batchId = randomUUID();
  const enqueued: EnqueueScenarioResult[] = [];
  for (const scenarioKey of scenarioKeys) {
    enqueued.push(await enqueueScenarioRender({
      reviewId: target.reviewId,
      gagId,
      stagingFactId: target.stagingFactId,
      factText: target.factText,
      enrichment: target.enrichment,
      scenarioKey,
      adminUserId,
      batchId,
      imageEngines: target.imageEngines,
    }));
  }
  return { enqueued };
}

/** The review-level rerun: the named scenarios of the review's gate gag. */
export async function runReviewScenarios(
  reviewId: number,
  scenarioKeys: RenderScenarioKey[],
  adminUserId: string,
): Promise<{ enqueued: EnqueueScenarioResult[] } | { error: string; stage?: string | null }> {
  const review = await loadReviewRow(reviewId);
  if (!review) return { error: "review_not_found" };
  if (review.stagingFactId == null) return { error: "no_staging_fact", stage: review.workflowStage };
  const gate = gateGag(await loadGags(review.stagingFactId), reviewId);
  if (!gate) return { error: "no_gag", stage: review.workflowStage };
  return runGagScenarios(gate.id, scenarioKeys, adminUserId);
}

// ─── Scenario grid (derived, read-only) ──────────────────────────────────────

/** The admin-gated image URL of a gag's render (routes/gags.ts). */
export function gagRenderImageUrl(gagId: number, renderJobId: string): string {
  return `/api/admin/gags/${gagId}/renders/${renderJobId}/image`;
}

function imageUrlForAttempt(gagId: number, attempt: ImagePromptAttempt, status: RenderScenarioStatus): string | null {
  if (status !== "done" || !attempt.renderJobId) return null;
  return gagRenderImageUrl(gagId, attempt.renderJobId);
}

async function buildCard(
  gagId: number,
  scenarioKey: RenderScenarioKey,
  ctx: GagRenderTarget,
  applicability: NonHumanApplicability | null,
): Promise<RenderScenarioCard> {
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const attempt = await latestAttemptForScenario(gagId, scenarioKey);
  const currentHash = computeScenarioInputHash(scenarioKey, ctx.stagingFactId, ctx.factText, ctx.enrichment, ctx.imageEngines);

  let status: RenderScenarioStatus;
  let stale = false;
  let message: string | null = null;
  let latestAttemptId: number | null = null;
  let imageUrl: string | null = null;
  let moderatorRating: number | null = null;
  let failureTag: string | null = null;
  let evalNotes: string | null = null;

  if (!attempt) {
    // No attempt: a non-applicable optional (non-human, not autoRun) is "skipped"; else "missing".
    status = !desc.required && applicability && !applicability.autoRun ? "skipped" : "missing";
  } else {
    status = deriveScenarioStatus(attempt);
    stale = isAttemptStale(attempt, currentHash);
    latestAttemptId = attempt.id;
    imageUrl = imageUrlForAttempt(gagId, attempt, status);
    if (status === "failed") message = attempt.error;
    else if (status === "blocked") message = buildRenderStatusPayload(attempt).blockReason;
    moderatorRating = attempt.moderatorRating ?? null;
    failureTag = attempt.failureTag ?? null;
    evalNotes = attempt.evalNotes ?? null;
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
    moderatorRating,
    failureTag,
    evalNotes,
  };
}

const EMPTY_TALLY = { requested: 0, done: 0, rendering: 0, queued: 0, failed: 0, blocked: 0, skipped: 0, stale: 0 };

/** One gag's scenario grid: the latest attempt per scenario, its status and staleness. */
export async function buildGagScenarioGrid(gagId: number, reviewId: number | null = null): Promise<RenderScenarioGrid> {
  const loaded = await loadGagRenderTarget(gagId);
  if (!loaded.ok) return { reviewId: reviewId ?? 0, gagId, cards: [], tally: { ...EMPTY_TALLY } };
  const ctx = loaded.target;

  const applicability = resolveNonHumanScenarioApplicability(ctx.enrichment, ctx.factText);
  const nonHumanKey = nonHumanScenarioKeyForApplicability(applicability);
  const orderedKeys: RenderScenarioKey[] = [...REQUIRED_RENDER_SCENARIO_KEYS, nonHumanKey];

  const cards: RenderScenarioCard[] = [];
  for (const key of orderedKeys) {
    const app = key === nonHumanKey ? applicability : null;
    cards.push(await buildCard(gagId, key, ctx, app));
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
  return { reviewId: reviewId ?? ctx.reviewId ?? 0, gagId, cards, tally };
}

/** A review's grid: its gate gag's (the default gag as it will stand once approved). */
export async function buildReviewScenarioGrid(
  reviewId: number,
): Promise<RenderScenarioGrid> {
  const empty: RenderScenarioGrid = { reviewId, gagId: null, cards: [], tally: { ...EMPTY_TALLY } };
  const review = await loadReviewRow(reviewId);
  if (!review || review.stagingFactId == null) return empty;
  const gate = gateGag(await loadGags(review.stagingFactId), reviewId);
  if (!gate) return empty;
  return buildGagScenarioGrid(gate.id, reviewId);
}

// ─── List-level coarse render state ──────────────────────────────────────────

/**
 * Coarse per-review render state for the moderation LIST, computed in ONE
 * aggregate query over the latest attempt per scenario (via `DISTINCT ON`) so the
 * hot, ~2.5s-polled endpoint stays cheap regardless of page size. Reviews with no
 * attempts are ABSENT from the map — the caller treats a miss as `not_started`.
 *
 * This is deliberately coarser than the modal's `buildReviewScenarioGrid`: it
 * never computes staleness (no `"stale"` — that needs the TS input-hash recompute)
 * and does not cross-check required-scenario completeness. The modal/grid remains
 * the authoritative surface; this only drives the queue chip + polling (rule 8).
 */
export async function reviewRenderStates(reviewIds: number[]): Promise<Map<number, RenderReviewState>> {
  const states = new Map<number, RenderReviewState>();
  if (reviewIds.length === 0) return states;
  const result = await db.execute<{ review_id: number; total: number; running: number; failed: number }>(sql`
    SELECT latest.review_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE latest.error IS NULL AND latest.generated_image_object_path IS NULL)::int AS running,
      COUNT(*) FILTER (WHERE latest.error IS NOT NULL)::int AS failed
    FROM (
      SELECT DISTINCT ON (a.review_id, a.review_render_scenario_key)
        a.review_id, a.error, a.generated_image_object_path
      FROM image_prompt_attempts a
      WHERE a.review_id = ANY(ARRAY[${sql.join(reviewIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
        AND a.review_render_scenario_key IS NOT NULL
      ORDER BY a.review_id, a.review_render_scenario_key, a.created_at DESC
    ) latest
    GROUP BY latest.review_id
  `);
  for (const row of result.rows) {
    const total = Number(row.total);
    const running = Number(row.running);
    const failed = Number(row.failed);
    const state: RenderReviewState =
      total === 0 ? "not_started"
      : running > 0 ? "running"
      : failed > 0 ? "needs_attention"
      : "ready";
    states.set(Number(row.review_id), state);
  }
  return states;
}

// ─── Frozen per-attempt diagnostics ──────────────────────────────────────────

export async function getScenarioAttemptDiagnostics(
  scenarioKey: RenderScenarioKey,
  attemptId: number,
  scope: { reviewId?: number; gagId?: number },
): Promise<Record<string, unknown> | null> {
  const [attempt] = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(and(
      eq(imagePromptAttemptsTable.id, attemptId),
      eq(imagePromptAttemptsTable.reviewRenderScenarioKey, scenarioKey),
      ...(scope.reviewId != null ? [eq(imagePromptAttemptsTable.reviewId, scope.reviewId)] : []),
      ...(scope.gagId != null ? [eq(imagePromptAttemptsTable.gagId, scope.gagId)] : []),
    ))
    .limit(1);
  if (!attempt) return null;

  const loaded = attempt.gagId != null ? await loadGagRenderTarget(attempt.gagId) : null;
  const currentHash = loaded?.ok
    ? computeScenarioInputHash(scenarioKey, loaded.target.stagingFactId, loaded.target.factText, loaded.target.enrichment, loaded.target.imageEngines)
    : "";
  const payload = buildRenderStatusPayload(attempt);
  return {
    ...payload,
    scenarioKey,
    gagId: attempt.gagId ?? null,
    referenceIdentityType: attempt.reviewReferenceIdentityType,
    referenceAssetVersion: attempt.reviewReferenceAssetVersion,
    actualImageEngineId: attemptImageEngineId(attempt),
    stale: currentHash ? isAttemptStale(attempt, currentHash) : false,
    status: deriveScenarioStatus(attempt),
  };
}

// ─── Async job: prepare default renders on enrichment success ────────────────

export const reviewRenderScenariosPrepareHandler: JobHandler = {
  async run(payload: unknown): Promise<HandlerResult> {
    const p = payload as { reviewId?: number; force?: boolean; adminUserId?: string };
    if (typeof p.reviewId !== "number") {
      return { ok: false, error: `${REVIEW_RENDER_PREPARE_QUEUE}: payload missing reviewId` };
    }
    try {
      const { enqueued } = await ensureDefaultReviewRenders(p.reviewId, {
        force: p.force === true,
        ...(typeof p.adminUserId === "string" && p.adminUserId ? { adminUserId: p.adminUserId } : {}),
      });
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

/**
 * Enqueue a FORCE prepare job with NO dedupe key — the gag-approval "approve the
 * visual gag" path. Deliberately keyless so it can never coalesce onto a stale
 * pending/processing prepare job carrying the stable `review_render_prep:<id>`
 * key (that coalescing would silently drop the fresh batch). The double-click /
 * concurrency guard is the atomic compare-and-set stage transition at the call
 * site — this is only ever reached after THIS request advanced the row, so two
 * concurrent approvals produce exactly one force batch. Returns the job result so
 * the caller can surface the concrete render-prepare job id.
 */
export async function enqueueForceReviewRenderPrepare(reviewId: number, adminUserId: string): Promise<EnqueueJobResult> {
  return enqueueJob({
    queue: REVIEW_RENDER_PREPARE_QUEUE,
    // The approving admin rides in the payload so each render records who
    // started it (image tracing); without it the batch was written as "system".
    payload: { reviewId, force: true, adminUserId },
    // NO dedupeKey — see docstring.
  });
}
