/**
 * Fact-enrichment service — turns a submitted fact into structured visual
 * taxonomy metadata via OpenAI, validates it against the shared schema, and
 * persists it to the pending review for admin approval.
 *
 * This is durable classification metadata, NOT an image prompt. The image/video
 * prompt generator (a later phase) will consume the stored taxonomy.
 *
 * Uses JSON mode + app-side validation (the pattern every other OpenAI call in
 * this server uses through the Replit proxy) rather than Structured Outputs.
 * Invalid output triggers one corrective retry before the enrichment is marked
 * failed — submission is never blocked.
 */

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { pendingReviewsTable } from "@workspace/db/schema";
import {
  validateEnrichment,
  TAXONOMY_VERSION,
  CLASSIFICATION_PROMPT_VERSION,
  type FactEnrichment,
  type PrimaryArchetype,
  type FactSubtype,
  type OverhypeFit,
  type AdultSuitability,
} from "@workspace/api-zod";
import {
  getFactEnrichmentSystem,
  FACT_ENRICHMENT_TEMPERATURE,
  FACT_ENRICHMENT_MAX_TOKENS,
} from "./factEnrichmentConfig";
import { callUtilityLLM } from "./utilityLLM";
import { logger } from "./logger";

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
    "Fact text:",
    input.factText,
    "",
    "Fact status:",
    statusLabel,
    "",
    "Optional parent fact text:",
    parent,
    "",
    "Notes:",
    "- The fact may include a user name, pronoun tokens, or a sample rendered name.",
    "- Classify the joke mechanism of the fact itself.",
    "- If this is a variant, classify it independently. Do not assume it has the same taxonomy as the parent.",
    "- If the fact includes hashtags or brand/company names, detect them as context, but do not let them override the core archetype.",
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

function stampProvenance(enrichment: FactEnrichment): FactEnrichment {
  return {
    ...enrichment,
    taxonomyVersion: TAXONOMY_VERSION,
    classificationPromptVersion: CLASSIFICATION_PROMPT_VERSION,
    enrichedAt: new Date().toISOString(),
    enrichedBy: "openai",
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
  return stampProvenance(result.data);
}

async function callOpenAIEnrichment(userMessages: UserMessage[]): Promise<string> {
  const systemPrompt = await getFactEnrichmentSystem();
  const response = await callUtilityLLM({
    temperature: FACT_ENRICHMENT_TEMPERATURE,
    maxTokens: FACT_ENRICHMENT_MAX_TOKENS,
    responseFormat: { type: "json_object" },
    messages: [{ role: "system", content: systemPrompt }, ...userMessages],
  });
  return response.choices[0]?.message?.content ?? "{}";
}

/** Classify a fact via OpenAI. Throws EnrichmentError on unrecoverable failure. */
export async function enrichFact(input: EnrichInput): Promise<FactEnrichment> {
  return enrichFactWithModel(input, callOpenAIEnrichment);
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
