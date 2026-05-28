/**
 * Tier-3 AI vision fallback — escalation classifier.
 *
 * Fires only when Tier-1+Tier-2 produce an ambiguous, low-confidence, or
 * multi-subject result. Uses OpenAI Vision via the shared utility-LLM
 * wrapper with Structured Outputs so the response is always well-formed.
 *
 * Sampling: temperature 0.0, max_tokens 400. The classifier returns ONE
 * structured JSON object; no creative range needed.
 *
 * Admin-configurable system prompt via `fact_source_classifier_system`.
 * The active utility LLM (model + temperature defaults) is shared with
 * fact-enrichment / visual-preview via `callUtilityLLM`.
 */

import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  SOURCE_SUBJECT_KIND_VALUES,
  SUBJECT_RENDER_MODE_VALUES,
  CLASSIFICATION_CONFIDENCE_VALUES,
  type SourceImageAnalysis,
  SOURCE_IMAGE_ANALYZER_VERSION,
} from "@workspace/api-zod";
import { callUtilityLLM } from "../utilityLLM";
import { getFactSourceClassifierSystem } from "../imagePromptConfig";
import { logger } from "../logger";

const TIER3_TEMPERATURE = 0;
const TIER3_MAX_TOKENS = 400;

/** Strict wire schema for the AI vision classifier output. */
const tier3WireSchema = z.object({
  subjectKind: z.enum(SOURCE_SUBJECT_KIND_VALUES),
  confidence: z.enum(CLASSIFICATION_CONFIDENCE_VALUES),
  hasUsableHumanFace: z.boolean(),
  hasUsableSubject: z.boolean(),
  subjectCount: z.number(),
  subjectDescription: z.string(),
  suggestedRenderMode: z.enum(SUBJECT_RENDER_MODE_VALUES),
  warnings: z.array(z.string()),
});

export class Tier3VisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Tier3VisionError";
  }
}

/**
 * Classify the image at `imageUrl` via OpenAI vision. Returns a partial
 * `SourceImageAnalysis` (the analyzer wraps it with classificationMethod +
 * analyzerVersion). Throws Tier3VisionError on parse / network failure.
 */
export async function runTier3AiVisionFallback(imageUrl: string): Promise<
  Omit<SourceImageAnalysis, "classificationMethod" | "analyzerVersion" | "sourceImageSha256" | "detections">
> {
  const systemPrompt = await getFactSourceClassifierSystem();

  const response = await callUtilityLLM({
    temperature: TIER3_TEMPERATURE,
    maxTokens: TIER3_MAX_TOKENS,
    responseFormat: zodResponseFormat(tier3WireSchema, "source_image_classification"),
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: "Classify the main visual subject of this image for meme protagonist routing. Return structured JSON only." },
          { type: "image_url", image_url: { url: imageUrl } },
        ] as unknown as string, // OpenAI SDK types accept content blocks; cast for utility-LLM signature
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Tier3VisionError(`tier3 returned non-JSON content: ${raw.slice(0, 200)}`);
  }
  const result = tier3WireSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ issues: result.error.issues, raw }, "[tier3AiVision] schema validation failed");
    throw new Tier3VisionError(`tier3 schema validation failed: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}

export { SOURCE_IMAGE_ANALYZER_VERSION };
