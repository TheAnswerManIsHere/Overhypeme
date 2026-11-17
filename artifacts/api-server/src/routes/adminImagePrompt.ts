/**
 * Phase 2 admin/debug routes for the render-time image-prompt pipeline.
 *
 *   POST  /admin/image-prompt/preview    sync prompt-gen (no queue) — used by
 *                                        the engine workbench + Phase 2C UI.
 *   GET   /admin/image-prompt/attempts   recent image_prompt_attempts rows.
 *   POST  /admin/source-image/analyze    arbitrary-URL analyzer for debug
 *                                        (admin-only; bypasses storage-ownership
 *                                        gate that user-facing analyze-source enforces).
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, imagePromptAttemptsTable, factsTable, pendingReviewsTable } from "@workspace/db";
import {
  validateEnrichment,
  type RenderControls,
  type SubjectRenderMode,
  type SourceImageAnalysis,
  type FactEnrichment,
  type IdentityPolicy,
} from "@workspace/api-zod";
import { requireAdmin } from "./admin";
import { analyzeSourceImage } from "../lib/sourceImageAnalysis";
import { DirectGagInputError } from "../lib/imagePrompt/directInput";
import { assembleImagePromptForPreview } from "../lib/imagePrompt/preview";
import { liveRecipeForEngine } from "../lib/imagePrompt/recipeStore";
import { resolveReviewCycleEnrichment } from "../lib/moderationStaging";
import { gagRenderInput, loadGags, primaryGag, workingContent, type GagContent } from "../lib/gags/resolver";
import { currentImageEngineIds } from "../lib/imageEngineRouting.js";
import { RenderStyleRefusedError } from "../lib/imagePrompt/styleResolution.js";
import { NoUsablePhotoError, resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";

// Re-export the plan-generator test seam (now owned by the shared preview helper)
// so existing tests importing it from this route keep working.

const router: IRouter = Router();

// ─── POST /admin/image-prompt/preview ────────────────────────────────────

interface PreviewBody {
  factId?: number;
  reviewId?: number;
  /**
   * Moderation-modal context: the review whose Step-2 cycle this preview
   * belongs to (the modal passes factId = stagingFactId AND this). Makes the
   * preview read enrichment through the review-cycle resolver — the same
   * enrichment the scenario grid renders.
   */
  reviewIdForRender?: number;
  subjectRenderMode?: SubjectRenderMode;
  userSelectedSubjectRenderMode?: SubjectRenderMode;
  sourceImageAnalysis?: SourceImageAnalysis;
  uploadedObjectPath?: string;
  referenceImageUrl?: string;
  lookStyleId?: string | null;
  renderControls?: Partial<RenderControls>;
  identityPolicyOverrides?: Record<string, unknown>;
  persist?: boolean;
  // Optional sample subject so a moderator can preview the prompt (and any
  // tokenized override) rendered for different people. Defaults to the brand
  // protagonist when omitted/blank.
  previewName?: string;
  previewPronouns?: string;
  /** Preview this gag (its working content) instead of the fact's primary gag (fact_gags, migration 0139). */
  gagId?: number;
}

/**
 * The gag content a preview draws: the named gag's working content (it must be
 * one of this fact's non-removed gags), else none, so the caller keeps its own
 * default (the review's primary working gag, or the fact's primary gag).
 */
async function chosenGagContent(factId: number, gagId: number | undefined, fallback: "working" | "published"): Promise<GagContent | null | "not_found"> {
  if (typeof gagId === "number") {
    const gag = (await loadGags(factId)).find((g) => g.id === gagId);
    return gag ? workingContent(gag) ?? "not_found" : "not_found";
  }
  if (fallback === "published") return (await primaryGag(factId))?.content ?? null;
  return null;
}

