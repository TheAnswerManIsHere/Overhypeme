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
import { ImagePromptError } from "../lib/imagePrompt/generator";
import { assembleImagePromptForPreview } from "../lib/imagePrompt/preview";
import { resolveRenderReviewInput } from "../lib/imagePrompt/resolveRenderReviewInput";

// Re-export the plan-generator test seam (now owned by the shared preview helper)
// so existing tests importing it from this route keep working.
export { __setPlanGeneratorForTest } from "../lib/imagePrompt/preview";

const router: IRouter = Router();

// ─── POST /admin/image-prompt/preview ────────────────────────────────────

interface PreviewBody {
  factId?: number;
  reviewId?: number;
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
}

router.post("/admin/image-prompt/preview", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as PreviewBody;
  const factId = typeof body.factId === "number" ? body.factId : NaN;
  const reviewId = typeof body.reviewId === "number" ? body.reviewId : NaN;

  if (!Number.isFinite(factId) && !Number.isFinite(reviewId)) {
    res.status(400).json({ error: "factId or reviewId is required" });
    return;
  }

  let sourceText: string;
  let enrichment: FactEnrichment;
  let resolvedFactId: number | null = null;

  if (Number.isFinite(reviewId)) {
    // Review path: look up the pending review for its submitted text + enrichment.
    // persist is silently ignored — there is no approved fact row yet to link to.
    const [reviewRow] = await db
      .select({ submittedText: pendingReviewsTable.submittedText, enrichment: pendingReviewsTable.enrichment })
      .from(pendingReviewsTable)
      .where(eq(pendingReviewsTable.id, reviewId))
      .limit(1);
    if (!reviewRow) {
      res.status(400).json({ error: "review_not_found", reviewId });
      return;
    }
    const ev = validateEnrichment(reviewRow.enrichment);
    if (!ev.ok) {
      res.status(400).json({ error: "fact_enrichment_invalid", details: ev.error });
      return;
    }
    sourceText = reviewRow.submittedText;
    enrichment = ev.data;
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
    const ev = validateEnrichment(factRow.enrichment);
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
  const resolved = await resolveRenderReviewInput(sourceText, enrichment, {
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
  } = resolved;

  const requestId = `admin-preview-${crypto.randomUUID()}`;
  let output;
  let compiled;
  try {
    const assembled = await assembleImagePromptForPreview({
      renderedFactText,
      enrichment,
      sourceImageAnalysis: analysis,
      subjectRenderMode,
      userSelectedSubjectRenderMode: body.userSelectedSubjectRenderMode ?? null,
      identityPolicy: identityPolicy as IdentityPolicy,
      renderControls,
      stylePrompt,
      referenceImageUrl: body.referenceImageUrl ?? null,
      // Resolve any residual identity tokens with the same sample subject used to
      // render the fact text, so {NAME} never reaches the engine prompt.
      renderedSubject: { name: previewName, pronouns: previewPronouns },
      requestId,
    });
    output = assembled.output;
    compiled = assembled.compiled;
  } catch (err) {
    const msg = err instanceof ImagePromptError ? err.message : err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "prompt_generation_failed", details: msg });
    return;
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
        sourceImageAnalysis: analysis,
        sourceImageSha256: analysis.sourceImageSha256 ?? null,
        identityPolicy,
        renderControls,
        factEnrichmentSnapshot: enrichment,
        renderedFactText,
        archetypeStrategyVersion: output.archetypeStrategyVersion,
        visualPlan: output.visualPlan,
        compiledPrompt: compiled,
        subjectFactCompatibility: output.visualPlan.subjectFactCompatibility,
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
    visualPlan: output.visualPlan,
    compiledPrompt: compiled,
    subjectFactCompatibility: output.visualPlan.subjectFactCompatibility,
    promptVersion: output.promptVersion,
    archetypeStrategyVersion: output.archetypeStrategyVersion,
    debug: {
      primaryArchetype: output.visualPlan.archetypeApplication.primaryArchetype,
      subtype: output.visualPlan.archetypeApplication.subtype,
      // `provided` = what the generator was given (authoritative); `used` = what
      // the plan echoed back as material and folded into the scene.
      culturalReferencesProvided: enrichment.culturalReferences ?? [],
      culturalReferencesUsed: output.visualPlan.culturalReferencesUsed ?? [],
      semanticEntitiesUsed: output.visualPlan.semanticEntitiesUsed ?? [],
      supportingTextPolicy: output.visualPlan.supportingTextPolicy,
      subjectFactCompatibility: output.visualPlan.subjectFactCompatibility,
      promptVersion: output.promptVersion,
      visualStrategyVersion: output.archetypeStrategyVersion,
      generatedAt: output.generatedAt,
      generatedBy: output.generatedBy,
    },
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
