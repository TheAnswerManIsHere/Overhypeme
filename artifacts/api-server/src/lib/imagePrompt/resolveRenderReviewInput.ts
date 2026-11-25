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
import {
  defaultIdentityPolicyForRenderMode,
  type GagRenderInput,
  type GenerationMode,
  type IdentityPolicy,
  type ReferenceIdentityType,
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
import { resolveAndFreezeRenderStyle } from "./styleResolution";
import { lookClassOfSelection, type LookClass } from "../imageEngineRouting";

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
  /**
   * The fixed reference photo a moderation or capture render uses, when it
   * uses one. Its identity names the sample subject: the wife's photo renders
   * as Raena Franklin, she/her; every other one as David Franklin, he/him.
   */
  referenceIdentityType?: ReferenceIdentityType | null;
}

/**
 * A render cannot start because it has no usable photo: none was given, or
 * the one given shows no usable face or subject. Every picture starts from a
 * photo (compiler review, Phase 2; David, 2026-11-14), so the person is asked
 * for a better photo rather than given a picture without one.
 */
export class NoUsablePhotoError extends Error {
  readonly code = "no_usable_photo";
  constructor(readonly reasons: string[]) {
    super(`this photo cannot be used${reasons.length ? `: ${reasons.join("; ")}` : ""}. Use a photo with one clear face or subject.`);
    this.name = "NoUsablePhotoError";
  }
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
  /** No look is photoreal, a chosen look is styled; the engine is picked by it. */
  lookClass: LookClass;
  renderedSubject: { name: string; pronouns: string };
  generationMode: GenerationMode;
  previewName: string;
  previewPronouns: string;
}

/** Default sampled subject for a t2i fallback gender, so the sampled name AND
 *  pronouns match the protagonist the engine is told to generate (a female
 *  "Generate a female protagonist" render sampling "David Franklin … his pants"
 *  is an incoherent test image). i2i modes carry a null gender (the reference IS
 *  the subject) and keep the historical brand default. */
export function defaultPreviewSubjectForGender(
  gender: RenderControls["fallbackSubjectGender"] | null | undefined,
): { name: string; pronouns: string } {
  switch (gender) {
    case "female":
      return { name: "Raena Franklin", pronouns: "she/her" };
    case "neutral":
      return { name: "Alex Franklin", pronouns: "they/them" };
    default: // "male" and null/undefined (i2i) → historical default
      return { name: RUNTIME_PREVIEW_DEFAULT_NAME, pronouns: RUNTIME_PREVIEW_DEFAULT_PRONOUNS };
  }
}

/** The pet reference photo's sample subject: Mango, the cat, he/him (David, 2026-11-17, Issue #983). */
export const PET_PREVIEW_SUBJECT = { name: "Mango", pronouns: "he/him" } as const;

/**
 * The sample subject for a fixed reference photo, so the fact text agrees
 * with the face: the wife's renders as Raena Franklin, she/her; the pet's as
 * Mango, he/him; David's as the historical default.
 */
export function defaultPreviewSubjectForReference(
  identityType: ReferenceIdentityType | null | undefined,
): { name: string; pronouns: string } {
  if (identityType === "nonhuman_animal") return { ...PET_PREVIEW_SUBJECT };
  return defaultPreviewSubjectForGender(identityType === "female" ? "female" : null);
}

/** Pronouns must look like "subj/obj"; otherwise fall back to the reference photo's default. */
function resolvePreviewSubject(controls: RenderReviewControls): { name: string; pronouns: string } {
  const fallback = defaultPreviewSubjectForReference(controls.referenceIdentityType);
  const name =
    typeof controls.previewName === "string" && controls.previewName.trim()
      ? controls.previewName.trim()
      : fallback.name;
  const pronouns =
    typeof controls.previewPronouns === "string" && /^\s*[a-z]+\/[a-z]+\s*$/i.test(controls.previewPronouns)
      ? controls.previewPronouns.trim().toLowerCase()
      : fallback.pronouns;
  return { name, pronouns };
}

export async function resolveRenderReviewInput(
  sourceText: string,
  enrichment: GagRenderInput,
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
  // No picture without a usable photo: the analysis's no-photo suggestion, or
  // a caller asking for the retired mode, is refused with the analysis's own
  // reasons, never drawn as an invented person.
  if (subjectRenderMode === "t2i_fallback") {
    const reasons = (analysis.warnings ?? []).filter(Boolean);
    throw new NoUsablePhotoError(controls.uploadedObjectPath || controls.sourceImageAnalysis ? reasons : ["no photo was given"]);
  }
  const identityPolicy = {
    ...defaultIdentityPolicyForRenderMode(subjectRenderMode),
    ...(controls.identityPolicyOverrides ?? {}),
  } as IdentityPolicy;

  // The look, resolved once per generation mode (i2i vs t2i variant) and
  // frozen onto the render controls: the worker reads this snapshot, never
  // the look's row, and the engine is picked by its look class. A look that
  // cannot be used throws `RenderStyleRefusedError`, never "no look".
  const generationMode = generationModeFromSubjectRenderMode(subjectRenderMode);
  const resolvedRenderStyle = await resolveAndFreezeRenderStyle(controls.lookStyleId, generationMode);
  const stylePrompt = resolvedRenderStyle.selection === "selected" ? resolvedRenderStyle.prompt : "";
  const styleSource: "selected_look_style" | "none" = resolvedRenderStyle.selection === "selected" ? "selected_look_style" : "none";
  const lookClass = lookClassOfSelection(resolvedRenderStyle.selection);

  const renderControls: RenderControlsWithRefs = {
    aspectRatio: controls.renderControls?.aspectRatio ?? "portrait",
    contentMode: controls.renderControls?.contentMode ?? "sfw",
    negativeSpacePreference: controls.renderControls?.negativeSpacePreference,
    styleId: controls.lookStyleId ?? null,
    referenceImageUrl: controls.referenceImageUrl ?? null,
    resolvedRenderStyle,
  };

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
    lookClass,
    renderedSubject,
    generationMode,
    previewName: renderedSubject.name,
    previewPronouns: renderedSubject.pronouns,
  };
}
