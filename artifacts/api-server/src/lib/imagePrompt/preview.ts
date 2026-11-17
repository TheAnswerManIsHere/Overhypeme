/**
 * Pure assembly of a render-time image prompt for SYNC preview surfaces: the
 * admin "Runtime Compiled Prompt" preview (`POST /admin/image-prompt/preview`)
 * and comparison preparation.
 *
 * It compiles ONE selected gag directly (plan PLAN_GAG_DIRECT_RENDER.md, D):
 * no model call, so the prompt it shows is the prompt a render of the same
 * gag, photo, look, controls and wording sends. It never touches the database
 * or persists an attempt; persistence stays in the caller that needs it.
 */
import type { ResolvedRecipe } from "./recipe";
import type { ResolvedRenderStyleSnapshot } from "./styleResolution";
import type { RenderControls, SubjectRenderMode, GenerationMode, VisualPromptStrategyOverride } from "@workspace/api-zod";
import { compileDirect, type DirectCompileArgs } from "./compilers/nanoBanana2";
import { directGagInput } from "./directInput";
import type { CompiledImagePrompt } from "./types";
import { generationModeFromSubjectRenderMode } from "../sourceImageAnalysis";

/**
 * Canonical test identity shared by EVERY sync preview/test surface — the
 * Phase-2C admin "Runtime Compiled Prompt Preview" (`adminImagePrompt`); the
 * t2i/i2i engine workbench that shared it went with the Engines page on
 * 2026-11-14. It renders fact templates ({NAME}/{SUBJ}/…) down to this single
 * brand protagonist.
 */
export const RUNTIME_PREVIEW_DEFAULT_NAME = "David Franklin";
export const RUNTIME_PREVIEW_DEFAULT_PRONOUNS = "he/him";

/** RenderControls plus the route-attached style/reference fields. */
export type RenderControlsWithRefs = RenderControls & {
  styleId?: string | null;
  referenceImageUrl?: string | null;
  /** The look, resolved once and frozen (`styleResolution.ts`); the engine and the RENDER STYLE are read from it. */
  resolvedRenderStyle?: ResolvedRenderStyleSnapshot;
};

export interface AssembleImagePromptArgs {
  /** The one selected gag's content: its scene, bubbles and cast. */
  gag: Pick<VisualPromptStrategyOverride, "coreSceneOverride" | "bubbles" | "cast" | "castExtraction"> | null | undefined;
  subjectRenderMode: SubjectRenderMode;
  renderControls: RenderControlsWithRefs;
  stylePrompt: string;
  referenceImageUrl?: string | null;
  /** Identity the gag's tokens render with. */
  renderedSubject: { name: string; pronouns: string | null };
  /** The prompt recipe to compile with (the prompt tuner); omitted means the baseline. */
  recipe?: ResolvedRecipe;
}

export interface AssembleImagePromptResult {
  /** What was compiled, without the recipe: a comparison freezes it so each cell compiles it with its own wording. */
  args: Omit<DirectCompileArgs, "recipe">;
  compiled: CompiledImagePrompt;
  generationMode: GenerationMode;
}

/** Throws `DirectGagInputError` when the gag cannot be drawn as it stands. */
export function assembleImagePromptForPreview(args: AssembleImagePromptArgs): AssembleImagePromptResult {
  const direct: Omit<DirectCompileArgs, "recipe"> = {
    ...directGagInput(args.gag),
    subjectRenderMode: args.subjectRenderMode,
    stylePrompt: args.stylePrompt,
    renderControls: args.renderControls,
    referenceImageUrl: args.referenceImageUrl ?? null,
    renderedSubject: args.renderedSubject,
  };
  const compiled = compileDirect({ ...direct, ...(args.recipe ? { recipe: args.recipe } : {}) });
  return { args: direct, compiled, generationMode: generationModeFromSubjectRenderMode(args.subjectRenderMode) };
}
