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
import { db, imagePromptAttemptsTable } from "@workspace/db";
import type {
  FactEnrichment,
  IdentityPolicy,
  RenderControls,
  SourceImageAnalysis,
  SubjectRenderMode,
} from "@workspace/api-zod";
import { generationModeFromSubjectRenderMode } from "./sourceImageAnalysis";
import { enqueueJob } from "./asyncJobs";

/** RenderControls plus the two route-attached fields `imagePromptJobs` reads. */
export type RenderControlsWithRefs = RenderControls & {
  styleId?: string | null;
  referenceImageUrl?: string | null;
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
    })
    .returning({ id: imagePromptAttemptsTable.id });

  await enqueueJob({
    queue: "image_prompt_generation",
    payload: { attemptId: attempt!.id },
    dedupeKey: `image_prompt:attempt:${attempt!.id}`,
  });

  return { renderJobId, attemptId: attempt!.id };
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
