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
  SOURCE_IMAGE_ANALYZER_VERSION,
  GAG_EXAMPLE_KINDS,
  mapKinds,
  ITERATION_KIND,
  SCENARIO_FOR_KIND,
  type GagExampleKind,
  type PerKind,
  type ContentMode,
  type FactEnrichment,
  type FallbackSubjectGender,
  type ReferenceIdentityType,
  type RenderScenarioCard,
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
  renderAffectingEnrichment,
  stableStringify,
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
import { gagRenderInput, loadGagRenderContext, loadGags, workingContent } from "./gags/resolver";
import { assertCanRunGagRenders, GagError, type GagActor } from "./gags/gagStore";
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

/**
 * The latest attempt of a gag's scenario drawn from this render input, as far
 * as the input shapes the picture: the gag's content and the classification
 * fields the input hash reads (`renderAffectingEnrichment`). An admin note, a
 * rating or a hashtag never unseats a render; a picture-shaping edit does. The
 * engine and recipe that drew it stay provenance (plan PLAN_GAG_EXAMPLES.md,
 * section C; Codex, PR #972 round 2). Tiles and reuse share this one lookup.
 */
async function attemptForContent(
  gagId: number,
  scenarioKey: RenderScenarioKey,
  enrichment: FactEnrichment,
): Promise<ImagePromptAttempt | null> {
  const want = pictureIdentity(enrichment);
  if (want == null) return null;
  const rows = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(and(eq(imagePromptAttemptsTable.gagId, gagId), eq(imagePromptAttemptsTable.reviewRenderScenarioKey, scenarioKey)))
    .orderBy(desc(imagePromptAttemptsTable.createdAt));
  return rows.find((r) => pictureIdentity(r.factEnrichmentSnapshot as FactEnrichment) === want) ?? null;
}

/** The picture-shaping part of a render input, as one comparable string; null for a snapshot it cannot read (no match). */
function pictureIdentity(enrichment: FactEnrichment | null | undefined): string | null {
  try {
    // Through JSON first, as the stored snapshot was: a key left undefined in
    // a fresh input is absent from the stored one, and must not split them.
    return enrichment ? stableStringify(JSON.parse(JSON.stringify(renderAffectingEnrichment(enrichment)))) : null;
  } catch {
    return null;
  }
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
  // Validate the joined render input, as the whole blob was validated before
  // gags had their own table: the schema's normalisation of the gag is part
  // of what the hash and the render read.
  const ev = validateEnrichment(
    ctx.classification && typeof ctx.classification === "object"
      ? gagRenderInput(ctx.classification as FactEnrichment, content)
      : ctx.classification,
  );
  if (!ev.ok) return { ok: false, reason: `enrichment_invalid: ${ev.error}`, stage: ctx.stage };
  return {
    ok: true,
    gag,
    target: {
      gagId,
      reviewId: ctx.reviewId,
      stagingFactId: gag.factId,
      factText: ctx.factText,
      enrichment: ev.data,
      stage: ctx.stage,
      imageEngines: imageEngines ?? await currentRenderRouting(),
    },
  };
}

/** A review and its staging fact, for the review-level entry point below. */
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

/** The gags that will still be on the fact once this review is promoted: all but its own pending removals. */
export function survivingGags(gags: FactGag[], reviewId: number): FactGag[] {
  return gags.filter((g) => !(g.pendingRemove && g.pendingReviewId === reviewId));
}

// ─── Drawing a gag's kinds ───────────────────────────────────────────────────

/**
 * Draw a gag's renders for the given kinds, of its current content (plan
 * PLAN_GAG_EXAMPLES.md, section C). Without `redraw`, a kind that already has
 * a render of this content is reused and not drawn again; with it, the
 * moderator asked for a new one. Each kind's check and enqueue run under an
 * advisory lock on the gag and kind, so a save and the Gags approval arriving
 * together draw one render.
 */
