/**
 * Fact-enrichment service — turns a submitted fact into structured visual
 * taxonomy metadata (incl. cultural references) via OpenAI, validates it
 * against the shared schema, and persists it to the pending review for admin
 * approval.
 *
 * This is durable classification metadata, NOT an image prompt. The Phase 2A
 * visual-preview generator + the Phase 2 render-time generator will consume
 * the stored taxonomy + cultural references.
 *
 * Uses **OpenAI Structured Outputs** (`response_format: json_schema`) backed
 * by `factEnrichmentWireSchema` so the model is forced to emit the full shape
 * (including `culturalReferences`). The parsed result is then run through our
 * `validateEnrichment` for business-rule validation (subtype ∈ archetype,
 * hashtag normalization). One corrective retry on validation failure before
 * the enrichment is marked failed — submission is never blocked.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod";
import { db } from "@workspace/db";
import { pendingReviewsTable } from "@workspace/db/schema";
import {
  factEnrichmentWireSchema,
  validateEnrichment,
  resolveEnrichment,
  TAXONOMY_VERSION,
  CLASSIFICATION_PROMPT_VERSION,
  type FactEnrichment,
  type PrimaryArchetype,
  type FactSubtype,
  type OverhypeFit,
  type AdultSuitability,
  type ClassificationPromptDiagnostics,
  type EnrichmentOverrides,
  type OverrideSummary,
} from "@workspace/api-zod";
import {
  resolveFactEnrichmentSystemPrompt,
  FACT_ENRICHMENT_TEMPERATURE,
  FACT_ENRICHMENT_MAX_TOKENS,
} from "./factEnrichmentConfig";
import { callUtilityLLM } from "./utilityLLM";
import { logger } from "./logger";
import { stripSubjectNameSemanticEntities } from "./renderCanonical";

export class EnrichmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnrichmentError";
  }
}

export type EnrichmentFactStatus = "new_fact" | "variant";

export interface EnrichInput {
  /** The fact (template) text to classify. */
  factText: string;
  /** Whether this is a brand-new fact or a variant of an existing one. */
  status: EnrichmentFactStatus;
  /** Parent fact text when status is "variant" (classified independently). */
  parentText?: string | null;
}

type UserMessage = { role: "user"; content: string };

// ─── Prompt assembly ────────────────────────────────────────────────────────

export function buildEnrichmentUserMessage(input: EnrichInput): string {
  const statusLabel = input.status === "variant" ? "variant" : "new_fact";
  const parent = input.parentText?.trim() ? input.parentText.trim() : "";
  return [
    "Classify this submitted Overhype.me fact.",
    "",
    "Inspect the EXACT spelling and capitalization of factTextExact. Do NOT lowercase, title-case, or otherwise normalize the case before semantic interpretation — capitalization is meaningful (e.g. \"Earth\" vs \"earth\").",
    "",
    "factTextExact:",
    input.factText,
    "",
    "Fact status:",
    statusLabel,
    "",
    "Optional parent fact text:",
    parent,
    "",
    "Notes:",
    "- The fact text has been rendered to canonical plain English (identity tokens resolved).",
    "- Classify the joke mechanism of the fact itself.",
    "- If this is a variant, classify it independently. Do not assume it has the same taxonomy as the parent.",
    "- If the fact includes hashtags or brand/company names, detect them as context, but do not let them override the core archetype.",
    "- Identify capitalization-sensitive or ambiguity-sensitive terms whose visual interpretation matters and list them in semanticEntities. Do not list every noun — only terms where interpretation materially affects the visual prompt or is genuinely ambiguous.",
  ].join("\n");
}

function buildSubtypeCorrective(archetype: string, subtype: string): string {
  return `The previous response failed validation because subtype "${subtype}" is not valid for primaryArchetype "${archetype}". Reclassify the fact using only valid subtypes for that primary archetype. Return the full JSON object again.`;
}

