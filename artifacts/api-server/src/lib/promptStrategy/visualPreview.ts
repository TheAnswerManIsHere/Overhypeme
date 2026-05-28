/**
 * Visual prompt preview generator (Phase 2A).
 *
 * Produces an admin-visible TEXT preview of how Overhype.me intends to
 * visualize a classified fact. NOT an image, NOT a final render-time prompt.
 * Consumes the selected per-archetype strategy entry (the model must APPLY
 * the authored strategy, never infer from taxonomy alone) and serializes
 * cultural references so the model grounds the scene in the joke's outside
 * context.
 *
 * Structured Outputs: the model is constrained by `visualPreviewWireSchema`
 * via `response_format: { type: "json_schema", strict: true }`. The parsed
 * result is then run through `validateVisualPreview` for business-rule
 * validation (literal assumption values, length bounds, etc.). One corrective
 * retry on validation failure mirrors `factEnrichment.ts`.
 */

import { zodResponseFormat } from "openai/helpers/zod";
import {
  validateVisualPreview,
  visualPreviewWireSchema,
  PREVIEW_PROMPT_VERSION,
  type VisualPromptPreview,
} from "@workspace/api-zod";
import { callUtilityLLM } from "../utilityLLM";
import { getFactVisualPreviewSystem } from "../factVisualPreviewConfig";
import { logger } from "../logger";
import {
  buildGuardrailContext,
  defaultPromptGuardrailsPreview,
  guardrailSystemAddendum,
} from "./guardrails";
import { selectStrategyEntry, serializeStrategyForPrompt } from "./strategyMap";
import type { PromptStrategyInput } from "./types";

export class PreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

// Call-site sampling overrides (preview wants more room + slightly more freedom
// for narrative prose than classification).
export const FACT_VISUAL_PREVIEW_TEMPERATURE = 0.4;
export const FACT_VISUAL_PREVIEW_MAX_TOKENS = 1200;

type UserMessage = { role: "user"; content: string };

// ─── Prompt assembly ────────────────────────────────────────────────────────

export function buildPreviewUserMessage(input: PromptStrategyInput): string {
  const ctx = buildGuardrailContext(input);
  const strategy = selectStrategyEntry(input.enrichment);
  const e = input.enrichment;

  const culturalRefsBlock = e.culturalReferences.length
    ? e.culturalReferences
        .map(
          (r, i) =>
            `  ${i + 1}. sourcePhrase="${r.sourcePhrase}", referenceType=${r.referenceType}, canonicalReference="${r.canonicalReference}", explanation="${r.explanation}", visualImplication="${r.visualImplication}", confidence=${r.confidence}, requiresAdminReview=${r.requiresAdminReview}`,
        )
        .join("\n")
    : "  (no cultural references — render the joke from the literal text + taxonomy alone)";

  return [
    "Produce a visual prompt preview for this fact.",
    "",
    "Fact text:",
    input.factText,
    "",
    "Taxonomy (FIXED — DO NOT reclassify; apply the authored strategy):",
    `- primaryArchetype: ${e.primaryArchetype}`,
    `- subtype: ${e.subtype}`,
    `- modifiers: ${e.modifiers.join(", ") || "(none)"}`,
    `- visualLiteralness: ${e.visualLiteralness}`,
    `- visualComplexity: ${e.visualComplexity}`,
    `- overhypeFit: ${e.overhypeFit}`,
    `- adultSuitability: ${e.adultSuitability}`,
    `- taxonomyConfidence: ${e.taxonomyConfidence}`,
    "",
    "Authored strategy (APPLY this — do not improvise visual strategy from taxonomy alone):",
    serializeStrategyForPrompt(strategy),
    "",
    "Cultural references (inform the scene; do NOT reclassify taxonomy):",
    culturalRefsBlock,
    "",
    guardrailSystemAddendum(ctx),
    "",
    `Sample name for the previewAssumptions field: ${ctx.subjectLabel === "David" ? "David" : (input.sampleName ?? "the named subject")}`,
    "previewAssumptions.generationMode must be \"i2i_and_t2i_preview\".",
    "previewAssumptions.style must be \"default_sfw_cinematic\".",
    "previewAssumptions.preserveFace must be true.",
    "previewAssumptions.preservePhysique must be false.",
  ].join("\n");
}

