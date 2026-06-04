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

export type PromptSectionPriority = "required" | "high" | "medium";

/**
 * The fate of one assembled section in the final engine prompt:
 *   included  — folded into the prompt verbatim (after sentence de-dupe)
 *   compressed — trimmed to fit the engine char budget
 *   dropped    — over budget, left out entirely
 *   deduped    — every sentence was already present earlier, so nothing new added
 *   empty      — the section produced no text for this render
 */
export type PromptSectionStatus = "included" | "compressed" | "dropped" | "deduped" | "empty";

/**
 * A single component the deterministic compiler combined into the final engine
 * prompt. Surfaced to admins so they can see exactly how the compiled prompt
 * was computed from its parts (mode preamble, taxonomy-derived directives, LLM
 * prose, composition, style, …) — not just the fully assembled blob.
 */
export interface PromptSection {
  /** Stable machine id (e.g. "visual_goal", "semantic_referents"). */
  id: string;
  /** Human-readable label for the debug UI. */
  label: string;
  priority: PromptSectionPriority;
  status: PromptSectionStatus;
  /** The text that actually landed in the prompt ("" when not included). */
  text: string;
  /** The full resolved section text before de-dupe/budget trimming. */
  rawText: string;
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
  /**
   * Per-component breakdown of how `prompt` was assembled. Debug-only metadata
   * (the engine reads `imagePrompt`); surfaced in the admin prompt preview.
   */
  promptBreakdown?: PromptSection[];
}

export type { ImagePromptGenerationInput, ImagePromptTargetEngine, GenerationMode };
