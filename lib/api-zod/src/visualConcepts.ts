/**
 * Slice 2A — candidate Visual concepts.
 *
 * During moderation prep the frontier planner auto-drafts THREE distinct
 * "describe the picture" concepts. The moderator picks / edits / ignores one; a
 * pick becomes `enrichment.visualPromptStrategyOverride.coreSceneOverride`
 * (the Slice-1 "Visual concept" field) — no new write surface.
 *
 * This module owns:
 *   - the WIRE schema the LLM returns (loose arrays; strict OpenAI structured
 *     outputs reject minItems/maxItems, so the exactly-3 rule lives in the
 *     business validator, mirroring imagePromptGeneration.ts).
 *   - `sanitizeCandidateSceneText` — canonicalize name tokens + token-validate a
 *     candidate scene at STORE time (reusing the SAME rules the
 *     `coreSceneOverride` save-time superRefine applies) so a picked candidate
 *     can never fail that save, and cap it to the coreSceneOverride budget.
 *   - the STORED blob shape persisted on `facts.visual_concept_candidates`
 *     (candidates + provenance + reviewId / candidateVersionId / source /
 *     inputHash) and the normalized `visualConcepts` response the review-detail
 *     endpoint returns (with a SERVER-computed `current` flag — the FE never
 *     recomputes hashes).
 *
 * Dependency-light on purpose (only visualStrategyOverride leaves) so it can be
 * embedded without an import cycle.
 */

import { z } from "zod";
import {
  canonicalizeNameToken,
  firstOverrideTokenError,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
} from "./visualStrategyOverride";

/** Exactly three candidates per generation. */
export const CANDIDATE_VISUAL_CONCEPT_COUNT = 3;

/**
 * Max chars for a candidate scene. Must equal the `coreSceneOverride` cap
 * (visualStrategyOverride.ts) so a picked candidate always fits the field.
 */
export const CANDIDATE_SCENE_MAX_CHARS = 1500;

/**
 * Version of the candidate-concept prompt/config CONTRACT (not the admin-editable
 * system prompt text — that is hashed separately). Bump when the wire shape,
 * sanitize rules, or the fixed context selection change so stored candidates
 * generated under an older contract read as stale.
 */
export const VISUAL_CONCEPTS_PROMPT_VERSION = 1 as const;

// ─── Wire schema (LLM structured output) ─────────────────────────────────────

export const candidateConceptWireSchema = z.object({
  /** Short, human-scannable label for the concept (shown on the card header). */
  title: z.string(),
  /** One-line rationale — why this staging + gag lands. Admin-facing only. */
  whyItWorks: z.string(),
  /** The "describe the picture" scene brief — becomes coreSceneOverride if picked. */
  sceneDescription: z.string(),
});
export type CandidateConceptWire = z.infer<typeof candidateConceptWireSchema>;

export const candidateConceptsWireSchema = z.object({
  concepts: z.array(candidateConceptWireSchema),
});
export type CandidateConceptsWire = z.infer<typeof candidateConceptsWireSchema>;

/**
 * Business validation: exactly three concepts, each with a non-empty title +
 * sceneDescription. (The wire schema stays loose so strict structured outputs
 * accept it; count/non-empty is enforced here, mirroring validateImagePromptPlan.)
 */
export function validateCandidateConcepts(
  parsed: unknown,
): { ok: true; data: CandidateConceptsWire } | { ok: false; error: string } {
  const res = candidateConceptsWireSchema.safeParse(parsed);
  if (!res.success) {
    return { ok: false, error: res.error.issues[0]?.message ?? "invalid candidate concepts payload" };
  }
  const { concepts } = res.data;
  if (concepts.length !== CANDIDATE_VISUAL_CONCEPT_COUNT) {
    return {
      ok: false,
      error: `expected exactly ${CANDIDATE_VISUAL_CONCEPT_COUNT} concepts, got ${concepts.length}`,
    };
  }
  for (const [i, c] of concepts.entries()) {
    if (!c.title.trim()) return { ok: false, error: `concept ${i + 1} has an empty title` };
    if (!c.sceneDescription.trim()) {
      return { ok: false, error: `concept ${i + 1} has an empty sceneDescription` };
    }
  }
  return { ok: true, data: res.data };
}

