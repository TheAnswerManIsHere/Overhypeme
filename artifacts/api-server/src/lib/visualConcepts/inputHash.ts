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
 * The classification fields it hashes are the writer's own list
 * (`writerAffectingEnrichment`): since the switch a render reads none of them
 * (plan PLAN_GAG_DIRECT_RENDER.md, D), so the two freshness checks no longer
 * share a projection. Saved bubble edits stale candidate ideas exactly as
 * saved core-scene edits do (deliberate, Option A of the bubble plan §E6). Since
 * migration 0139 a fact's gags live in fact_gags, not the enrichment, so the
 * hash carries them itself: every gag the request lists (prompt v4). The
 * approved humor note is kept out of this hash on purpose
 * (visualConceptJobs.ts, buildVisualConceptsResponse).
 */

import { createHash } from "node:crypto";
import {
  VISUAL_CONCEPTS_PROMPT_VERSION,
  VISUAL_STRATEGY_VERSION,
  isRetiredTextModifier,
  withoutCast,
  type FactEnrichment,
  type VisualConceptSource,
} from "@workspace/api-zod";
import { stableStringify } from "../factRenderScenarios";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A gag as the writer is shown it: its scene and bubbles, as stored (with tokens). */
export interface HashedContextGag {
  scene: string;
  bubbles: Array<{ type: string; entity: string; text: string }>;
}

export interface VisualConceptHashInputs {
  /** The review cycle; null for a live draft (Draft more gags). */
  reviewId: number | null;
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
  /**
   * Every gag the fact has, in slot order: the same frozen list the request
   * carries (plan PLAN_THREE_GAGS.md increment 2), so a change to any gag
   * stales the candidates, as a saved gag edit did when the gag lived in the
   * enrichment.
   */
  gags: HashedContextGag[];
}

/**
 * The classification fields the gag writer's request carries, and so the ones
 * whose edit marks its ideas out of date: the archetype and subtype (its
 * subtype guidance), the modifiers (retired text/logo modifiers left out, as
 * inert legacy data), literalness and complexity, cultural references and
 * semantic entities, and the fact's gag content (its derived cast left out:
 * the writer is shown scenes and bubbles). The fact character list is not
 * read by the writer (PLAN_BUBBLE_SPEAKERS.md, F) and stays out. This was the
 * render projection minus the character list until the switch; its values
 * are unchanged, so no stored idea goes out of date by the split.
 */
function writerAffectingEnrichment(e: FactEnrichment): Record<string, unknown> {
  const ov = e.visualPromptStrategyOverride ?? null;
  return {
    primaryArchetype: e.primaryArchetype,
    subtype: e.subtype,
    modifiers: e.modifiers.filter((m) => !isRetiredTextModifier(m)).sort(),
    visualLiteralness: e.visualLiteralness,
    visualComplexity: e.visualComplexity,
    culturalReferences: e.culturalReferences,
    semanticEntities: e.semanticEntities,
    visualPromptStrategyOverride: ov ? withoutCast(ov) : null,
  };
}

export function buildVisualConceptInputHash(inputs: VisualConceptHashInputs): string {
  const canonical = {
    conceptPromptVersion: VISUAL_CONCEPTS_PROMPT_VERSION,
    archetypeStrategyVersion: VISUAL_STRATEGY_VERSION,
    reviewId: inputs.reviewId,
    candidateVersionId: inputs.candidateVersionId,
    source: inputs.source,
    factText: inputs.factText,
    enrichment: writerAffectingEnrichment(inputs.enrichment),
    systemPromptHash: inputs.systemPromptHash,
    engineId: inputs.engineId,
    model: inputs.model,
    reasoningEffort: inputs.reasoningEffort,
    gags: inputs.gags.map((g) => ({
      scene: g.scene,
      bubbles: g.bubbles.map((b) => ({ type: b.type, entity: b.entity, text: b.text })),
    })),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}
