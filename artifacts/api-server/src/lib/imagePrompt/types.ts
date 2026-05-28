/**
 * Phase 2 — internal types for the render-time prompt generation service.
 */

import type {
  VisualPlan,
  CompiledPrompt,
  ImagePromptGenerationInput,
  ImagePromptTargetEngine,
  GenerationMode,
} from "@workspace/api-zod";

export interface ImagePromptGenerationOutput {
  visualPlan: VisualPlan;
  compiledPrompt: CompiledPrompt;
  promptVersion: string;            // IMAGE_PROMPT_GENERATION_VERSION
  archetypeStrategyVersion: string; // VISUAL_STRATEGY_VERSION
  generatedAt: string;              // ISO timestamp
  generatedBy: "openai";
}

export interface CompiledImagePrompt {
  /** Final prompt text passed to the image engine. */
  prompt: string;
  /** Optional negative prompt. Empty string is normalized to undefined. */
  negativePrompt?: string;
  /** Engine-specific freeform notes (not sent to fal). */
  engineNotes?: string;
  /** The exact `imagePrompt` value the engine's paramSchema expects. Mirrors `prompt`. */
  imagePrompt: string;
  /** Present only for i2i variants. Mirrors input.referenceImageUrl. */
  referenceImageUrl?: string;
}

export type { ImagePromptGenerationInput, ImagePromptTargetEngine, GenerationMode };