router.post("/admin/image-prompt/preview", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as PreviewBody;
  const factId = typeof body.factId === "number" ? body.factId : NaN;
  const reviewId = typeof body.reviewId === "number" ? body.reviewId : NaN;
  const reviewIdForRender = typeof body.reviewIdForRender === "number" ? body.reviewIdForRender : NaN;

  if (!Number.isFinite(factId) && !Number.isFinite(reviewId)) {
    res.status(400).json({ error: "factId or reviewId is required" });
    return;
  }

  let sourceText: string;
  let enrichment: FactEnrichment;
  let resolvedFactId: number | null = null;

  if (Number.isFinite(reviewId) || Number.isFinite(reviewIdForRender)) {
    // Review-context path: resolve text + enrichment through the review-cycle
    // resolver so THIS preview and the review's renders/grid can never drift
    // (the staging fact's stored blob). Legacy reviews with no staging fact fall back
    // to the review-blob columns (pre-two-gate rows).
    const targetReviewId = Number.isFinite(reviewId) ? reviewId : reviewIdForRender;
    const [reviewRow] = await db
      .select({
        submittedText: pendingReviewsTable.submittedText,
        enrichment: pendingReviewsTable.enrichment,
        stagingFactId: pendingReviewsTable.stagingFactId,
      })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, targetReviewId))
      .limit(1);
    if (!reviewRow) {
      res.status(400).json({ error: "review_not_found", reviewId: targetReviewId });
      return;
    }
    // The moderation modal sends factId = stagingFactId alongside the review
    // context; a mismatch means a stale client — refuse rather than guess.
    if (Number.isFinite(factId) && reviewRow.stagingFactId != null && factId !== reviewRow.stagingFactId) {
      res.status(400).json({ error: "review_fact_mismatch", reviewId: targetReviewId, factId });
      return;
    }
    if (reviewRow.stagingFactId != null) {
      const cycle = await resolveReviewCycleEnrichment(reviewRow);
      if (!cycle) {
        res.status(400).json({ error: "staging_fact_missing", reviewId: targetReviewId });
        return;
      }
      const chosen = await chosenGagContent(cycle.factId, body.gagId, "working");
      if (chosen === "not_found") { res.status(400).json({ error: "gag_not_found", gagId: body.gagId }); return; }
      const ev = validateEnrichment(chosen && cycle.classification && typeof cycle.classification === "object"
        ? gagRenderInput(cycle.classification as FactEnrichment, chosen)
        : cycle.rawEnrichment);
      if (!ev.ok) {
        res.status(400).json({ error: "fact_enrichment_invalid", details: ev.error });
        return;
      }
      sourceText = cycle.text;
      enrichment = ev.data;
      resolvedFactId = cycle.factId;
    } else {
      const ev = validateEnrichment(reviewRow.enrichment);
      if (!ev.ok) {
        res.status(400).json({ error: "fact_enrichment_invalid", details: ev.error });
        return;
      }
      sourceText = reviewRow.submittedText;
      enrichment = ev.data;
    }
  } else {
    // Fact path: existing behaviour.
    const [factRow] = await db
      .select({ text: factsTable.text, enrichment: factsTable.enrichment })
      .from(factsTable)
      .where(eq(factsTable.id, factId))
      .limit(1);
    if (!factRow) {
      res.status(400).json({ error: "fact_not_found", factId });
      return;
    }
    // The render input: the fact's classification with a gag joined in
    // (fact_gags, migration 0139) — the named gag's working content, else the
    // fact's primary gag (its approved version where it has one).
    const chosen = await chosenGagContent(factId, body.gagId, "published");
    if (chosen === "not_found") { res.status(400).json({ error: "gag_not_found", gagId: body.gagId }); return; }
    const ev = validateEnrichment(chosen && factRow.enrichment && typeof factRow.enrichment === "object"
      ? gagRenderInput(factRow.enrichment as FactEnrichment, chosen)
      : factRow.enrichment);
    if (!ev.ok) {
      res.status(400).json({ error: "fact_enrichment_invalid", details: ev.error });
      return;
    }
    sourceText = factRow.text;
    enrichment = ev.data;
    resolvedFactId = factId;
  }

  // Deterministic input assembly — SHARED with the moderation render route so a
  // previewed prompt and the render that follows can never drift (analysis,
  // subject render mode, identity policy, render controls, style suffix, sample
  // subject, rendered fact text). See lib/imagePrompt/resolveRenderReviewInput.
  let resolved;
  try {
    resolved = await resolveRenderReviewInput(sourceText, enrichment, {
      subjectRenderMode: body.subjectRenderMode,
      userSelectedSubjectRenderMode: body.userSelectedSubjectRenderMode ?? null,
      sourceImageAnalysis: body.sourceImageAnalysis,
      uploadedObjectPath: body.uploadedObjectPath,
      referenceImageUrl: body.referenceImageUrl ?? null,
      lookStyleId: body.lookStyleId ?? null,
      renderControls: body.renderControls,
      identityPolicyOverrides: body.identityPolicyOverrides,
      previewName: body.previewName,
      previewPronouns: body.previewPronouns,
    });
  } catch (err) {
    if (err instanceof RenderStyleRefusedError) {
      res.status(400).json({ error: err.code, message: err.message, styleId: err.styleId, reason: err.reason });
      return;
    }
    if (err instanceof NoUsablePhotoError) {
      res.status(400).json({ error: err.code, message: err.message, reasons: err.reasons });
      return;
    }
    throw err;
  }
  const {
    analysis,
    subjectRenderMode,
    identityPolicy,
    renderControls,
    generationMode,
    stylePrompt,
    styleSource,
    previewName,
    previewPronouns,
    renderedFactText,
    lookClass,
  } = resolved;

  const requestId = `admin-preview-${crypto.randomUUID()}`;
  // The wording a render of this fact would use now: the live recipe for the
  // engine its look and mode are routed to (the prompt tuner), so the preview
  // shows what a render sends.
  const routedEngineId = (await currentImageEngineIds(lookClass))[generationMode];
  const { versionId: recipeVersionId, recipe } = await liveRecipeForEngine(routedEngineId);
  // The one selected gag, compiled directly: no model call, so this is the
  // prompt a render of it sends (plan PLAN_GAG_DIRECT_RENDER.md, D).
  let compiled;
  try {
    compiled = assembleImagePromptForPreview({
      gag: enrichment.visualPromptStrategyOverride,
      subjectRenderMode,
      renderControls,
      stylePrompt,
      referenceImageUrl: body.referenceImageUrl ?? null,
      // The same sample subject the fact text renders with, so {NAME} never
      // reaches the engine prompt.
      renderedSubject: { name: previewName, pronouns: previewPronouns },
      recipe,
    }).compiled;
  } catch (err) {
    if (err instanceof DirectGagInputError) {
      res.status(400).json({ error: err.code, message: err.message });
      return;
    }
    throw err;
  }

  let attemptId: number | undefined;
  // persist requires a real fact row — skip silently for the review path.
  if (body.persist && resolvedFactId !== null) {
    const [inserted] = await db
      .insert(imagePromptAttemptsTable)
      .values({
        factId: resolvedFactId,
        userId: (req as Request & { user?: { id: string } }).user?.id ?? null,
        requestId: requestId ?? null,
        generationMode,
        subjectRenderMode,
        userSelectedSubjectRenderMode: body.userSelectedSubjectRenderMode ?? null,
        targetEngine: "nano_banana_2",
        // A persisted preview is never rendered; it records the engine a render
        // of it would be routed to at the time it was made.
        actualImageEngineId: routedEngineId,
        recipeVersionId,
        sourceImageAnalysis: analysis,
        sourceImageSha256: analysis.sourceImageSha256 ?? null,
        identityPolicy,
        renderControls,
        factEnrichmentSnapshot: enrichment,
        renderedFactText,
        // The constant every attempt insert writes; no archetype strategy shapes a direct prompt.
        archetypeStrategyVersion: "v2",
        compiledPrompt: compiled,
      })
      .returning({ id: imagePromptAttemptsTable.id });
    attemptId = inserted?.id;
  }

  res.json({
    renderedFactText,
    inputSummary: {
      factId: resolvedFactId ?? null,
      subjectRenderMode,
      generationMode,
      targetEngine: "nano_banana_2",
      lookStyleId: body.lookStyleId ?? null,
      stylePrompt,
      styleSource,
      fallbackSubjectGender: renderControls.fallbackSubjectGender ?? null,
      preservePhysique: identityPolicy.preservePhysique,
      aspectRatio: renderControls.aspectRatio,
      negativeSpacePreference: renderControls.negativeSpacePreference ?? null,
    },
    compiledPrompt: compiled,
    attemptId,
  });
});

