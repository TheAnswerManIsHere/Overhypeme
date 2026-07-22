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
  normalizeLiteralBubbleText,
  normalizeRoleEntity,
  EMPTY_VISUAL_STRATEGY_OVERRIDE,
  BUBBLE_TYPE_VALUES,
  BUBBLE_TEXT_MAX_CHARS,
  BUBBLE_ENTITY_MAX_CHARS,
  MAX_BUBBLES,
  type VisualStrategyBubble,
  type VisualPromptStrategyOverride,
} from "./visualStrategyOverride";
import { detectBubbleDirectiveLanguage } from "./promptContentDetectors";

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
 * v2: concepts carry a REQUIRED structured `bubbles` array (speech/thought
 * proposals) + single-channel scene rules.
 */
export const VISUAL_CONCEPTS_PROMPT_VERSION = 2 as const;

// ─── Wire schema (LLM structured output) ─────────────────────────────────────

/**
 * Strict Structured Outputs: every property is REQUIRED on the wire — "no
 * bubble proposal" is `bubbles: []`, never a missing property. Caps/limits are
 * enforced in `validateCandidateConcepts` (strict schemas reject min/max), and
 * over-cap values are INVALID output (corrective retry), never truncated —
 * silently slicing a literal quote would corrupt it.
 */
export const candidateBubbleWireSchema = z.object({
  type: z.enum(BUBBLE_TYPE_VALUES),
  /** "subject" (literal) for the protagonist, or a plain role label. */
  entity: z.string(),
  /** The exact literal line the balloon letters. */
  text: z.string(),
});
export type CandidateBubbleWire = z.infer<typeof candidateBubbleWireSchema>;

