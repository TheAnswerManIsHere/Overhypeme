/**
 * Phase 2 — source-image analyzer entrypoint.
 *
 * Pipeline:
 *   1. Resolve sha256 from upload_image_metadata (existing arachnid hash).
 *   2. Cache lookup: unless the caller sets bypassCache, if
 *      upload_image_metadata.source_image_analysis is set AND version matches
 *      SOURCE_IMAGE_ANALYZER_VERSION, return it.
 *   3. The AI vision check classifies the photo (David, Q9, Issue #945: the
 *      fal detector and the heuristics that read it are gone). Skipped, it
 *      returns "not analysed"; failing, it returns "not analysed" uncached.
 *   4. Cache write-through: persist the result back to upload_image_metadata,
 *      when the upload has a metadata row.
 *
 * Inputs are ALWAYS internal storage references (uploadedObjectPath). The
 * route layer (/memes/ai/:factId/analyze-source) enforces ownership before
 * calling this. Arbitrary external URLs are forbidden by the route, not by
 * this module — keep the analyzer URL-agnostic so internal admin tooling
 * can also call it on object storage paths.
 *
 * @purpose Source-image analyzer entrypoint: returns the stored analysis when one exists, its version matches and the caller has not set bypassCache, else classifies the photo with the AI vision check (unless the caller skips it), caching a successful result on the upload's metadata row when one exists; also resolves the subject render mode.
 * @subsystem visual-pipeline
 */

import { eq } from "drizzle-orm";
import { db, uploadImageMetadataTable } from "@workspace/db";
import {
  type SourceImageAnalysis,
  type SubjectRenderMode,
  type GenerationMode,
  SOURCE_IMAGE_ANALYZER_VERSION,
} from "@workspace/api-zod";
import { logger } from "../logger";
import { runTier3AiVisionFallback, Tier3VisionError } from "./tier3AiVisionFallback";

let tier3: typeof runTier3AiVisionFallback = runTier3AiVisionFallback;
/** Test seam: replace the AI vision check (null restores it). */
export function __setTier3ForTest(fn: typeof runTier3AiVisionFallback | null): void {
  tier3 = fn ?? runTier3AiVisionFallback;
}

/** An unclassified photo: no subject is claimed, so no picture is drawn from it. */
function notAnalyzed(sha256: string | undefined, warning: string): SourceImageAnalysis {
  return {
    subjectKind: "detection_failed",
    confidence: "low",
    hasUsableHumanFace: false,
    hasUsableSubject: false,
    subjectCount: 0,
    detections: [],
    suggestedRenderMode: "t2i_fallback",
    warnings: [warning],
    classificationMethod: "not_analyzed",
    analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
    sourceImageSha256: sha256,
  };
}

export interface AnalyzeSourceImageOptions {
  /** Skip the AI vision check (the admin debug surface): the photo is returned unclassified, uncached. */
  skipAiFallback?: boolean;
  /** Force a fresh analysis even when a cached one exists. */
  bypassCache?: boolean;
  /**
   * Called once each time this analysis actually asks the paid vision check
   * and gets an answer (never on a cache hit), so a caller can record that
   * call's cost: a cached result does not say whether this request paid.
   */
  onPaidCheck?: () => Promise<void>;
}

export interface AnalyzeSourceImageRef {
  /** Object storage path on the upload_image_metadata table. */
  uploadedObjectPath: string;
  /** Resolvable URL the AI vision check can fetch. */
  imageUrl: string;
}

/**
 * Analyze a source image; returns SourceImageAnalysis. Caches result on
 * upload_image_metadata keyed by sha256 + analyzer version.
 */
export async function analyzeSourceImage(
  ref: AnalyzeSourceImageRef,
  opts: AnalyzeSourceImageOptions = {},
): Promise<SourceImageAnalysis> {
  const meta = await loadUploadMeta(ref.uploadedObjectPath);
  const sha256 = meta?.arachnidSha256Hex ?? undefined;

  // 1. Cache hit?
  if (!opts.bypassCache && meta?.sourceImageAnalysis && meta.sourceImageAnalysisVersion === SOURCE_IMAGE_ANALYZER_VERSION) {
    return meta.sourceImageAnalysis as SourceImageAnalysis;
  }

  // The AI vision check is the analysis (David, Q9, Issue #945). The fal
  // object detector that ran first is gone: its endpoint no longer exists, so
  // every photo read as "no detectable subject" and was refused, and the
  // check below was never reached. Its prompt carries the people-or-pets rule
  // (FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT).
  // Neither a skip nor a failure is cached: a later analysis of the same
  // photo asks the check again rather than inherit "not classified".
  if (opts.skipAiFallback) {
    return notAnalyzed(sha256, "The AI vision check was skipped, so this photo was not classified.");
  }
  let analysis: SourceImageAnalysis;
  try {
    const verdict = await tier3(ref.imageUrl);
    analysis = {
      ...verdict,
      detections: [],
      classificationMethod: "ai_vision_fallback",
      analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
      sourceImageSha256: sha256,
    };
  } catch (err) {
    logger.warn({ err, expected: err instanceof Tier3VisionError }, "[analyzeSourceImage] AI vision check failed; the photo is not classified");
    return notAnalyzed(sha256, "The AI vision check is unavailable right now, so this photo could not be classified. Try again shortly.");
  }
  await opts.onPaidCheck?.();

  // 5. Cache write-through.
  if (meta) {
    try {
      await db
        .update(uploadImageMetadataTable)
        .set({
          sourceImageAnalysis: analysis,
          sourceImageAnalysisVersion: SOURCE_IMAGE_ANALYZER_VERSION,
        })
        .where(eq(uploadImageMetadataTable.objectPath, ref.uploadedObjectPath));
    } catch (err) {
      logger.warn({ err, objectPath: ref.uploadedObjectPath }, "[analyzeSourceImage] cache write failed (non-fatal)");
    }
  }

  return analysis;
}

async function loadUploadMeta(objectPath: string): Promise<{
  arachnidSha256Hex: string | null;
  sourceImageAnalysis: unknown;
  sourceImageAnalysisVersion: string | null;
} | null> {
  const [row] = await db
    .select({
      arachnidSha256Hex: uploadImageMetadataTable.arachnidSha256Hex,
      sourceImageAnalysis: uploadImageMetadataTable.sourceImageAnalysis,
      sourceImageAnalysisVersion: uploadImageMetadataTable.sourceImageAnalysisVersion,
    })
    .from(uploadImageMetadataTable)
    .where(eq(uploadImageMetadataTable.objectPath, objectPath))
    .limit(1);
  return row ?? null;
}

// ─── Render-mode resolution ──────────────────────────────────────────────

/** Map subject render mode → engine generation mode. */
export function generationModeFromSubjectRenderMode(mode: SubjectRenderMode): GenerationMode {
  return mode === "t2i_fallback" ? "t2i" : "i2i";
}

/** Sentinel SourceImageAnalysis used when the caller has no reference image at all. */
export function noImageAnalysis(): SourceImageAnalysis {
  return {
    subjectKind: "scene_no_clear_subject",
    confidence: "high",
    hasUsableHumanFace: false,
    hasUsableSubject: false,
    subjectCount: 0,
    detections: [],
    suggestedRenderMode: "t2i_fallback",
    warnings: [],
    classificationMethod: "not_analyzed",
    analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
  };
}

