/**
 * Phase 2 — source-image analyzer entrypoint.
 *
 * Pipeline:
 *   1. Resolve sha256 from upload_image_metadata (existing arachnid hash).
 *   2. Cache lookup: if upload_image_metadata.source_image_analysis is set AND
 *      version matches SOURCE_IMAGE_ANALYZER_VERSION, return it.
 *   3. Tier-1: call the configured fal detector engine.
 *   4. Tier-2: deterministic heuristics → SourceImageAnalysis.
 *   5. Tier-3 (optional): OpenAI vision fallback when Tier-2 escalates.
 *   6. Cache write-through: persist the result back to upload_image_metadata.
 *
 * Inputs are ALWAYS internal storage references (uploadedObjectPath). The
 * route layer (/memes/ai/:factId/analyze-source) enforces ownership before
 * calling this. Arbitrary external URLs are forbidden by the route, not by
 * this module — keep the analyzer URL-agnostic so internal admin tooling
 * can also call it on object storage paths.
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
import { runTier1Detector, Tier1DetectorError } from "./tier1FalDetector";
import { classifyTier2 } from "./tier2Heuristics";
import { runTier3AiVisionFallback, Tier3VisionError } from "./tier3AiVisionFallback";

export interface AnalyzeSourceImageOptions {
  /** Skip the Tier-3 escalation. Tests + admin debug surface use this. */
  skipAiFallback?: boolean;
  /** Force a fresh analysis even when a cached one exists. */
  bypassCache?: boolean;
  /** Image dimensions (for area-fraction math in Tier 2). */
  imageWidth?: number;
  imageHeight?: number;
}

export interface AnalyzeSourceImageRef {
  /** Object storage path on the upload_image_metadata table. */
  uploadedObjectPath: string;
  /** Resolvable URL the detector can fetch. */
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

  const width = opts.imageWidth ?? meta?.width ?? undefined;
  const height = opts.imageHeight ?? meta?.height ?? undefined;

  // 2. Tier-1: fal detector.
  let tier1Detections: import("@workspace/api-zod").SourceImageDetection[] = [];
  let tier1Failed = false;
  try {
    const r = await runTier1Detector(ref.imageUrl);
    tier1Detections = r.detections;
  } catch (err) {
    if (err instanceof Tier1DetectorError) {
      logger.warn({ err }, "[analyzeSourceImage] Tier-1 detector failed; falling back");
      tier1Failed = true;
    } else {
      throw err;
    }
  }

  // 3. Tier-2: heuristics.
  const t2 = classifyTier2(tier1Detections, {
    ...(width != null ? { imageWidth: width } : {}),
    ...(height != null ? { imageHeight: height } : {}),
  });
  let analysis: SourceImageAnalysis = {
    ...t2.analysis,
    classificationMethod: tier1Failed ? "not_analyzed" : "fal_detector",
    analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
    sourceImageSha256: sha256,
  };

  // 4. Tier-3 escalation (only if Tier-2 says so + AI fallback isn't suppressed).
  if (t2.shouldEscalate && !opts.skipAiFallback) {
    try {
      const t3 = await runTier3AiVisionFallback(ref.imageUrl);
      analysis = {
        ...t3,
        detections: tier1Detections, // keep Tier-1 detections for debug visibility
        classificationMethod: "ai_vision_fallback",
        analyzerVersion: SOURCE_IMAGE_ANALYZER_VERSION,
        sourceImageSha256: sha256,
      };
    } catch (err) {
      logger.warn({ err }, "[analyzeSourceImage] Tier-3 AI vision fallback failed; keeping Tier-2 result");
      analysis = {
        ...analysis,
        warnings: [...analysis.warnings, "AI vision fallback unavailable; classification may be uncertain."],
      };
    }
  }

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
  width: number | null;
  height: number | null;
  sourceImageAnalysis: unknown;
  sourceImageAnalysisVersion: string | null;
} | null> {
  const [row] = await db
    .select({
      arachnidSha256Hex: uploadImageMetadataTable.arachnidSha256Hex,
      width: uploadImageMetadataTable.width,
      height: uploadImageMetadataTable.height,
      sourceImageAnalysis: uploadImageMetadataTable.sourceImageAnalysis,
      sourceImageAnalysisVersion: uploadImageMetadataTable.sourceImageAnalysisVersion,
    })
    .from(uploadImageMetadataTable)
    .where(eq(uploadImageMetadataTable.objectPath, objectPath))
    .limit(1);
  return row ?? null;
}

// ─── Render-mode resolution ──────────────────────────────────────────────

/**
 * Resolve the final SubjectRenderMode for a render. Honors user override
 * when supplied (Tier 4). The analyzer's `suggestedRenderMode` is the
 * automatic recommendation.
 */
export function resolveSubjectRenderMode(
  analysis: SourceImageAnalysis,
  userChoice?: SubjectRenderMode | null,
): SubjectRenderMode {
  if (userChoice) return userChoice;
  return analysis.suggestedRenderMode;
}

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

export { getSubjectWarning } from "./warnings";
