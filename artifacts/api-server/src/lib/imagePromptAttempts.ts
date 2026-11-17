/**
 * Shared construction of a render-time image-prompt ATTEMPT row + its async job.
 *
 * Both `POST /memes/ai/:factId/generate-v2` (reference uploads) and the generic
 * (no-upload) branch of `POST /memes/ai/:factId/generate` enqueue work through
 * here, so the two user-facing meme-generation entry points are first-class
 * peers on the same Nano-Banana-2 pipeline (`lib/imagePromptJobs.ts`).
 *
 * The async `image_prompt_generation` handler later resolves the style prompt
 * from `renderControls.styleId`, pulls `renderControls.referenceImageUrl`, builds
 * the engine input, runs Nano Banana 2, and mirrors the result into legacy
 * storage — so callers MUST set those two extension fields on `renderControls`.
 */
import { randomUUID } from "node:crypto";
import { db, imagePromptAttemptsTable, type ImagePromptAttempt } from "@workspace/db";
import type {
  FactEnrichment,
  IdentityPolicy,
  RenderControls,
  SourceImageAnalysis,
  SubjectRenderMode,
} from "@workspace/api-zod";
import { generationModeFromSubjectRenderMode } from "./sourceImageAnalysis";
import { enqueueJob } from "./asyncJobs";
import { fencedTransaction } from "./jobFence";
import { lookClassOfSelection, resolveImageEngine } from "./imageEngineRouting";
import { FROZEN_FALLBACK_KEY, freezeFallbackChoice } from "./engineFallback";
import { isValidRenderStyleSnapshot, resolveAndFreezeRenderStyle, type ResolvedRenderStyleSnapshot } from "./imagePrompt/styleResolution";
import { engineFamilyOf, liveRecipeVersionIdForFamily } from "./imagePrompt/recipeStore";

/** RenderControls plus the route-attached fields `imagePromptJobs` reads. */
export type RenderControlsWithRefs = RenderControls & {
  styleId?: string | null;
  referenceImageUrl?: string | null;
  /** The look, resolved once and frozen at queue time (`styleResolution.ts`); the worker reads it, never the look's row. */
  resolvedRenderStyle?: ResolvedRenderStyleSnapshot;
  /**
   * Moderation-only ephemeral render: when explicitly `false`, the image
   * pipeline stores the generated image on the attempt (so the poll route can
   * surface it) but SKIPS mirroring it into the fact's shared production set
   * (`facts.aiMemeImages` / `user_ai_images` / `upload_image_metadata`). Omitted
   * ⇒ treated as `true` (normal user-facing renders mirror as before).
   */
  mirrorToLegacyStorage?: boolean;
  /**
   * Sampled subject (name + pronouns) frozen on a moderation review render so
   * the async pipeline resolves compiler-level identity tokens to the SAME
   * subject the prompt preview used — instead of falling back to the canonical
   * "Alex" for a null-user attempt. See `resolveAttemptIdentity`.
   */
  reviewRenderSubject?: { name: string; pronouns: string | null };
  /**
   * Provenance for an admin-triggered moderation render: the admin actor, the
   * gag it drew, and the open review it was made in (null for a live fact with
   * no review open, since gags are worked on outside reviews too).
   */
  reviewAudit?: { reviewId: number | null; adminUserId: string; gagId?: number };
};

export interface BuildImagePromptAttemptArgs {
  factId: number;
  userId: string | null;
  /** Already-validated enrichment, frozen onto the attempt for reproducibility. */
  enrichment: FactEnrichment;
  /** Already token-resolved (no {NAME}/{SUBJ}); the generator never sees a template. */
  renderedFactText: string;
  analysis: SourceImageAnalysis;
  subjectRenderMode: SubjectRenderMode;
  userSelectedSubjectRenderMode?: SubjectRenderMode | null;
  identityPolicy: IdentityPolicy;
  renderControls: RenderControlsWithRefs;
  /**
   * Optional provenance tag persisted on the attempt's `requestId` column.
   * Admin moderation renders pass `admin-review:{reviewId}:{adminUserId}:{uuid}`
   * so prompt-gen logs and attempt rows correlate. Omitted ⇒ null.
   */
  requestId?: string | null;
  /**
   * The engine to draw this attempt. Omitted: the engine set in code for the
   * look's class and the mode (`IMAGE_ENGINE_IDS`). A caller that folded an
   * engine into a hash (moderation, eval) passes the one it hashed, so the
   * stored attempt and its hash name the same engine. Validated either way;
   * an unusable engine refuses the attempt rather than falling back.
   */
  imageEngineId?: string;
  /**
   * The prompt recipe version to compile with (the prompt tuner). Omitted
   * (undefined): the live version for the engine's family, read now. A caller
   * that folded a version into a hash passes the one it hashed — `null` then
   * means the baseline, frozen — so the stored attempt and its hash name the
   * same wording (Codex, PR #926 round 2).
   */
  recipeVersionId?: number | null;
  /**
   * Moderation render-scenario metadata. Set ONLY for Step-2 visual-review
   * attempts; makes `image_prompt_attempts` the durable source of truth for the
   * scenario grid (see factRenderScenarios.ts / reviewRenderScenarios.ts).
   */
  scenario?: {
    reviewId: number | null;
    scenarioKey: string;
    inputHash: string;
    referenceAssetVersion?: string | null;
    referenceIdentityType?: string | null;
    batchId?: string | null;
  };
  /**
   * The gag this attempt draws (migration 0139). Set by every moderation render
   * of a gag; `enrichment` above is then that gag's render input
   * (lib/gags/resolver.ts, `gagRenderInput`).
   */
  gagId?: number | null;
  /**
   * Eval-run render-scenario metadata (Slice 2B). Set ONLY for controlled
   * eval-run renders of the golden set — mutually exclusive with `scenario`
   * (which is review-scoped). Tags the attempt with `eval_run_id` /
   * `eval_scenario_key` / `eval_input_hash` and leaves `review_id` NULL, so eval
   * renders never appear in the moderation grid.
   */
  eval?: {
    evalRunId: number;
    scenarioKey: string;
    inputHash: string;
  };
}

