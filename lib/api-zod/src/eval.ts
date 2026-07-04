/**
 * Eval harness (Slice 2B) — shared wire schemas + types.
 *
 * A render carries a moderator VERDICT: a 1–5 `rating` and an optional
 * `failureTag` attributing a bad render to the concept, the compiler, or the
 * image model. The two are INDEPENDENT (a failure-tag with no rating is valid
 * quick-triage). Attribution values:
 *   concept      — the idea / staging was wrong (bad Visual concept / enrichment).
 *   compiler     — the concept was good but the compiled prompt lost it.
 *   image_model  — the prompt was good but the model executed it badly.
 *   none         — rated, no single dominant failure (distinct from NULL = unreviewed).
 *
 * `evalWriteSchema` clear-semantics (documented so FE/tests don't drift):
 *   key OMITTED  → leave that column unchanged.
 *   key = null   → clear that column.
 *   notes = ""   → normalized to null.
 */

import { z } from "zod";

// ─── Failure attribution ─────────────────────────────────────────────────────

export const FAILURE_TAG_VALUES = ["concept", "compiler", "image_model", "none"] as const;
export type FailureTag = (typeof FAILURE_TAG_VALUES)[number];

// ─── Eval write (rating / failure-tag / notes on an attempt) ─────────────────

export const evalWriteSchema = z.object({
  rating: z.number().int().min(1).max(5).nullable().optional(),
  failureTag: z.enum(FAILURE_TAG_VALUES).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type EvalWrite = z.infer<typeof evalWriteSchema>;

/** The eval columns to UPDATE, honoring omitted (absent) vs null (clear). */
export interface EvalColumnUpdate {
  moderatorRating?: number | null;
  failureTag?: FailureTag | null;
  evalNotes?: string | null;
}

/**
 * Resolve an `evalWrite` into the columns to set. A key present as `undefined`
 * (omitted) is left out entirely → the UPDATE leaves it unchanged; an explicit
 * `null` clears it; empty/whitespace notes normalize to null. Returns `{}` when
 * nothing was provided (the caller should reject that as a no-op).
 */
export function resolveEvalColumns(write: EvalWrite): EvalColumnUpdate {
  const out: EvalColumnUpdate = {};
  if (write.rating !== undefined) out.moderatorRating = write.rating;
  if (write.failureTag !== undefined) out.failureTag = write.failureTag;
  if (write.notes !== undefined) out.evalNotes = write.notes && write.notes.trim() ? write.notes.trim() : null;
  return out;
}

export function evalColumnUpdateIsEmpty(update: EvalColumnUpdate): boolean {
  return Object.keys(update).length === 0;
}

// ─── Golden-set toggle ────────────────────────────────────────────────────────

export const evalGoldenWriteSchema = z.object({
  golden: z.boolean(),
  reason: z.string().max(500).nullable().optional(),
});
export type EvalGoldenWrite = z.infer<typeof evalGoldenWriteSchema>;

// ─── Eval run creation ────────────────────────────────────────────────────────

export const evalRunCreateSchema = z.object({
  label: z.string().max(120).nullable().optional(),
});
export type EvalRunCreate = z.infer<typeof evalRunCreateSchema>;

// ─── Shared signature / profile shapes (server computes; FE dashboard reads) ──

/** Broad pipeline profile captured ONCE per eval run. */
export interface EvalRunProfile {
  plannerEngineId: string | null;
  plannerModel: string | null;
  plannerReasoningEffort: string | null;
  imagePromptGenerationVersion: string;
  scenarioConfigVersion: string;
  archetypeStrategyVersion: string;
}

/**
 * Per-attempt signature — what varies row-to-row within a run (a run spans
 * multiple scenarios/engines, so one run ≠ one engine). Missing inputs bucket as
 * "unknown". Derived from the ACTUAL image engine, not the coarse targetEngine.
 */
export interface AttemptSignature {
  scenarioKey: string;
  subjectRenderMode: string;
  generationMode: string;
  actualImageEngineId: string;
  referenceIdentityType: string;
  referenceAssetVersion: string;
  lookStyleId: string;
  plannerModel: string;
  plannerReasoningEffort: string;
}

/** Stable string key for grouping attempts by signature in the dashboard. */
export function attemptSignatureKey(sig: AttemptSignature): string {
  return [
    sig.scenarioKey,
    sig.subjectRenderMode,
    sig.generationMode,
    sig.actualImageEngineId,
    sig.referenceIdentityType,
    sig.referenceAssetVersion,
    sig.lookStyleId,
    sig.plannerModel,
    sig.plannerReasoningEffort,
  ].join("|");
}
