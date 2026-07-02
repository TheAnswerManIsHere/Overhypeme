/**
 * Pure assembly of a render-time image prompt for SYNC preview/test surfaces.
 *
 * Shared by the Phase-2C admin preview route (`POST /admin/image-prompt/preview`)
 * and the t2i/i2i engine workbench (`POST /admin/engines/:id/assemble-prompt`).
 * Builds the `ImagePromptGenerationInput`, calls the planner, and runs the
 * deterministic Nano Banana 2 compiler — and NOTHING else. It never touches the
 * database or persists an attempt; persistence stays in the caller that needs it
 * (the preview route's `persist` path), so merely assembling a test prompt has no
 * side effects.
 */
import type {
  FactEnrichment,
  IdentityPolicy,
  ImagePromptGenerationInput,
  RenderControls,
  SourceImageAnalysis,
  SubjectRenderMode,
  GenerationMode,
} from "@workspace/api-zod";
import { resolveRenderPolicy } from "@workspace/api-zod";
import { generateImagePromptPlan } from "./generator";
import { compileForSubjectRenderMode } from "./compilers/nanoBanana2";
import type { ImagePromptGenerationOutput, CompiledImagePrompt } from "./types";
import { generationModeFromSubjectRenderMode } from "../sourceImageAnalysis";

// Test seam: route the live (OpenAI-backed) generator through a swappable binding
// so tests can stub it without hitting OpenAI. The real Nano Banana compiler
// still runs on the stubbed plan.
type PlanGenerator = typeof generateImagePromptPlan;
let planGenerator: PlanGenerator = generateImagePromptPlan;
export function __setPlanGeneratorForTest(fn: PlanGenerator | null): void {
  planGenerator = fn ?? generateImagePromptPlan;
}

/**
 * Canonical test identity shared by EVERY sync preview/test surface — the
 * Phase-2C admin "Runtime Compiled Prompt Preview" (`adminImagePrompt`) AND the
 * t2i/i2i engine workbench (`adminEngines`). Both render fact templates
 * ({NAME}/{SUBJ}/…) down to this single brand protagonist before calling the
 * planner, so the two surfaces feed byte-identical input to the shared rendering
 * code. With this unified, the only remaining difference between the two
 * previews is the planner's own temperature (IMAGE_PROMPT_TEMPERATURE = 0.4) —
 * never a harness mismatch.
 */
export const RUNTIME_PREVIEW_DEFAULT_NAME = "David Franklin";
export const RUNTIME_PREVIEW_DEFAULT_PRONOUNS = "he/him";

/** RenderControls plus the route-attached style/reference fields. */
export type RenderControlsWithRefs = RenderControls & {
  styleId?: string | null;
  referenceImageUrl?: string | null;
};

export interface AssembleImagePromptArgs {
  /** Already token-resolved fact text — the generator never sees a {NAME} template. */
  renderedFactText: string;
  enrichment: FactEnrichment;
  sourceImageAnalysis: SourceImageAnalysis;
  subjectRenderMode: SubjectRenderMode;
  userSelectedSubjectRenderMode?: SubjectRenderMode | null;
  identityPolicy: IdentityPolicy;
  renderControls: RenderControlsWithRefs;
  stylePrompt: string;
  referenceImageUrl?: string | null;
  /** Identity used to resolve any residual token in the compiled prompt. */
  renderedSubject: { name: string; pronouns: string | null };
  requestId?: string;
}

export interface AssembleImagePromptResult {
  input: ImagePromptGenerationInput;
  output: ImagePromptGenerationOutput;
  compiled: CompiledImagePrompt;
  generationMode: GenerationMode;
}

export async function assembleImagePromptForPreview(
  args: AssembleImagePromptArgs,
): Promise<AssembleImagePromptResult> {
  const generationMode = generationModeFromSubjectRenderMode(args.subjectRenderMode);
  const input: ImagePromptGenerationInput = {
    factText: args.renderedFactText,
    enrichment: args.enrichment,
    sourceImageAnalysis: args.sourceImageAnalysis,
    subjectRenderMode: args.subjectRenderMode,
    userSelectedSubjectRenderMode: args.userSelectedSubjectRenderMode ?? null,
    identityPolicy: args.identityPolicy,
    renderControls: args.renderControls,
    // Effective render policy = Phase-1 default ← moderator override (Phase 2).
    renderPolicy: resolveRenderPolicy(args.enrichment),
    stylePrompt: args.stylePrompt,
    referenceImageUrl: args.referenceImageUrl ?? null,
    targetEngine: "nano_banana_2",
    requestId: args.requestId,
    // Token-renders moderator-authored override text (visual concept) before
    // the planner sees it — the planner never receives raw {NAME} tokens.
    renderedSubject: args.renderedSubject,
  };

  const output = await planGenerator(input);
  const compiled = compileForSubjectRenderMode({
    visualPlan: output.visualPlan,
    compiledPrompt: output.compiledPrompt,
    input,
    renderedSubject: args.renderedSubject,
  });
  // Surface which planner engine produced this plan (or that fallback fired)
  // in the preview diagnostics.
  if (output.plannerProvenance && compiled.diagnostics) {
    compiled.diagnostics.plannerProvenance = output.plannerProvenance;
  }

  return { input, output, compiled, generationMode };
}