/**
 * Insert an `image_prompt_attempts` row and enqueue `image_prompt_generation`.
 * Returns the `renderJobId` (for `GET /memes/ai/renders/:renderJobId` polling)
 * and the numeric `attemptId`.
 */
/**
 * A picture with no reference photo is never made (compiler review, Phase 2;
 * David, 2026-11-14: "There will be no future concept of 'no picture'").
 * Thrown before anything is stored.
 */
export class NoPhotoRenderRefusedError extends Error {
  readonly code = "no_photo_render_retired";
  constructor() {
    super("a picture without a reference photo is no longer made: every picture starts from a photo");
    this.name = "NoPhotoRenderRefusedError";
  }
}

export async function buildAndEnqueueImagePromptAttempt(
  args: BuildImagePromptAttemptArgs,
): Promise<{ renderJobId: string; attemptId: number }> {
  if (args.subjectRenderMode === "t2i_fallback") throw new NoPhotoRenderRefusedError();
  const generationMode = generationModeFromSubjectRenderMode(args.subjectRenderMode);
  // The look is resolved once and frozen on the attempt (the shared resolver
  // has normally done it already); an unusable look throws
  // `RenderStyleRefusedError` before anything is stored.
  const resolvedRenderStyle = isValidRenderStyleSnapshot(args.renderControls.resolvedRenderStyle)
    ? args.renderControls.resolvedRenderStyle
    : await resolveAndFreezeRenderStyle(args.renderControls.styleId, generationMode);
  const renderControls: RenderControlsWithRefs = { ...args.renderControls, resolvedRenderStyle };
  // Routing is resolved once, here, from the look's class, and stored: history
  // never re-derives it.
  const imageEngine = await resolveImageEngine(generationMode, args.imageEngineId, lookClassOfSelection(resolvedRenderStyle.selection));
  // The wording is chosen here too, so a promotion never changes queued work.
  const recipeVersionId = args.recipeVersionId !== undefined
    ? args.recipeVersionId
    : await liveRecipeVersionIdForFamily(engineFamilyOf(imageEngine.id));
  // The photoreal fallback is chosen here too, beside the routing, so a recipe
  // promotion never changes queued work (plan PLAN_NB_FALLBACK.md).
  const fallbackChoice = await freezeFallbackChoice(imageEngine.id);
  if (fallbackChoice) (renderControls as unknown as Record<string, unknown>)[FROZEN_FALLBACK_KEY] = fallbackChoice;
  const renderJobId = randomUUID();
  // The attempt and its planner job land together, in one transaction that a
  // job calling this fences against its own claim (Issue #1000); a route calls
  // it as a plain transaction.
  return fencedTransaction(db, async (tx) => {
  const [attempt] = await tx
    .insert(imagePromptAttemptsTable)
    .values({
      factId: args.factId,
      userId: args.userId,
      renderJobId,
      requestId: args.requestId ?? null,
      generationMode,
      subjectRenderMode: args.subjectRenderMode,
      userSelectedSubjectRenderMode: args.userSelectedSubjectRenderMode ?? null,
      targetEngine: "nano_banana_2",
      actualImageEngineId: imageEngine.id,
      recipeVersionId,
      sourceImageAnalysis: args.analysis,
      sourceImageSha256: args.analysis.sourceImageSha256 ?? null,
      identityPolicy: args.identityPolicy,
      renderControls,
      factEnrichmentSnapshot: args.enrichment,
      renderedFactText: args.renderedFactText,
      archetypeStrategyVersion: "v2",
      reviewId: args.scenario?.reviewId ?? null,
      gagId: args.gagId ?? null,
      reviewRenderScenarioKey: args.scenario?.scenarioKey ?? null,
      reviewRenderInputHash: args.scenario?.inputHash ?? null,
      reviewReferenceAssetVersion: args.scenario?.referenceAssetVersion ?? null,
      reviewReferenceIdentityType: args.scenario?.referenceIdentityType ?? null,
      reviewRenderBatchId: args.scenario?.batchId ?? null,
      evalRunId: args.eval?.evalRunId ?? null,
      evalScenarioKey: args.eval?.scenarioKey ?? null,
      evalInputHash: args.eval?.inputHash ?? null,
    })
    .returning({ id: imagePromptAttemptsTable.id });

  await enqueueJob({
    queue: "image_prompt_generation",
    payload: { attemptId: attempt!.id },
    dedupeKey: `image_prompt:attempt:${attempt!.id}`,
  }, tx);

  return { renderJobId, attemptId: attempt!.id };
  });
}