// ─── Sanitize + token-validate at store time ─────────────────────────────────

export interface SanitizedSceneText {
  /** Canonicalized (name-token variants normalized) + capped scene text. */
  text: string;
  /** True when the text carries no unknown personalization token. */
  tokenValid: boolean;
  /** Present only when tokenValid=false — the first invalid-token message. */
  tokenError?: string;
}

/**
 * Canonicalize name tokens, cap to the coreSceneOverride budget, and token-
 * validate a candidate scene using the EXACT rules the coreSceneOverride
 * save-time superRefine applies (canonicalize first, then run
 * firstOverrideTokenError). A candidate flagged `tokenValid:false` must not be
 * pickable into the field — it would otherwise fail the save superRefine.
 */
export function sanitizeCandidateSceneText(rawScene: string): SanitizedSceneText {
  const text = canonicalizeNameToken(rawScene).trim().slice(0, CANDIDATE_SCENE_MAX_CHARS);
  const probe = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, enabled: true, coreSceneOverride: text };
  const tokenError = firstOverrideTokenError(probe);
  return tokenError ? { text, tokenValid: false, tokenError } : { text, tokenValid: true };
}

// ─── Stored blob (facts.visual_concept_candidates) ───────────────────────────

export const storedCandidateConceptSchema = z.object({
  title: z.string(),
  whyItWorks: z.string(),
  sceneDescription: z.string(),
  tokenValid: z.boolean(),
  tokenError: z.string().optional(),
});
export type StoredCandidateConcept = z.infer<typeof storedCandidateConceptSchema>;

/** Sanitize one wire concept into its stored, token-validated form. */
export function sanitizeCandidateConcept(c: CandidateConceptWire): StoredCandidateConcept {
  const scene = sanitizeCandidateSceneText(c.sceneDescription);
  return {
    title: c.title.trim().slice(0, 200),
    whyItWorks: c.whyItWorks.trim().slice(0, 600),
    sceneDescription: scene.text,
    tokenValid: scene.tokenValid,
    ...(scene.tokenError ? { tokenError: scene.tokenError } : {}),
  };
}

export const visualConceptProvenanceSchema = z.object({
  engineId: z.string(),
  model: z.string().nullable(),
  reasoningEffort: z.string().nullable(),
  timeoutMs: z.number(),
  /** VISUAL_CONCEPTS_PROMPT_VERSION at generation time. */
  promptVersion: z.number(),
  /** Set when the engine resolver fell back to the default utility LLM. */
  fallbackReason: z.string().nullable().optional(),
});
export type VisualConceptProvenance = z.infer<typeof visualConceptProvenanceSchema>;

export const VISUAL_CONCEPT_SOURCE_VALUES = ["staging_fact", "candidate_version"] as const;
export type VisualConceptSource = (typeof VISUAL_CONCEPT_SOURCE_VALUES)[number];

export const visualConceptCandidatesBlobSchema = z.object({
  candidates: z.array(storedCandidateConceptSchema),
  generatedAt: z.string(),
  provenance: visualConceptProvenanceSchema,
  /** The review cycle these candidates were drafted for. */
  reviewId: z.number(),
  /** The candidate enrichment version (refresh cycles) or null (first-time). */
  candidateVersionId: z.number().nullable(),
  source: z.enum(VISUAL_CONCEPT_SOURCE_VALUES),
  /** Hash over the render-affecting inputs — see buildVisualConceptInputHash. */
  inputHash: z.string(),
});
export type VisualConceptCandidatesBlob = z.infer<typeof visualConceptCandidatesBlobSchema>;

// ─── Normalized review-detail response (server-computed `current`) ───────────

export type VisualConceptStatus = "pending" | "ok" | "failed";

export type VisualConceptStaleReason =
  | "review_mismatch"
  | "candidate_version_mismatch"
  | "input_hash_mismatch";

export interface VisualConceptsResponse {
  /** Null = concept gen never ran for this fact (pre-feature / not enqueued). */
  status: VisualConceptStatus | null;
  candidates: StoredCandidateConcept[];
  /** Server-computed: do the stored candidates match the review's current state? */
  current: boolean;
  staleReason?: VisualConceptStaleReason;
  generatedAt?: string;
}
