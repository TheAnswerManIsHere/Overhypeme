/**
 * Shared, deterministic resolution of render-review inputs from request controls.
 *
 * The Phase-2C admin "Runtime Compiled Prompt Preview" (`POST
 * /admin/image-prompt/preview`, fact path) and the moderation "Render AI
 * background" action (`POST /admin/reviews/:id/render`) must feed the IDENTICAL
 * assembled inputs to the rendering pipeline — otherwise the prompt a moderator
 * previews can diverge from the prompt the render actually compiles. This helper
 * owns that assembly in ONE place so the two callers can't drift:
 *
 *   sourceText + enrichment + raw controls →
 *     { renderedFactText, analysis, subjectRenderMode, identityPolicy,
 *       renderControls (with styleId/referenceImageUrl), stylePrompt,
 *       renderedSubject, generationMode }
 *
 * It is deterministic input assembly only — NO authorization, NO DB writes, NO
 * prompt generation. The preview route runs the planner/compiler on this; the
 * render route inserts an attempt + enqueues the async pipeline on this.
 */
import { eq } from "drizzle-orm";
import { db, lookStylesTable } from "@workspace/db";
import {
  defaultIdentityPolicyForRenderMode,
  type FactEnrichment,
  type GenerationMode,
  type IdentityPolicy,
  type RenderControls,
  type SourceImageAnalysis,
  type SubjectRenderMode,
} from "@workspace/api-zod";
import { analyzeSourceImage, generationModeFromSubjectRenderMode, noImageAnalysis } from "../sourceImageAnalysis";
import { renderPersonalized } from "../renderCanonical";
import {
  RUNTIME_PREVIEW_DEFAULT_NAME,
  RUNTIME_PREVIEW_DEFAULT_PRONOUNS,
  type RenderControlsWithRefs,
} from "./preview";

/** Raw render assumptions a caller passes through (mirrors the preview body). */
export interface RenderReviewControls {
  subjectRenderMode?: SubjectRenderMode;
  userSelectedSubjectRenderMode?: SubjectRenderMode | null;
  sourceImageAnalysis?: SourceImageAnalysis;
  uploadedObjectPath?: string;
  referenceImageUrl?: string | null;
  lookStyleId?: string | null;
  renderControls?: Partial<RenderControls>;
  identityPolicyOverrides?: Record<string, unknown>;
  previewName?: string;
  previewPronouns?: string;
}

export interface ResolvedRenderReviewInput {
  renderedFactText: string;
  analysis: SourceImageAnalysis;
  subjectRenderMode: SubjectRenderMode;
  userSelectedSubjectRenderMode: SubjectRenderMode | null;
  identityPolicy: IdentityPolicy;
  /** renderControls carrying the route-attached `styleId` + `referenceImageUrl`. */
  renderControls: RenderControlsWithRefs;
  stylePrompt: string;
  styleSource: "selected_look_style" | "none";
  renderedSubject: { name: string; pronouns: string };
  generationMode: GenerationMode;
  previewName: string;
  previewPronouns: string;
}

/** Pronouns must look like "subj/obj"; otherwise fall back to the brand default. */
function resolvePreviewSubject(controls: RenderReviewControls): { name: string; pronouns: string } {
  const name =
    typeof controls.previewName === "string" && controls.previewName.trim()
      ? controls.previewName.trim()
      : RUNTIME_PREVIEW_DEFAULT_NAME;
  const pronouns =
    typeof controls.previewPronouns === "string" && /^\s*[a-z]+\/[a-z]+\s*$/i.test(controls.previewPronouns)
      ? controls.previewPronouns.trim().toLowerCase()
      : RUNTIME_PREVIEW_DEFAULT_PRONOUNS;
  return { name, pronouns };
}

export async function resolveRenderReviewInput(
  sourceText: string,
  enrichment: FactEnrichment,
  controls: RenderReviewControls,
): Promise<ResolvedRenderReviewInput> {
  // Source-image analysis: synthetic blob → analyze upload → no-image (t2i).
  let analysis: SourceImageAnalysis;
  if (controls.sourceImageAnalysis) {
    analysis = controls.sourceImageAnalysis;
  } else if (controls.uploadedObjectPath) {
    analysis = await analyzeSourceImage(
      { uploadedObjectPath: controls.uploadedObjectPath, imageUrl: controls.referenceImageUrl ?? "" },
      { skipAiFallback: false },
    );
  } else {
    analysis = noImageAnalysis();
  }

  const subjectRenderMode: SubjectRenderMode = controls.subjectRenderMode ?? analysis.suggestedRenderMode;
  const identityPolicy = {
    ...defaultIdentityPolicyForRenderMode(subjectRenderMode),
    ...(controls.identityPolicyOverrides ?? {}),
  } as IdentityPolicy;

  const renderControls: RenderControlsWithRefs = {
    aspectRatio: controls.renderControls?.aspectRatio ?? "portrait",
    contentMode: controls.renderControls?.contentMode ?? "sfw",
    negativeSpacePreference: controls.renderControls?.negativeSpacePreference,
    fallbackSubjectGender: controls.renderControls?.fallbackSubjectGender,
    styleId: controls.lookStyleId ?? null,
    referenceImageUrl: controls.referenceImageUrl ?? null,
  };

  // Resolve the look-style suffix per generation mode (i2i vs t2i variant).
  const generationMode = generationModeFromSubjectRenderMode(subjectRenderMode);
  let stylePrompt = "";
  if (controls.lookStyleId) {
    const [ls] = await db
      .select({
        promptSuffix: lookStylesTable.promptSuffix,
        promptSuffixReference: lookStylesTable.promptSuffixReference,
      })
      .from(lookStylesTable)
      .where(eq(lookStylesTable.id, controls.lookStyleId))
      .limit(1);
    if (ls) stylePrompt = generationMode === "i2i" ? ls.promptSuffixReference : ls.promptSuffix;
  }
  const styleSource: "selected_look_style" | "none" =
    controls.lookStyleId && stylePrompt ? "selected_look_style" : "none";

  const renderedSubject = resolvePreviewSubject(controls);
  // The generator/compiler expect RENDERED fact text — personalize the template
  // ({NAME}/{SUBJ}/…) with the sample subject so no token reaches the engine.
  const renderedFactText = renderPersonalized(sourceText, renderedSubject.name, renderedSubject.pronouns);

  return {
    renderedFactText,
    analysis,
    subjectRenderMode,
    userSelectedSubjectRenderMode: controls.userSelectedSubjectRenderMode ?? null,
    identityPolicy,
    renderControls,
    stylePrompt,
    styleSource,
    renderedSubject,
    generationMode,
    previewName: renderedSubject.name,
    previewPronouns: renderedSubject.pronouns,
  };
}