function buildGenericCorrective(error: string): string {
  return `The previous response failed validation: ${error}. Return the full JSON object again with every required field, using only the allowed enum values, 3-8 lowercase alphanumeric hashtags, and taxonomyConfidence between 0 and 1.`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stampProvenance(
  enrichment: FactEnrichment,
  promptDiagnostics?: ClassificationPromptDiagnostics,
): FactEnrichment {
  return {
    ...enrichment,
    aiGenerationId: randomUUID(),
    taxonomyVersion: TAXONOMY_VERSION,
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    classificationPromptDiagnostics: promptDiagnostics,
    enrichedAt: new Date().toISOString(),
    enrichedBy: "openai",
  };
}

// ─── Redundant-mechanism repair guard ──────────────────────────────────────
//
// A deterministic safety net for the "thrown weapon, then its normal mechanism"
// pattern (e.g. "threw a grenade and killed 50 people, then it exploded"). The
// joke is a superhuman physical feat where the weapon's normal mechanism is
// redundant — NOT a temporal/causality inversion. Even with the v4 classifier
// guidance, a low-confidence model can still emit the wrong archetype, so we
// repair it here. Confidence-gated (< 0.5) so a confident temporal call is left
// alone, and skipped on explicit reverse-order phrasing (which IS temporal).

const THROW_VERB_RE = /\b(threw|throw|throws|throwing|hurled|hurls|tossed|tosses|launched|launches)\b/;
const PROJECTILE_RE = /\b(grenade|bomb|bullet|missile|rocket|dynamite|explosive|cannonball)\b/;
const MECHANISM_RE = /\b(exploded|explodes|detonated|detonates|fired|fires|went off|goes off|ignited|ignites)\b/;
const THEN_RE = /\bthen\b/;

const REDUNDANT_MECHANISM_REPAIR_NOTE =
  "Auto-repaired from low-confidence temporal_causality_inversion: thrown weapon pattern indicates a redundant normal mechanism, not temporal inversion.";
const REDUNDANT_MECHANISM_HIGH_CONFIDENCE_NOTE =
  "Redundant-mechanism pattern detected, but not auto-repaired because the temporal classification was high-confidence; review recommended.";

/**
 * Obvious reverse-order case: mechanism … then … throw (e.g. "the grenade
 * exploded, then David threw it") — far more likely a true temporal inversion,
 * so we explicitly exclude it from the redundant-mechanism detector.
 */
function isExplicitReverseOrderExplosionThenThrow(factText: string): boolean {
  const text = factText.toLowerCase();
  const mech = text.search(MECHANISM_RE);
  const then = text.search(THEN_RE);
  const thrown = text.search(THROW_VERB_RE);
  return mech !== -1 && then !== -1 && thrown !== -1 && mech < then && then < thrown;
}

function isThrownWeaponRedundantMechanismPattern(factText: string): boolean {
  if (isExplicitReverseOrderExplosionThenThrow(factText)) return false;
  const text = factText.toLowerCase();
  return (
    THROW_VERB_RE.test(text) &&
    PROJECTILE_RE.test(text) &&
    THEN_RE.test(text) &&
    MECHANISM_RE.test(text)
  );
}

function appendAdminReviewNote(existing: string | undefined, note: string): string {
  const trimmed = existing?.trim();
  return trimmed ? `${trimmed} ${note}` : note;
}

/**
 * Repair a low-confidence redundant-mechanism misclassification. Only the
 * joke-MECHANISM classification is touched — `overhypeFit`, `adultSuitability`,
 * and `adultSuitabilityNotes` are deliberately left as-is (the grenade fact may
 * still be correctly rejected / adult-incompatible for violence).
 */
export function repairRedundantMechanismMisclassification(
  factText: string,
  enrichment: FactEnrichment,
): FactEnrichment {
  const matchesPattern = isThrownWeaponRedundantMechanismPattern(factText);
  const isTemporal = enrichment.primaryArchetype === "temporal_causality_inversion";
  if (!matchesPattern || !isTemporal) return enrichment;

  // High-confidence temporal: don't override the model, but surface the
  // tension so a human can refine the detector / the model later.
  if (enrichment.taxonomyConfidence >= 0.5) {
    logger.warn(
      { factText, taxonomyConfidence: enrichment.taxonomyConfidence },
      "[factEnrichment] redundant-mechanism pattern matched a high-confidence temporal classification; not auto-repaired",
    );
    return {
      ...enrichment,
      adminReviewNotes: appendAdminReviewNote(
        enrichment.adminReviewNotes,
        REDUNDANT_MECHANISM_HIGH_CONFIDENCE_NOTE,
      ),
    };
  }

  return {
    ...enrichment,
    primaryArchetype: "superhuman_physical_feat",
    subtype: "force_scaled_action",
    modifiers: Array.from(
      new Set([
        ...enrichment.modifiers,
        "projectile_impact_power",
        "normal_function_rendered_unnecessary",
      ]),
    ),
    // Keep it flagged for review rather than presenting as confident.
    taxonomyConfidence: Math.min(enrichment.taxonomyConfidence, 0.49),
    adminReviewNotes: appendAdminReviewNote(
      enrichment.adminReviewNotes,
      REDUNDANT_MECHANISM_REPAIR_NOTE,
    ),
  };
}

// ─── Core orchestration (model call injected for testability) ───────────────

/**
 * Runs enrichment against an injected model caller: parse → validate → on
 * failure retry ONCE with a corrective message → throw EnrichmentError if still
 * invalid. The injected `callModel` receives the user messages and returns the
 * raw model text. Unit tests stub it with bad-then-good responses.
 */
export async function enrichFactWithModel(
  input: EnrichInput,
  callModel: (userMessages: UserMessage[]) => Promise<string>,
  options?: { promptDiagnostics?: ClassificationPromptDiagnostics },
): Promise<FactEnrichment> {
  const firstUser: UserMessage = { role: "user", content: buildEnrichmentUserMessage(input) };

  let raw = await callModel([firstUser]);
  let parsed = safeJsonParse(raw);
  let result = validateEnrichment(parsed);

  if (!result.ok) {
    const obj = (parsed ?? {}) as Record<string, unknown>;
    const archetype = typeof obj.primaryArchetype === "string" ? obj.primaryArchetype : "(unknown)";
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "(unknown)";
    const corrective = result.subtypeMismatch
      ? buildSubtypeCorrective(archetype, subtype)
      : buildGenericCorrective(result.error);
    raw = await callModel([firstUser, { role: "user", content: corrective }]);
    parsed = safeJsonParse(raw);
    result = validateEnrichment(parsed);
  }

  if (!result.ok) {
    throw new EnrichmentError(result.error);
  }

  // Deterministic repair (mutates archetype/subtype/modifiers) → re-validate so
  // a future taxonomy change can't let the repair silently emit an invalid blob.
  const repaired = repairRedundantMechanismMisclassification(input.factText, result.data);
  // Drop any semantic entity that is actually the personalized SUBJECT (the
  // canonical-rendered name "Alex" / a residual identity token). The subject is
  // owned by the identity/rendering layer and must never be a semantic entity —
  // otherwise it pollutes the visual prompt and the image-prompt validator
  // forces it to be echoed into the picture.
  const deSubjected = {
    ...repaired,
    semanticEntities: stripSubjectNameSemanticEntities(repaired.semanticEntities ?? []),
  };
  const revalidated = validateEnrichment(deSubjected);
  if (!revalidated.ok) {
    throw new EnrichmentError(`Repair produced invalid enrichment: ${revalidated.error}`);
  }
  return stampProvenance(revalidated.data, options?.promptDiagnostics);
}

/** Classify a fact via OpenAI. Throws EnrichmentError on unrecoverable failure. */
export async function enrichFact(input: EnrichInput): Promise<FactEnrichment> {
  // Resolve the EFFECTIVE system prompt (code default vs admin-config vs debug
  // override) so we both use it AND stamp its provenance onto the result.
  const resolution = await resolveFactEnrichmentSystemPrompt();

  const callModel = async (userMessages: UserMessage[]): Promise<string> => {
    const response = await callUtilityLLM({
      temperature: FACT_ENRICHMENT_TEMPERATURE,
      maxTokens: FACT_ENRICHMENT_MAX_TOKENS,
      responseFormat: zodResponseFormat(factEnrichmentWireSchema, "fact_enrichment"),
      messages: [{ role: "system", content: resolution.prompt }, ...userMessages],
    });
    return response.choices[0]?.message?.content ?? "{}";
  };

  return enrichFactWithModel(input, callModel, {
    promptDiagnostics: {
      source: resolution.source,
      hash: resolution.hash,
      length: resolution.length,
      codeDefaultHash: resolution.codeDefaultHash,
      matchesCodeDefault: resolution.matchesCodeDefault,
    },
  });
}

// ─── Persistence helpers ────────────────────────────────────────────────────

/** Promoted, indexed projections of the enrichment blob for the facts table. */
export function buildFactEnrichmentColumns(enrichment: FactEnrichment): {
  enrichment: FactEnrichment;
  primaryArchetype: PrimaryArchetype;
  subtype: FactSubtype;
  overhypeFit: OverhypeFit;
  adultSuitability: AdultSuitability;
} {
  return {
    enrichment,
    primaryArchetype: enrichment.primaryArchetype,
    subtype: enrichment.subtype,
    overhypeFit: enrichment.overhypeFit,
    adultSuitability: enrichment.adultSuitability,
  };
}

/** The exact `facts` columns produced by materializing effective enrichment. */
export interface MaterializedEnrichmentColumns {
  enrichment: FactEnrichment;
  enrichmentAiDerived: FactEnrichment;
  enrichmentOverrides: EnrichmentOverrides;
  enrichmentBaselineChanged: boolean;
  primaryArchetype: PrimaryArchetype;
  subtype: FactSubtype;
  overhypeFit: OverhypeFit;
  adultSuitability: AdultSuitability;
}

export interface MaterializeResult {
  /** Spread directly into a `facts` update/insert `.set(...)`. */
  columns: MaterializedEnrichmentColumns;
  effective: FactEnrichment;
  summary: OverrideSummary;
}

/**
 * THE single write-shape for fact enrichment. Assembles the materialized
 * effective blob from the immutable AI baseline + manual overrides + the
 * preserved (not-refactored) visual-strategy override, and returns the exact
 * `facts` columns to persist (effective + the three layer columns + the indexed
 * projections). Every write site (PUT/DELETE overrides, PATCH notes/visual,
 * re-enrich, projection repair) funnels through here so preserved fields are
 * never lost and projection columns never drift.
 */
export function materializeEnrichment(input: {
  aiDerived: FactEnrichment;
  overrides: EnrichmentOverrides;
  visualPromptStrategyOverride?: FactEnrichment["visualPromptStrategyOverride"];
}): MaterializeResult {
  const { effective, summary } = resolveEnrichment(input);
  const projected = buildFactEnrichmentColumns(effective);
  return {
    columns: {
      enrichment: effective,
      enrichmentAiDerived: input.aiDerived,
      enrichmentOverrides: input.overrides,
      enrichmentBaselineChanged: summary.baselineChangedPaths.length > 0,
      primaryArchetype: projected.primaryArchetype,
      subtype: projected.subtype,
      overhypeFit: projected.overhypeFit,
      adultSuitability: projected.adultSuitability,
    },
    effective,
    summary,
  };
}

/**
 * Materialize the facts columns for a freshly-AI-derived blob that has no manual
 * overrides yet (review approval, backfill, first write). Splits the preserved
 * moderator visual-strategy override out of the baseline so
 * `enrichment_ai_derived` stays pure AI.
 */
export function materializeFromBaseline(enrichment: FactEnrichment): MaterializeResult {
  const visualPromptStrategyOverride = enrichment.visualPromptStrategyOverride;
  const aiDerived = { ...enrichment } as FactEnrichment;
  delete (aiDerived as Record<string, unknown>)["visualPromptStrategyOverride"];
  return materializeEnrichment({ aiDerived, overrides: {}, visualPromptStrategyOverride });
}

/**
 * Fire-and-forget: enrich a pending review and store the result. Never throws —
 * on failure it records `enrichmentStatus = "failed"` so the admin UI can
 * surface a manual-review state. Submission flow does not await success.
 */
export async function enrichAndStorePendingReview(
  reviewId: number,
  input: EnrichInput,
): Promise<void> {
  try {
    const enrichment = await enrichFact(input);
    await db
      .update(pendingReviewsTable)
      .set({ enrichment, enrichmentStatus: "ok" })
      .where(eq(pendingReviewsTable.id, reviewId));
  } catch (err) {
    logger.error({ err, reviewId }, "[factEnrichment] enrichment failed for review");
    await db
      .update(pendingReviewsTable)
      .set({ enrichmentStatus: "failed" })
      .where(eq(pendingReviewsTable.id, reviewId));
  }
}
