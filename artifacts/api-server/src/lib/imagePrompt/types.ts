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

/**
 * Which LLM engine actually planned a render attempt. Originates at the
 * generation layer (resolveImagePromptLLMSettings) so both successful plans
 * AND prompt-generation failures are attributable to the dedicated
 * visual-planner engine vs. the default-LLM fallback. Copied into
 * CompiledPromptDiagnostics on success; attached to ImagePromptError on
 * failure.
 */
export interface PlannerProvenance {
  configuredEngineId: string;
  resolvedEngineId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  timeoutMs: number;
  /** Null when the dedicated engine was used; otherwise why it fell back. */
  fallbackReason: string | null;
}

export interface ImagePromptGenerationOutput {
  visualPlan: VisualPlan;
  compiledPrompt: CompiledPrompt;
  promptVersion: string;            // IMAGE_PROMPT_GENERATION_VERSION
  archetypeStrategyVersion: string; // VISUAL_STRATEGY_VERSION
  generatedAt: string;              // ISO timestamp
  generatedBy: "openai";
  /** Set by generateImagePromptPlan (absent in callModel-injected test paths). */
  plannerProvenance?: PlannerProvenance;
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
  /** True when the section's content was authored by a human moderator
   *  (e.g. the visual-concept core scene) rather than the planner LLM. */
  moderatorAuthored?: boolean;
}

/**
 * Why a planner-prose sentence was stripped before assembly. Each category is
 * a class of clause the deterministic compiler OWNS (and emits itself), so the
 * LLM prose is not allowed to also author it and create a competing/duplicate
 * instruction in the final engine prompt.
 */
export type RemovedProseReason =
  | "identity-preservation-owned-by-compiler"
  | "reference-image-owned-by-compiler"
  | "token-interpretation-owned-by-compiler"
  | "text-policy-owned-by-compiler"
  | "empty-or-duplicate";

export interface RemovedProseSentence {
  sentence: string;
  reason: RemovedProseReason;
}

export interface PromptWarning {
  code: string;
  message: string;
  severity: "info" | "warning";
}

/**
 * Non-fatal compiler diagnostics surfaced in the admin prompt preview: which
 * planner-prose clauses the compiler stripped (and why), and any soft warnings
 * (e.g. a tone split between the visual approach and the prose). Debug-only;
 * does not affect the engine prompt.
 */
export interface CompiledPromptDiagnostics {
  removedPlannerProseSentences: RemovedProseSentence[];
  warnings: PromptWarning[];
  /** Which planner engine produced the visualPlan (copied from the
   *  generation output so it persists with the attempt + shows in preview). */
  plannerProvenance?: PlannerProvenance;
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
  /** Non-fatal compiler diagnostics (stripped prose clauses, tone warnings). */
  diagnostics?: CompiledPromptDiagnostics;
}

export type { ImagePromptGenerationInput, ImagePromptTargetEngine, GenerationMode };