export const candidateConceptWireSchema = z.object({
  /** Short, human-scannable label for the concept (shown on the card header). */
  title: z.string(),
  /** One-line rationale — why this staging + gag lands. Admin-facing only. */
  whyItWorks: z.string(),
  /** The "describe the picture" scene brief — becomes coreSceneOverride if picked. */
  sceneDescription: z.string(),
  /** Proposed speech/thought bubbles ([] is the normal no-bubble case). */
  bubbles: z.array(candidateBubbleWireSchema),
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
 *
 * v2 bubble contract — every violation here is a RETRYABLE whole-response
 * error (the corrective retry asks for a fixed payload; nothing is truncated
 * or silently dropped):
 *   - 0–4 bubbles per concept; non-empty entity + text; caps respected;
 *   - the entity must be the literal "subject" or a plain role label (never a
 *     {token});
 *   - single-channel: a concept that proposes bubbles must NOT also author a
 *     balloon in its sceneDescription (shape/tail language, or restating the
 *     bubble's literal text) — the structured array is the sole owner.
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
    if (c.bubbles.length > MAX_BUBBLES) {
      return { ok: false, error: `concept ${i + 1} proposes ${c.bubbles.length} bubbles; the maximum is ${MAX_BUBBLES}` };
    }
    for (const [j, b] of c.bubbles.entries()) {
      const label = `concept ${i + 1} bubble ${j + 1}`;
      if (!b.entity.trim()) return { ok: false, error: `${label} has an empty entity` };
      if (!b.text.trim()) return { ok: false, error: `${label} has empty text` };
      if (b.entity.length > BUBBLE_ENTITY_MAX_CHARS) {
        return { ok: false, error: `${label} entity exceeds ${BUBBLE_ENTITY_MAX_CHARS} characters` };
      }
      if (b.text.trim().length > BUBBLE_TEXT_MAX_CHARS) {
        return {
          ok: false,
          error: `${label} text exceeds ${BUBBLE_TEXT_MAX_CHARS} characters — return a shorter EXACT line (a meaningful exact excerpt of the quote) or no bubble; never paraphrase or pad`,
        };
      }
    }
    if (c.bubbles.length > 0) {
      const balloonPhrase = detectBubbleDirectiveLanguage(c.sceneDescription);
      if (balloonPhrase) {
        return {
          ok: false,
          error: `concept ${i + 1} sceneDescription authors a balloon ("${balloonPhrase}") while structured bubbles are proposed — the bubbles array is the sole owner; the scene must only stage pose, expression, and headroom`,
        };
      }
      const scene = c.sceneDescription.toLowerCase();
      const restated = c.bubbles.find((b) => b.text.trim().length >= 8 && scene.includes(b.text.trim().toLowerCase()));
      if (restated) {
        return {
          ok: false,
          error: `concept ${i + 1} sceneDescription restates the bubble text "${restated.text.trim()}" — the literal string belongs ONLY in the bubbles array`,
        };
      }
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
  const probe = { ...EMPTY_VISUAL_STRATEGY_OVERRIDE, coreSceneOverride: text };
  const tokenError = firstOverrideTokenError(probe);
  return tokenError ? { text, tokenValid: false, tokenError } : { text, tokenValid: true };
}

// ─── Stored blob (facts.visual_concept_candidates) ───────────────────────────

export const storedCandidateBubbleSchema = z.object({
  type: z.enum(BUBBLE_TYPE_VALUES),
  /** Normalized entity ("subject" collapse is case/whitespace only — candidate
   *  generation has NO subject-name list, so a concrete personal name is
   *  stored as generated, never falsely collapsed). */
  entity: z.string(),
  /** Canonicalized + whitespace-normalized literal text — exactly what a pick
   *  writes into the VSO and what the card previews. */
  text: z.string(),
  tokenValid: z.boolean(),
  tokenError: z.string().optional(),
});
export type StoredCandidateBubble = z.infer<typeof storedCandidateBubbleSchema>;

export const storedCandidateConceptSchema = z.object({
  title: z.string(),
  whyItWorks: z.string(),
  sceneDescription: z.string(),
  tokenValid: z.boolean(),
  tokenError: z.string().optional(),
  /** Default [] so v1 blobs (no bubbles) parse as zero bubbles — they read as
   *  STALE via the prompt-version check, never as malformed. */
  bubbles: z.array(storedCandidateBubbleSchema).default([]),
});
export type StoredCandidateConcept = z.infer<typeof storedCandidateConceptSchema>;

/**
 * Sanitize one proposed bubble: canonicalize name tokens, normalize the
 * literal whitespace (the stored text IS what a pick applies and what the
 * card shows), normalize the entity WITHOUT a name list ("subject" collapse
 * only), and token-validate both fields with the exact rules the VSO save
 * superRefine applies. Nothing is truncated — over-cap values were already
 * rejected as retryable contract errors before sanitize.
 */
export function sanitizeCandidateBubble(b: CandidateBubbleWire): StoredCandidateBubble {
  const entityNorm = normalizeRoleEntity(canonicalizeNameToken(b.entity).trim());
  const text = normalizeLiteralBubbleText(canonicalizeNameToken(b.text));
  let tokenError = entityNorm.error ? `bubble entity: ${entityNorm.error}` : undefined;
  if (!tokenError && text.includes("{")) {
    const probe = {
      ...EMPTY_VISUAL_STRATEGY_OVERRIDE,
      bubbles: [{ type: b.type, entity: "subject", text }] as VisualStrategyBubble[],
    };
    const err = firstOverrideTokenError(probe);
    if (err) tokenError = `bubble text: ${err}`;
  }
  return {
    type: b.type,
    entity: entityNorm.value,
    text,
    tokenValid: !tokenError,
    ...(tokenError ? { tokenError } : {}),
  };
}

/** Sanitize one wire concept into its stored, token-validated form. */
export function sanitizeCandidateConcept(c: CandidateConceptWire): StoredCandidateConcept {
  const scene = sanitizeCandidateSceneText(c.sceneDescription);
  return {
    title: c.title.trim().slice(0, 200),
    whyItWorks: c.whyItWorks.trim().slice(0, 600),
    sceneDescription: scene.text,
    tokenValid: scene.tokenValid,
    ...(scene.tokenError ? { tokenError: scene.tokenError } : {}),
    bubbles: (c.bubbles ?? []).map(sanitizeCandidateBubble),
  };
}

/**
 * Concept-level ATOMIC pickability: the scene AND every proposed bubble must
 * be valid — "Use as draft" applies the complete displayed concept or nothing
 * (a concept's gag may depend on its bubble; a partial apply would be a
 * materially different concept). Shared by the card UI and the pick helper.
 */
export function isCandidateConceptPickable(c: StoredCandidateConcept): boolean {
  return c.tokenValid && (c.bubbles ?? []).every((b) => b.tokenValid);
}

/**
 * THE pure candidate → VSO draft mutation, used by BOTH the frontend pick
 * ("Use as draft") and the server's generation-time saveability preflight, so
 * "what pick applies" and "what was validated" are the same object by
 * construction:
 *   - preserves every unrelated VSO field of `existing`;
 *   - REPLACES `coreSceneOverride` and `bubbles` (a concept is a coherent
 *     unit — bubble arrays are never merged);
 *   - auto-enables the override;
 *   - callers gate on `isCandidateConceptPickable` first (this helper does not
 *     partially apply — it maps ALL of the candidate's bubbles).
 * Provenance (updatedBy/updatedAt) stays server-owned via the normal save.
 */
export function withCandidateConceptDraft(
  existing: VisualPromptStrategyOverride | undefined,
  candidate: StoredCandidateConcept,
): VisualPromptStrategyOverride {
  const base = existing ?? EMPTY_VISUAL_STRATEGY_OVERRIDE;
  // Presence-based: a pick sets only the scene + bubbles; those apply because they
  // are non-empty, and any pre-existing advanced fields keep applying independently.
  // No `enabled` flip (the toggle is gone), so a pick can never resurrect dormant
  // fields — there is no shared gate to flip.
  return {
    ...base,
    coreSceneOverride: candidate.sceneDescription,
    bubbles: (candidate.bubbles ?? []).map(({ type, entity, text }) => ({ type, entity, text })),
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
