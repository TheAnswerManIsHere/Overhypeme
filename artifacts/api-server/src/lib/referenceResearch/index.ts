/**
 * Reference research service entrypoint.
 *
 * Orchestrates: cache lookup → OpenAI Responses call (with web_search_preview)
 * → validate → stamp provenance → cache write → return.
 *
 * Designed so the route handler doesn't touch OpenAI or the DB cache directly
 * — `researchCulturalReference(input, opts?)` is the single entrypoint, and
 * `researchCulturalReferenceWithModel(input, callModel, opts?)` is the
 * inject-the-caller variant for unit tests.
 */

import {
  validateReferenceResearchResult,
  computeCanAutoApplyToEmptyFields,
  type ReferenceResearchInput,
  type ReferenceResearchResult,
  type ReferenceResearchResultWire,
} from "@workspace/api-zod";
import { logger } from "../logger";
import { getReferenceResearchSystem } from "../referenceResearchConfig";
import {
  callReferenceResearchModel,
  ReferenceResearchOpenAIError,
} from "./openaiResponses";
import {
  computeReferenceResearchCacheKey,
  getCachedResearchResult,
  setCachedResearchResult,
} from "./cache";

export class ReferenceResearchError extends Error {
  constructor(message: string, public phase: "input" | "openai" | "validation" | "internal" = "internal") {
    super(message);
    this.name = "ReferenceResearchError";
  }
}

export interface ResearchOptions {
  /** Skip cache lookup AND overwrite any cached entry. */
  forceRefresh?: boolean;
}

export interface ResearchOutcome {
  result: ReferenceResearchResult;
  fromCache: boolean;
  cacheKey: string;
}

/** Live entrypoint used by the route. */
export async function researchCulturalReference(
  input: ReferenceResearchInput,
  opts: ResearchOptions = {},
): Promise<ResearchOutcome> {
  return researchCulturalReferenceWithModel(input, liveCallModel, opts);
}

/**
 * Inject-the-caller variant. Tests mock `callModel` to return a wire-shaped
 * JSON string without touching OpenAI.
 */
export async function researchCulturalReferenceWithModel(
  input: ReferenceResearchInput,
  callModel: (args: { systemPrompt: string; userMessage: string }) => Promise<string>,
  opts: ResearchOptions = {},
): Promise<ResearchOutcome> {
  validateInput(input);
  const cacheKey = computeReferenceResearchCacheKey(input);

  if (!opts.forceRefresh) {
    const cached = await getCachedResearchResult(cacheKey);
    if (cached) {
      return { result: cached, fromCache: true, cacheKey };
    }
  }

  const systemPrompt = await getReferenceResearchSystem();
  const userMessage = buildResearchUserMessage(input);

  let raw: string;
  try {
    raw = await callModel({ systemPrompt, userMessage });
  } catch (err) {
    if (err instanceof ReferenceResearchOpenAIError) {
      throw new ReferenceResearchError(err.message, "openai");
    }
    throw new ReferenceResearchError(err instanceof Error ? err.message : String(err), "openai");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReferenceResearchError(
      `OpenAI Responses returned non-JSON content: ${raw.slice(0, 200)}`,
      "validation",
    );
  }

  const validation = validateReferenceResearchResult(parsed, {
    referenceType: input.referenceType,
  });
  if (!validation.ok) {
    throw new ReferenceResearchError(validation.error, "validation");
  }

  const result = stampProvenance(validation.data, input.referenceType);

  await setCachedResearchResult(cacheKey, input, result);
  return { result, fromCache: false, cacheKey };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function validateInput(input: ReferenceResearchInput): void {
  if (!input.factText || !input.factText.trim()) {
    throw new ReferenceResearchError("factText is required", "input");
  }
  if (!input.sourcePhrase && !input.canonicalReference) {
    throw new ReferenceResearchError(
      "sourcePhrase or canonicalReference must be present",
      "input",
    );
  }
  if (!input.referenceType || !input.referenceType.trim()) {
    throw new ReferenceResearchError("referenceType is required", "input");
  }
}

function stampProvenance(
  wire: ReferenceResearchResultWire,
  referenceType: string,
): ReferenceResearchResult {
  return {
    ...wire,
    canAutoApplyToEmptyFields: computeCanAutoApplyToEmptyFields(wire, referenceType),
    researchedAt: new Date().toISOString(),
    researchedBy: "ai_reference_research",
  };
}

export function buildResearchUserMessage(input: ReferenceResearchInput): string {
  const lines = [
    "Research this cultural / insider reference and return the structured JSON object.",
    "",
    `factText: ${input.factText}`,
    `sourcePhrase: ${input.sourcePhrase}`,
    `referenceType: ${input.referenceType}`,
    `canonicalReference: ${input.canonicalReference}`,
    "",
    "Before writing the visual implication: identify how this fact TWISTS the reference (role reversal, inversion, subversion, or literalized pun) and who/what ends up in the surprising role. The visual implication must commit to that bent scene with the named subject as the protagonist, and must state the obvious misreading to avoid.",
  ];
  if (input.existingExplanation && input.existingExplanation.trim()) {
    lines.push("");
    lines.push("Existing admin/AI explanation (treat as prior context, not ground truth):");
    lines.push(input.existingExplanation.trim());
  }
  if (input.existingVisualImplication && input.existingVisualImplication.trim()) {
    lines.push("");
    lines.push("Existing visual implication (treat as prior context, not ground truth):");
    lines.push(input.existingVisualImplication.trim());
  }
  if (input.adminNotes && input.adminNotes.trim()) {
    lines.push("");
    lines.push("Admin notes (additional context):");
    lines.push(input.adminNotes.trim());
  }
  lines.push("");
  lines.push("If the canonical name suggests a public entity, use the web_search_preview tool to look it up. Cite source URLs. The visualImplication must capture the specific twist in this fact, not the reference's generic atmosphere. Return ONLY the JSON object.");
  return lines.join("\n");
}

async function liveCallModel(args: { systemPrompt: string; userMessage: string }): Promise<string> {
  return callReferenceResearchModel(args);
}

export {
  callReferenceResearchModel,
  computeReferenceResearchCacheKey,
};
