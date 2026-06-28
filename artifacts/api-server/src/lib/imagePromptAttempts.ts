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

/** RenderControls plus the route-attached fields `imagePromptJobs` reads. */
export type RenderControlsWithRefs = RenderControls & {
  styleId?: string | null;
  referenceImageUrl?: string | null;
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
  /** Provenance for an admin-triggered moderation render (review + admin actor). */
  reviewAudit?: { reviewId: number; adminUserId: string };
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
   * Moderation render-scenario metadata. Set ONLY for Step-2 visual-review
   * attempts; makes `image_prompt_attempts` the durable source of truth for the
   * scenario grid (see factRenderScenarios.ts / reviewRenderScenarios.ts).
   */
  scenario?: {
    reviewId: number;
    scenarioKey: string;
    inputHash: string;
    referenceAssetVersion?: string | null;
    referenceIdentityType?: string | null;
    batchId?: string | null;
  };
}

/**
 * Insert an `image_prompt_attempts` row and enqueue `image_prompt_generation`.
 * Returns the `renderJobId` (for `GET /memes/ai/renders/:renderJobId` polling)
 * and the numeric `attemptId`.
 */
export async function buildAndEnqueueImagePromptAttempt(
  args: BuildImagePromptAttemptArgs,
): Promise<{ renderJobId: string; attemptId: number }> {
  const generationMode = generationModeFromSubjectRenderMode(args.subjectRenderMode);
  const renderJobId = randomUUID();
  const [attempt] = await db
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
      sourceImageAnalysis: args.analysis,
      sourceImageSha256: args.analysis.sourceImageSha256 ?? null,
      identityPolicy: args.identityPolicy,
      renderControls: args.renderControls,
      factEnrichmentSnapshot: args.enrichment,
      renderedFactText: args.renderedFactText,
      archetypeStrategyVersion: "v2",
      reviewId: args.scenario?.reviewId ?? null,
      reviewRenderScenarioKey: args.scenario?.scenarioKey ?? null,
      reviewRenderInputHash: args.scenario?.inputHash ?? null,
      reviewReferenceAssetVersion: args.scenario?.referenceAssetVersion ?? null,
      reviewReferenceIdentityType: args.scenario?.referenceIdentityType ?? null,
      reviewRenderBatchId: args.scenario?.batchId ?? null,
    })
    .returning({ id: imagePromptAttemptsTable.id });

  await enqueueJob({
    queue: "image_prompt_generation",
    payload: { attemptId: attempt!.id },
    dedupeKey: `image_prompt:attempt:${attempt!.id}`,
  });

  return { renderJobId, attemptId: attempt!.id };
}

export type RenderStatus = "pending" | "prompt_ready" | "image_ready" | "failed" | "blocked";

/**
 * Map an `image_prompt_attempts` row to the render-poll payload. Shared by the
 * user-facing `GET /memes/ai/renders/:renderJobId` and the admin moderation poll
 * `GET /admin/reviews/:id/renders/:renderJobId` so the two routes can't drift.
 *
 * A "poor" subject↔fact compatibility is a deliberate product block (not an
 * engine failure): the prompt job recorded the reason and skipped image
 * generation, surfaced here as its own `blocked` state.
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
} {
  const blockedPoor = attempt.error === "subject_fact_compatibility_poor";
  let status: RenderStatus;
  if (blockedPoor) status = "blocked";
  else if (attempt.error) status = "failed";
  else if (attempt.generatedImageObjectPath) status = "image_ready";
  else if (attempt.visualPlan) status = "prompt_ready";
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