function buildCorrective(error: string): string {
  return `The previous response failed validation: ${error}. Return the full JSON object again with every required field, all previewAssumptions literals exactly as specified (generationMode "i2i_and_t2i_preview", style "default_sfw_cinematic", preserveFace true, preservePhysique false), and no missing fields.`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function stampProvenance(
  preview: VisualPromptPreview,
  ctx: ReturnType<typeof buildGuardrailContext>,
  input: PromptStrategyInput,
): VisualPromptPreview {
  // Fill any soft defaults the model might have left thin.
  const promptGuardrailsPreview =
    preview.promptGuardrailsPreview && preview.promptGuardrailsPreview.length > 0
      ? preview.promptGuardrailsPreview
      : defaultPromptGuardrailsPreview(ctx);
  // Normalize sampleName to match the resolved subject label rule.
  const sampleName = ctx.useLiteralSubjectName
    ? "David"
    : (input.sampleName ?? "the named subject");
  return {
    ...preview,
    promptGuardrailsPreview,
    previewAssumptions: { ...preview.previewAssumptions, sampleName },
    previewPromptVersion: PREVIEW_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    generatedBy: "openai",
  };
}

// ─── Core orchestration (model call injected for testability) ───────────────

/**
 * Runs preview generation against an injected model caller: parse →
 * validateVisualPreview → on failure retry ONCE with a corrective → throw
 * PreviewError if still invalid. The injected `callModel` receives the user
 * messages and returns the raw model text (Structured Outputs JSON string).
 */
export async function generateVisualPreviewWithModel(
  input: PromptStrategyInput,
  callModel: (userMessages: UserMessage[]) => Promise<string>,
): Promise<VisualPromptPreview> {
  const firstUser: UserMessage = { role: "user", content: buildPreviewUserMessage(input) };

  let raw = await callModel([firstUser]);
  let parsed = safeJsonParse(raw);
  let result = validateVisualPreview(parsed);

  if (!result.ok) {
    raw = await callModel([firstUser, { role: "user", content: buildCorrective(result.error) }]);
    parsed = safeJsonParse(raw);
    result = validateVisualPreview(parsed);
  }

  if (!result.ok) {
    throw new PreviewError(result.error);
  }
  const ctx = buildGuardrailContext(input);
  return stampProvenance(result.data, ctx, input);
}

// ─── Live wrapper ───────────────────────────────────────────────────────────

async function callOpenAIVisualPreview(userMessages: UserMessage[]): Promise<string> {
  const systemPrompt = await getFactVisualPreviewSystem();
  const response = await callUtilityLLM({
    temperature: FACT_VISUAL_PREVIEW_TEMPERATURE,
    maxTokens: FACT_VISUAL_PREVIEW_MAX_TOKENS,
    responseFormat: zodResponseFormat(visualPreviewWireSchema, "visual_prompt_preview"),
    messages: [{ role: "system", content: systemPrompt }, ...userMessages],
  });
  return response.choices[0]?.message?.content ?? "{}";
}

/**
 * Generate a visual prompt preview via OpenAI. Throws `PreviewError` on
 * unrecoverable failure. Callers (the async-jobs handler) catch this and
 * surface `previewStatus: "failed"` on the target.
 */
export async function generateVisualPreview(
  input: PromptStrategyInput,
): Promise<VisualPromptPreview> {
  try {
    return await generateVisualPreviewWithModel(input, callOpenAIVisualPreview);
  } catch (err) {
    if (err instanceof PreviewError) throw err;
    logger.error({ err }, "[visualPreview] unexpected failure");
    throw new PreviewError(err instanceof Error ? err.message : String(err));
  }
}
