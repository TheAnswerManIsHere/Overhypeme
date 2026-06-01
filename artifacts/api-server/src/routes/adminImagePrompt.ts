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
import { db, imagePromptAttemptsTable, factsTable, lookStylesTable } from "@workspace/db";
import {
  defaultIdentityPolicyForRenderMode,
  validateEnrichment,
  type RenderControls,
  type SubjectRenderMode,
  type SourceImageAnalysis,
  type FactEnrichment,
  type ImagePromptGenerationInput,
} from "@workspace/api-zod";
import { requireAdmin } from "./admin";
import { analyzeSourceImage, generationModeFromSubjectRenderMode, noImageAnalysis } from "../lib/sourceImageAnalysis";
import { generateImagePromptPlan, ImagePromptError } from "../lib/imagePrompt/generator";
import { compileForSubjectRenderMode } from "../lib/imagePrompt/compilers/nanoBanana2";
import { renderPersonalized } from "../lib/renderCanonical";

const router: IRouter = Router();

// Admin runtime-prompt-preview uses the brand protagonist as the rendered
// identity (David). The generator expects RENDERED fact text (tokens resolved),
// so we personalize before prompt generation — not just for display.
const PREVIEW_NAME = "David";
const PREVIEW_PRONOUNS = "he/him";

// Test seam: the route statically imports the live (OpenAI-backed)
// generateImagePromptPlan. Mirroring adminEngines.ts, we route the call through
// a swappable binding so tests can stub it without hitting OpenAI.
type PlanGenerator = typeof generateImagePromptPlan;
let planGenerator: PlanGenerator = generateImagePromptPlan;
export function __setPlanGeneratorForTest(fn: PlanGenerator | null): void {
  planGenerator = fn ?? generateImagePromptPlan;
}

// ─── POST /admin/image-prompt/preview ────────────────────────────────────

interface PreviewBody {
  factId?: number;
  subjectRenderMode?: SubjectRenderMode;
  userSelectedSubjectRenderMode?: SubjectRenderMode;
  sourceImageAnalysis?: SourceImageAnalysis;
  uploadedObjectPath?: string;
  referenceImageUrl?: string;
  lookStyleId?: string | null;
  renderControls?: Partial<RenderControls>;
  identityPolicyOverrides?: Record<string, unknown>;
  persist?: boolean;
}

router.post("/admin/image-prompt/preview", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as PreviewBody;
  const factId = typeof body.factId === "number" ? body.factId : NaN;
  if (!Number.isFinite(factId)) {
    res.status(400).json({ error: "factId is required" });
    return;
  }

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
  const enrichment: FactEnrichment = ev.data;

  // Resolve source-image analysis: caller can supply a synthetic blob, OR
  // pass uploadedObjectPath to run the real analyzer, OR omit both (= no
  // reference image; t2i_fallback).
  let analysis: SourceImageAnalysis;
  if (body.sourceImageAnalysis) {
    analysis = body.sourceImageAnalysis;
  } else if (body.uploadedObjectPath) {
    analysis = await analyzeSourceImage(
      { uploadedObjectPath: body.uploadedObjectPath, imageUrl: body.referenceImageUrl ?? "" },
      { skipAiFallback: false },
    );
  } else {
    analysis = noImageAnalysis();
  }

  const subjectRenderMode: SubjectRenderMode = body.subjectRenderMode ?? analysis.suggestedRenderMode;
  const identityPolicy = {
    ...defaultIdentityPolicyForRenderMode(subjectRenderMode),
    ...(body.identityPolicyOverrides ?? {}),
  };

  const renderControls: RenderControls & { styleId?: string | null; referenceImageUrl?: string | null } = {
    aspectRatio: body.renderControls?.aspectRatio ?? "portrait",
    contentMode: body.renderControls?.contentMode ?? "sfw",
    negativeSpacePreference: body.renderControls?.negativeSpacePreference,
    fallbackSubjectGender: body.renderControls?.fallbackSubjectGender,
    styleId: body.lookStyleId ?? null,
    referenceImageUrl: body.referenceImageUrl ?? null,
  };

  // Resolve style suffix from look_styles (if any).
  const generationMode = generationModeFromSubjectRenderMode(subjectRenderMode);
  let stylePrompt = "";
  if (body.lookStyleId) {
    const [ls] = await db
      .select({
        promptSuffix: lookStylesTable.promptSuffix,
        promptSuffixReference: lookStylesTable.promptSuffixReference,
      })
      .from(lookStylesTable)
      .where(eq(lookStylesTable.id, body.lookStyleId))
      .limit(1);
    if (ls) {
      stylePrompt = generationMode === "i2i" ? ls.promptSuffixReference : ls.promptSuffix;
    }
  }
  const styleSource: "selected_look_style" | "none" =
    body.lookStyleId && stylePrompt ? "selected_look_style" : "none";

  // The generator expects rendered fact text (tokens resolved). Fact templates
  // store {NAME}/{SUBJ}/… — personalize with the brand protagonist for the
  // preview so the generated plan matches what a real render would see.
  const renderedFactText = renderPersonalized(factRow.text, PREVIEW_NAME, PREVIEW_PRONOUNS);

  const input: ImagePromptGenerationInput = {
    factText: renderedFactText,
    enrichment,
    sourceImageAnalysis: analysis,
    subjectRenderMode,
    userSelectedSubjectRenderMode: body.userSelectedSubjectRenderMode ?? null,
    identityPolicy: identityPolicy as ImagePromptGenerationInput["identityPolicy"],
    renderControls,
    stylePrompt,
    referenceImageUrl: body.referenceImageUrl ?? null,
    targetEngine: "nano_banana_2",
    requestId: `admin-preview-${crypto.randomUUID()}`,
  };

  let output;
  try {
    output = await planGenerator(input);
  } catch (err) {
    const msg = err instanceof ImagePromptError ? err.message : err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "prompt_generation_failed", details: msg });
    return;
  }

  const compiled = compileForSubjectRenderMode({
    visualPlan: output.visualPlan,
    compiledPrompt: output.compiledPrompt,
    input,
  });

  let attemptId: number | undefined;
  if (body.persist) {
    const [inserted] = await db
      .insert(imagePromptAttemptsTable)
      .values({
        factId,
        userId: (req as Request & { user?: { id: string } }).user?.id ?? null,
        requestId: input.requestId ?? null,
        generationMode,
        subjectRenderMode,
        userSelectedSubjectRenderMode: body.userSelectedSubjectRenderMode ?? null,
        targetEngine: "nano_banana_2",
        sourceImageAnalysis: analysis,
        sourceImageSha256: analysis.sourceImageSha256 ?? null,
        identityPolicy,
        renderControls,
        factEnrichmentSnapshot: enrichment,
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
      factId,
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
      // The visualPlan has no echo array for cultural references, so we surface
      // what the generator was *given* (provided) vs. what the plan echoes
      // (used — currently none for cultural refs). `provided` is authoritative.
      culturalReferencesProvided: enrichment.culturalReferences ?? [],
      culturalReferencesUsed: [] as unknown[],
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
