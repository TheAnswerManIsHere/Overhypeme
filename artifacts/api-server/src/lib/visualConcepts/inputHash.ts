/**
 * Deterministic input hash for candidate Visual concepts (Slice 2A).
 *
 * The stored candidate blob carries this hash so the SERVER can decide whether
 * the candidates are still current for the review (the FE never recomputes it).
 * A change to any render-affecting input — fact text, the render-affecting
 * enrichment projection, the concept prompt/config version, the authored-strategy
 * version, the system-prompt content, or the resolved engine id/model/effort —
 * flips the hash and stales the stored candidates. Timestamps and the generated
 * candidate text are deliberately EXCLUDED (generating new candidates for the
 * same inputs must not stale them).
 *
 * Reuses the render-scenario projection so "what stales candidates" tracks "what
 * stales renders". That projection includes the ENTIRE visualPromptStrategyOverride
 * — so saved bubble edits conservatively stale candidate ideas exactly as saved
 * core-scene edits do (deliberate, Option A of the bubble plan §E6). Candidate
 * PROMPT CONTEXT still excludes existing bubbles (CANDIDATE_CONTEXT_OPTS gate);
 * only the freshness hash is conservative.
 */

import { createHash } from "node:crypto";
import {
  VISUAL_CONCEPTS_PROMPT_VERSION,
  VISUAL_STRATEGY_VERSION,
  type FactEnrichment,
  type VisualConceptSource,
} from "@workspace/api-zod";
import { renderAffectingEnrichment, stableStringify } from "../factRenderScenarios";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface VisualConceptHashInputs {
  reviewId: number;
  candidateVersionId: number | null;
  source: VisualConceptSource;
  factText: string;
  enrichment: FactEnrichment;
  /** sha256 of the resolved `fact_visual_concepts_system` prompt content. */
  systemPromptHash: string;
  /** Resolved concept engine identity (from resolveVisualConceptsLLMSettings). */
  engineId: string;
  model: string | null;
  reasoningEffort: string | null;
}

export function buildVisualConceptInputHash(inputs: VisualConceptHashInputs): string {
  const canonical = {
    conceptPromptVersion: VISUAL_CONCEPTS_PROMPT_VERSION,
    archetypeStrategyVersion: VISUAL_STRATEGY_VERSION,
    reviewId: inputs.reviewId,
    candidateVersionId: inputs.candidateVersionId,
    source: inputs.source,
    factText: inputs.factText,
    enrichment: renderAffectingEnrichment(inputs.enrichment),
    systemPromptHash: inputs.systemPromptHash,
    engineId: inputs.engineId,
    model: inputs.model,
    reasoningEffort: inputs.reasoningEffort,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}
