/**
 * ProcessingSignature — the small, durable fingerprint of the pipeline a fact's
 * ACTIVE enrichment was last generated under. Stamped onto
 * `facts.last_processed_signature` at first-time approval and at refresh
 * promotion; a fact whose stored signature differs from the current one (any
 * component) — or is absent — reads "stale for reprocess" in Taxonomy Health.
 *
 * Two halves, per the locked design:
 *  - `engineRevision` — a MANUAL admin-bumped integer ("Mark major update").
 *    Engine/model IDs and config toggles are deliberately NOT in the signature
 *    (a debug toggle flipping `debug_mode_active` must never flip staleness);
 *    an LLM/engine swap is registered by bumping this instead.
 *  - Four code-version constants — captured automatically, so a deploy that
 *    changes any of them makes the corpus read stale without a manual bump.
 *
 * This module is PURE (api-zod has no DB access): `currentProcessingSignature`
 * takes the engine revision as an argument. The api-server wrapper
 * (`lib/processingSignature.ts`) reads `engine_revision` from admin_config and
 * calls this.
 */

import { CLASSIFICATION_PROMPT_VERSION, TAXONOMY_VERSION } from "./taxonomy";
import { IMAGE_PROMPT_GENERATION_VERSION } from "./imagePromptGeneration";
import { VISUAL_STRATEGY_VERSION } from "./visualPromptStrategies";
import { z } from "zod";

export interface ProcessingSignature {
  /** Manual admin-bumped marker (admin_config `engine_revision`). */
  engineRevision: number;
  taxonomyVersion: string;
  classificationVersion: string;
  imagePromptGenerationVersion: string;
  visualStrategyVersion: string;
}

/** Validates a stored `last_processed_signature` / candidate `signature` blob. */
export const processingSignatureSchema = z.object({
  engineRevision: z.number().int(),
  taxonomyVersion: z.string(),
  classificationVersion: z.string(),
  imagePromptGenerationVersion: z.string(),
  visualStrategyVersion: z.string(),
});

/**
 * The signature the live pipeline currently produces, for a given engine
 * revision. The four version fields are compile-time constants; `engineRevision`
 * is the runtime admin_config value the caller supplies.
 */
export function currentProcessingSignature(engineRevision: number): ProcessingSignature {
  return {
    engineRevision,
    taxonomyVersion: TAXONOMY_VERSION,
    classificationVersion: CLASSIFICATION_PROMPT_VERSION,
    imagePromptGenerationVersion: IMAGE_PROMPT_GENERATION_VERSION,
    visualStrategyVersion: VISUAL_STRATEGY_VERSION,
  };
}

export type ProcessingSignatureStalenessReason =
  | "never_processed"
  | "engine_revision"
  | "code_version";

export interface ProcessingSignatureStaleness {
  stale: boolean;
  /** Why it is stale (null when fresh). `engine_revision` takes precedence over `code_version`. */
  reason: ProcessingSignatureStalenessReason | null;
}

/**
 * Compare a stored signature blob against the current one. Stale when: the blob
 * is absent/invalid (`never_processed`), the engine revision differs
 * (`engine_revision`), or any code-version field differs (`code_version`).
 * Mirrors the null-or-differs semantics of `computeEnrichmentVersionStatus`.
 */
export function computeProcessingSignatureStaleness(
  stored: unknown,
  current: ProcessingSignature,
): ProcessingSignatureStaleness {
  const parsed = processingSignatureSchema.safeParse(stored);
  if (!parsed.success) return { stale: true, reason: "never_processed" };
  const s = parsed.data;
  if (s.engineRevision !== current.engineRevision) return { stale: true, reason: "engine_revision" };
  if (
    s.taxonomyVersion !== current.taxonomyVersion ||
    s.classificationVersion !== current.classificationVersion ||
    s.imagePromptGenerationVersion !== current.imagePromptGenerationVersion ||
    s.visualStrategyVersion !== current.visualStrategyVersion
  ) {
    return { stale: true, reason: "code_version" };
  }
  return { stale: false, reason: null };
}