/**
 * The typed terminal code a render ends with when the picture engine refused
 * it under its content policy (and its photoreal fallback, where there is one,
 * refused too): never retried, and shown on the test-render tile with the
 * engine's reason (plan PLAN_GAG_DIRECT_RENDER.md, B; Issue #980).
 */
export const ENGINE_REFUSED_ERROR_CODE = "vendor_content_refused";

export type RenderStatus = "pending" | "prompt_ready" | "image_ready" | "failed" | "blocked";

/**
 * Map an `image_prompt_attempts` row to the render-poll payload. Shared by the
 * user-facing `GET /memes/ai/renders/:renderJobId` and the admin moderation poll
 * `GET /admin/reviews/:id/renders/:renderJobId` so the two routes can't drift.
 *
 * LEGACY-ROW COMPATIBILITY ONLY: a "poor" subject↔fact compatibility used to be a
 * deliberate product block (the prompt job recorded the reason and skipped image
 * generation). That gate was removed — subjectFactCompatibility is now advisory
 * only and never blocks new renders — but historical attempt rows that still
 * carry `error = "subject_fact_compatibility_poor"` from before the change
 * continue to map here to `blocked` so old data keeps displaying correctly.
 */
export function buildRenderStatusPayload(attempt: ImagePromptAttempt): {
  status: RenderStatus;
  attemptId: number;
  subjectRenderMode: string;
  generationMode: string;
  visualPlan: unknown;
  compiledPrompt: unknown;
  subjectFactCompatibility: unknown;
  generatedImageObjectPath: string | null;
  blocked: boolean;
  blockReason: string | null;
  error: string | null;
  /** Typed terminal failure code (§12), NULL for success / transient / legacy. */
  errorCode: string | null;
  // Eval harness (Slice 2B): the moderator's verdict on this attempt, surfaced so
  // the Step-2 tile (and eval dashboard) can render the rating control + chips.
  moderatorRating: number | null;
  failureTag: string | null;
  evalNotes: string | null;
} {
  const blockedPoor = attempt.error === "subject_fact_compatibility_poor";
  let status: RenderStatus;
  if (blockedPoor) status = "blocked";
  else if (attempt.error) status = "failed";
  else if (attempt.generatedImageObjectPath) status = "image_ready";
  // The compiled prompt marks a prompt ready: a direct attempt stores no plan
  // (plan PLAN_GAG_DIRECT_RENDER.md, D), and a planned one stored both.
  else if (attempt.compiledPrompt) status = "prompt_ready";
  else status = "pending";

  return {
    status,
    attemptId: attempt.id,
    subjectRenderMode: attempt.subjectRenderMode,
    generationMode: attempt.generationMode,
    visualPlan: attempt.visualPlan ?? null,
    compiledPrompt: attempt.compiledPrompt ?? null,
    subjectFactCompatibility: attempt.subjectFactCompatibility ?? null,
    generatedImageObjectPath: attempt.generatedImageObjectPath ?? null,
    blocked: blockedPoor,
    blockReason: blockedPoor ? "subject_fact_compatibility_poor" : null,
    error: blockedPoor ? null : (attempt.error ?? null),
    errorCode: blockedPoor ? null : (attempt.errorCode ?? null),
    moderatorRating: attempt.moderatorRating ?? null,
    failureTag: attempt.failureTag ?? null,
    evalNotes: attempt.evalNotes ?? null,
  };
}

const ASPECT_RATIOS = new Set(["landscape", "square", "portrait"]);

/**
 * Bound an arbitrary client-supplied aspect ratio to a value the Nano Banana 2
 * engines accept — never let a raw client string reach `renderControls.aspectRatio`.
 * Defaults to "landscape" (the meme canvas default) when unrecognised.
 */
export function parseAspectRatio(value: unknown): "landscape" | "square" | "portrait" {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (ASPECT_RATIOS.has(v)) return v as "landscape" | "square" | "portrait";
    // Tolerate fal-style ratios if a caller passes them through.
    if (v === "16:9") return "landscape";
    if (v === "1:1") return "square";
    if (v === "9:16") return "portrait";
  }
  return "landscape";
}

/** "" / "none" / non-string → null (no style); otherwise the trimmed id. */
export function normalizeStyleId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "none") return null;
  return trimmed;
}
