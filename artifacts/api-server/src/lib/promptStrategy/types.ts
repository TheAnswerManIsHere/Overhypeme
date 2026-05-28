/**
 * Prompt-strategy module types — the shared seed that the Phase 2 render-time
 * image-prompt generator will import alongside Phase 2A's visual-preview
 * generator. Keep these stable; render-time will extend `PromptStrategyInput`
 * with additional fields (userImageRef, selected style, aspect ratio, render
 * policy, engine, etc.) when it's built.
 */

import type {
  FactEnrichment,
  PrimaryArchetype,
  FactSubtype,
} from "@workspace/api-zod";

/** One per-archetype entry: the strategy authored by the product team. */
export interface ArchetypeStrategyEntry {
  archetype: PrimaryArchetype;
  /** Top-level strategy text for the archetype (how to visualize this category). */
  strategy: string;
  /** Candidate compositional frames the generator can select from. */
  frames: Array<{ id: string; description: string }>;
  /** Per-subtype refinements (only the subtypes that need extra guidance). */
  subtypeGuidance: Partial<Record<FactSubtype, string>>;
  /** Worked examples — fact → scene idea — to anchor the model. */
  visualizationExamples: Array<{ factExample: string; sceneIdea: string }>;
}

/** Input shape for any prompt-strategy generator (preview today, render later). */
export interface PromptStrategyInput {
  factText: string;
  enrichment: FactEnrichment;
  /**
   * The label rendered in example prompts. Default "David" (canonical brand
   * example). The guardrail resolves whether to use the literal name vs the
   * generic "the named subject" label in the prompt body.
   */
  sampleName?: string;
}

/**
 * Resolved guardrail context for a single preview/render call. Centralized so
 * Phase 2 render-time inherits identical subject-label and supporting-text
 * policy rules.
 */
export interface GuardrailContext {
  /** Whether the example prompts may use the literal `sampleName` as the subject. */
  useLiteralSubjectName: boolean;
  /** The label to put in prompt text (literal name or "the named subject"). */
  subjectLabel: string;
  /** Allowed kinds of supporting text that may appear when joke-relevant. */
  allowedSupportingText: readonly string[];
  /** Forbidden kinds of readable text/visual marks. */
  forbiddenText: readonly string[];
}

/** Subset of `ArchetypeStrategyEntry` selected for a specific enrichment. */
export interface SelectedStrategy {
  archetype: PrimaryArchetype;
  strategy: string;
  subtypeGuidance: string;
  frame: { id: string; description: string };
  visualizationExamples: Array<{ factExample: string; sceneIdea: string }>;
}