export async function drawGagKinds(
  gagId: number,
  kinds: readonly GagExampleKind[],
  opts: { adminUserId: string; redraw?: boolean; imageEngines?: ImageEngineIds },
): Promise<{ enqueued: EnqueueScenarioResult[] } | { error: string; stage?: string | null }> {
  const loaded = await loadGagRenderTarget(gagId, opts.imageEngines);
  if (!loaded.ok) return { error: loaded.reason, stage: loaded.stage };
  const { target } = loaded;
  const batchId = randomUUID();
  const enqueued: EnqueueScenarioResult[] = [];
  for (const kind of kinds) {
    const scenarioKey = SCENARIO_FOR_KIND[kind];
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`gag-render:${gagId}:${kind}`}))`);
      if (opts.redraw !== true && await attemptForContent(gagId, scenarioKey, target.enrichment)) return null;
      return enqueueScenarioRender({
        reviewId: target.reviewId,
        gagId,
        stagingFactId: target.stagingFactId,
        factText: target.factText,
        enrichment: target.enrichment,
        scenarioKey,
        adminUserId: opts.adminUserId,
        batchId,
        imageEngines: target.imageEngines,
      });
    });
    if (result) enqueued.push(result);
  }
  if (enqueued.length) {
    logger.info({ gagId, reviewId: target.reviewId, kinds, count: enqueued.length, redraw: opts.redraw === true }, "[moderation] gag renders enqueued");
  }
  return { enqueued };
}

/**
 * The iteration render: one male render of the gag's current content, reused
 * when one exists. Every change to a gag's content and the Gags approval come
 * through here. Never throws: a failure is logged and the tile shows no render,
 * which the moderator can draw again; the save that triggered it stands.
 */
export async function scheduleIterationRender(gagId: number, adminUserId: string, imageEngines?: ImageEngineIds): Promise<void> {
  try {
    const r = await drawGagKinds(gagId, [ITERATION_KIND], { adminUserId, imageEngines });
    if ("error" in r) logger.info({ gagId, reason: r.error }, "[moderation] iteration render not drawn");
  } catch (err) {
    logger.error({ err, gagId }, "[moderation] iteration render failed to enqueue (the save stands)");
  }
}

/**
 * What approving a review's Gags step draws: the iteration render of each
 * surviving gag with a new or changed content, and nothing for an unchanged
 * gag (grandfathered ones included). Existing renders are kept and reused.
 * Stage-guarded to production_review: a delayed job must not spend once the
 * review has left it.
 */
export async function ensureReviewIterationRenders(
  reviewId: number,
  opts: { adminUserId?: string } = {},
): Promise<{ scheduled: number }> {
  const review = await loadReviewRow(reviewId);
  if (!review || review.stagingFactId == null) return { scheduled: 0 };
  if (review.workflowStage !== "production_review") {
    logger.info({ reviewId, stage: review.workflowStage }, "[moderation] iteration renders skipped (not production_review)");
    return { scheduled: 0 };
  }
  const gags = survivingGags(await loadGags(review.stagingFactId), reviewId).filter((g) => g.pendingContent != null);
  const imageEngines = await currentRenderRouting();
  for (const gag of gags) await scheduleIterationRender(gag.id, opts.adminUserId ?? "system", imageEngines);
  return { scheduled: gags.length };
}

// ─── A gag's tiles (derived, read-only) ──────────────────────────────────────

/** The admin-gated image URL of a gag's render (routes/gags.ts). */
export function gagRenderImageUrl(gagId: number, renderJobId: string): string {
  return `/api/admin/gags/${gagId}/renders/${renderJobId}/image`;
}

function imageUrlForAttempt(gagId: number, attempt: ImagePromptAttempt, status: RenderScenarioStatus): string | null {
  if (status !== "done" || !attempt.renderJobId) return null;
  return gagRenderImageUrl(gagId, attempt.renderJobId);
}

function cardFor(gagId: number, scenarioKey: RenderScenarioKey, attempt: ImagePromptAttempt | null): RenderScenarioCard {
  const desc = RENDER_SCENARIO_DESCRIPTORS[scenarioKey];
  const status: RenderScenarioStatus = attempt ? deriveScenarioStatus(attempt) : "missing";
  return {
    key: scenarioKey,
    label: desc.label,
    purpose: desc.purpose,
    referenceIdentityType: desc.referenceIdentityType,
    required: true,
    status,
    // Matched by content: a later engine or recipe change does not unseat it.
    stale: false,
    latestAttemptId: attempt?.id ?? null,
    imageUrl: attempt ? imageUrlForAttempt(gagId, attempt, status) : null,
    message: !attempt ? null
      : status === "failed" ? attempt.error
      : status === "blocked" ? buildRenderStatusPayload(attempt).blockReason
      : null,
    applicability: null,
    moderatorRating: attempt?.moderatorRating ?? null,
    failureTag: attempt?.failureTag ?? null,
    evalNotes: attempt?.evalNotes ?? null,
  };
}

/**
 * A gag's tile per kind: the render of its current content the scheduler
 * reused or drew (plan PLAN_GAG_EXAMPLES.md, section C). Renders of other
 * content are history and are not listed.
 */
export async function buildGagKindCards(gagId: number): Promise<PerKind<RenderScenarioCard | null>> {
  const loaded = await loadGagRenderTarget(gagId);
  if (!loaded.ok) return mapKinds(() => null);
  const cards = await Promise.all(GAG_EXAMPLE_KINDS.map(async (kind) => {
    const scenarioKey = SCENARIO_FOR_KIND[kind];
    return [kind, cardFor(gagId, scenarioKey, await attemptForContent(gagId, scenarioKey, loaded.target.enrichment))] as const;
  }));
  return Object.fromEntries(cards) as PerKind<RenderScenarioCard | null>;
}

// ─── List-level coarse render state ──────────────────────────────────────────

/**
 * Coarse per-review render state for the moderation LIST, computed in ONE
 * aggregate query over the latest attempt per gag and scenario (via `DISTINCT
 * ON`), counting only gags that survive the review (not removed, and not marked
 * for removal by it), so one gag finishing never hides another still drawing or
 * failed (Codex, PR #956 round 2). Attempts that name no gag (renders of a fact
 * that never had one) count as one group, as before. One query keeps the
 * hot, ~2.5s-polled endpoint cheap regardless of page size. Reviews with no
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
      SELECT DISTINCT ON (a.review_id, a.gag_id, a.review_render_scenario_key)
        a.review_id, a.error, a.generated_image_object_path
      FROM image_prompt_attempts a
      WHERE a.review_id = ANY(ARRAY[${sql.join(reviewIds.map((id) => sql`${id}`), sql`, `)}]::integer[])
        -- Only the three kinds a gag is shown with: renders of a retired
        -- scenario (generic, object/vehicle) are history (PLAN_GAG_EXAMPLES.md).
        AND a.review_render_scenario_key IN (${sql.join(GAG_EXAMPLE_KINDS.map((k) => sql`${SCENARIO_FOR_KIND[k]}`), sql`, `)})
        AND (a.gag_id IS NULL OR EXISTS (
          SELECT 1 FROM fact_gags g
          WHERE g.id = a.gag_id AND g.removed_at IS NULL
            AND NOT (g.pending_remove AND g.pending_review_id = a.review_id)))
      ORDER BY a.review_id, a.gag_id, a.review_render_scenario_key, a.created_at DESC
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
    const p = payload as { reviewId?: number; gagId?: number; factId?: number; scopeReviewId?: number | null; adminUserId?: string };
    if (typeof p.gagId === "number") {
      const adminUserId = typeof p.adminUserId === "string" && p.adminUserId ? p.adminUserId : "system";
      // The save that queued this job was allowed from its scope (a review, or
      // the Facts editor). The job runs seconds or minutes later: if that scope
      // has ended since (a withdrawn or closed review, a refresh opened on a
      // live fact), the render is no longer the moderator's ask and is skipped
      // (Codex, PR #972 round 1).
      if (typeof p.factId === "number") {
        try {
          await assertCanRunGagRenders(p.factId, p.gagId, { adminId: adminUserId, reviewId: p.scopeReviewId ?? null });
        } catch (err) {
          if (!(err instanceof GagError)) throw err;
          logger.info({ gagId: p.gagId, scopeReviewId: p.scopeReviewId ?? null, code: err.code }, "[moderation] iteration render skipped: its scope has ended");
          return { ok: true, result: { gagId: p.gagId, skipped: err.code } };
        }
      }
      await scheduleIterationRender(p.gagId, adminUserId);
      return { ok: true, result: { gagId: p.gagId } };
    }
    if (typeof p.reviewId !== "number") {
      return { ok: false, error: `${REVIEW_RENDER_PREPARE_QUEUE}: payload missing reviewId` };
    }
    try {
      const { scheduled } = await ensureReviewIterationRenders(p.reviewId, {
        ...(typeof p.adminUserId === "string" && p.adminUserId ? { adminUserId: p.adminUserId } : {}),
      });
      return { ok: true, result: { scheduled } };
    } catch (err) {
      return { ok: false, error: `${REVIEW_RENDER_PREPARE_QUEUE}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};