// ─── GET /admin/image-prompt/attempts ────────────────────────────────────

router.get("/admin/image-prompt/attempts", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const factId = Number(req.query["factId"]);
  const userId = typeof req.query["userId"] === "string" ? req.query["userId"] : undefined;
  const limit = Math.min(Math.max(Number(req.query["limit"]) || 20, 1), 100);

  const whereParts = [];
  if (Number.isFinite(factId)) whereParts.push(eq(imagePromptAttemptsTable.factId, factId));
  if (userId) whereParts.push(eq(imagePromptAttemptsTable.userId, userId));
  const where = whereParts.length === 0 ? undefined : whereParts.length === 1 ? whereParts[0] : and(...whereParts);

  const rows = await db
    .select()
    .from(imagePromptAttemptsTable)
    .where(where ?? sql`true`)
    .orderBy(desc(imagePromptAttemptsTable.createdAt))
    .limit(limit);

  res.json({ attempts: rows });
});

// ─── POST /admin/source-image/analyze ────────────────────────────────────

router.post("/admin/source-image/analyze", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as {
    uploadedObjectPath?: string;
    imageUrl?: string;
    skipAiFallback?: boolean;
    bypassCache?: boolean;
  };
  if (!body.uploadedObjectPath && !body.imageUrl) {
    res.status(400).json({ error: "uploadedObjectPath or imageUrl required" });
    return;
  }
  try {
    const analysis = await analyzeSourceImage(
      {
        uploadedObjectPath: body.uploadedObjectPath ?? "",
        imageUrl: body.imageUrl ?? body.uploadedObjectPath ?? "",
      },
      { skipAiFallback: body.skipAiFallback ?? false, bypassCache: body.bypassCache ?? false },
    );
    res.json({ analysis });
  } catch (err) {
    res.status(502).json({ error: "analysis_failed", details: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