export function registerReviewRenderScenarioHandlers(): void {
  registerJobHandler(REVIEW_RENDER_PREPARE_QUEUE, reviewRenderScenariosPrepareHandler);
}

/**
 * Enqueue one gag's iteration render, after a change to its content (a save,
 * a new gag, an idea used as a gag, a discarded change). The save has already
 * committed; the draw is reused when this content already has its render.
 */
export async function enqueueGagIterationRender(factId: number, gagId: number, actor: GagActor): Promise<void> {
  try {
    await enqueueJob({
      queue: REVIEW_RENDER_PREPARE_QUEUE,
      // The scope the save came from rides along, so the job can refuse once it has ended.
      payload: { factId, gagId, scopeReviewId: actor.reviewId ?? null, adminUserId: actor.adminId },
    });
  } catch (err) {
    logger.error({ err, gagId }, "[moderation] iteration render job failed to enqueue (the save stands)");
  }
}

/**
 * Enqueue the job that draws a review's iteration renders after its Gags step
 * is approved (plan PLAN_GAG_EXAMPLES.md, section C). Keyless, so it cannot
 * coalesce onto an older job; the draws themselves are idempotent per content,
 * so a second job draws nothing new. The approving admin rides in the payload
 * so each render records who started it (image tracing).
 */
export async function enqueueReviewIterationRenders(reviewId: number, adminUserId: string): Promise<EnqueueJobResult> {
  return enqueueJob({
    queue: REVIEW_RENDER_PREPARE_QUEUE,
    payload: { reviewId, adminUserId },
  });
}
