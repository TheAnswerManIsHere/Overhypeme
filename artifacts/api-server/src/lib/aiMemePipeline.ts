/**
 * AI Meme Pipeline
 *
 * 1. Calls gpt-4o-mini to generate three scene prompt variants (male/female/neutral).
 * 2. Calls fal.ai to generate images using the scene prompts.
 *    - Standard generation: fal-ai/flux-pro/v1.1 (or admin_config override)
 *    - Reference-photo generation: fal-ai/ip-adapter-face-id-plus (or admin_config override)
 * 3. Saves each image to object storage and persists the paths on the fact record.
 *
 * Runs async (non-blocking) — callers fire-and-forget with void.
 * Should never throw — catches all errors internally.
 */

import { fal, ensureFalConfigured } from "./falClient";
import { callUtilityLLM, JUDGEMENT_REASONING_EFFORT } from "./utilityLLM";
import { ObjectStorageService } from "./objectStorage";
import { aiBackgroundKey } from "./storageKeys";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getConfigInt, getConfigString } from "./adminConfig";
import { getScenePromptSystem } from "./scenePromptConfig";
import { logger } from "./logger";
import { applyFalSafetyTolerance, assertNoFalNsfwConcepts, FalSafetyTriggeredError } from "./moderation/falSafety";
import { classifyAndDecide } from "./moderation/nsfwClassifier";
import { quarantineImage } from "./moderation/quarantine";
import { ModerationRejectedError } from "./moderation/types";

const DEFAULT_IMAGE_MODEL_STANDARD  = "fal-ai/flux-pro/v1.1";
const DEFAULT_IMAGE_SIZE            = "square_hd";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AiScenePrompts {
  fact_type: "action" | "abstract";
  male:    string;
  female:  string;
  neutral: string;
}

export interface AiMemeImages {
  male:    string[];  // object storage paths, 3 per gender
  female:  string[];
  neutral: string[];
}

// fal.ai client initialisation moved to lib/falClient.ts (single source of
// truth for FAL_AI_API_KEY/FAL_KEY lookup + fal.config). Call sites in this
// module invoke `ensureFalConfigured()` defensively before fal.subscribe.

/**
 * Detects the image content type and extension from HTTP response headers.
 * Falls back to image/jpeg / .jpg if Content-Type is absent or unrecognised.
 */
function detectImageFormat(response: Response): { contentType: string; ext: string } {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("image/png"))  return { contentType: "image/png",  ext: "png"  };
  if (ct.includes("image/webp")) return { contentType: "image/webp", ext: "webp" };
  if (ct.includes("image/gif"))  return { contentType: "image/gif",  ext: "gif"  };
  // Default: treat as JPEG (fal.ai often returns JPEG for photorealistic models)
  return { contentType: "image/jpeg", ext: "jpg" };
}

// ─── LLM scene prompt generation ─────────────────────────────────────────────

/**
 * @deprecated Legacy FLUX scene-prompt generator. The t2i/i2i engine bench and
 * the image meme generator now use the render-time image-prompt engine
 * (`lib/imagePrompt/*` + `buildAndEnqueueImagePromptAttempt`) rendering with Nano
 * Banana 2. This function survives ONLY for the per-fact AI background backfill
 * (`generateAiMemeBackgrounds`); its other callers (video, PuLID) were deleted
 * in launch Phase 4 (`docs/retired/README.md`). Do NOT wire new
 * image-generation surfaces to this path.
 */
export async function generateScenePrompts(factText: string): Promise<AiScenePrompts> {
  // The system prompt is admin-configurable (debug-overlay aware). The model +
  // sampling come from the shared General Intelligence engine, which picks the
  // right call shape for reasoning vs non-reasoning models. See lib/utilityLLM.ts.
  const systemPrompt = await getScenePromptSystem();
  const response = await callUtilityLLM({
    reasoningEffort: JUDGEMENT_REASONING_EFFORT,
    responseFormat: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Fact template: "${factText}"` },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw) as Partial<AiScenePrompts>;

  const factType = parsed.fact_type === "abstract" ? "abstract" : "action";
  const fallback = factType === "abstract"
    ? "Epic cinematic cosmic scene with dramatic light rays, dark nebula background, ultra high detail"
    : "Cinematic portrait of a person in dramatic lighting, ultra realistic, high quality";

  return {
    fact_type: factType,
    male:    typeof parsed.male    === "string" && parsed.male.trim()    ? parsed.male.trim()    : fallback,
    female:  typeof parsed.female  === "string" && parsed.female.trim()  ? parsed.female.trim()  : fallback,
    neutral: typeof parsed.neutral === "string" && parsed.neutral.trim() ? parsed.neutral.trim() : fallback,
  };
}

// ─── Constants (defaults — overridden at runtime by admin_config table) ────────

const DEFAULT_MAX_IMAGES_PER_GENDER = 34;

// ─── Image generation ─────────────────────────────────────────────────────────

const objectStorage = new ObjectStorageService();

/**
 * Merges admin-supplied string overrides into the fal.ai input object.
 * Numeric coercion: if the value looks like a finite number, it's cast to number.
 * Values set to "" are ignored (admin left the field blank = use default).
 */
function applyParamOverrides(input: Record<string, unknown>, overrides?: Record<string, string>): void {
  if (!overrides) return;
  for (const [key, raw] of Object.entries(overrides)) {
    if (raw === "" || raw === undefined) continue;
    const num = Number(raw);
    input[key] = Number.isFinite(num) ? num : raw;
  }
}

async function generateAndStoreImage(
  factId: number,
  gender: "male" | "female" | "neutral",
  uniqueKey: string,
  prompt: string,
  modelOverride?: string,
  paramsOverride?: Record<string, string>,
): Promise<string> {
  ensureFalConfigured();

  // Phase 6: the retired ai_image_model_standard / ai_image_size / ai_std_*
  // admin_config keys are now baked-in defaults. Admin per-request overrides
  // via `paramsOverride` still apply at the bottom of this function.
  const model             = modelOverride || DEFAULT_IMAGE_MODEL_STANDARD;
  const imageSize         = DEFAULT_IMAGE_SIZE;
  const numInferenceSteps = 28;
  const guidanceScale     = 3.5;
  const safetyTolerance   = "2";
  const outputFormat      = "jpeg";
  const aspectRatio       = "1:1";
  const ultraRaw          = false;

  const input: Record<string, unknown> = { prompt, num_images: 1 };

  if (model === "xai/grok-imagine-image") {
    delete input["num_images"];
    input["n"]            = 1;
    input["aspect_ratio"] = aspectRatio;
  } else if (model === "fal-ai/flux-pro/v1.1-ultra") {
    input["aspect_ratio"]      = aspectRatio;
    input["safety_tolerance"]  = safetyTolerance;
    input["raw"]               = ultraRaw;
    input["output_format"]     = outputFormat;
  } else if (model === "fal-ai/flux-2-pro" || model === "fal-ai/flux-2-max") {
    input["aspect_ratio"]  = aspectRatio;
    input["output_format"] = outputFormat;
  } else {
    // FLUX 1 models: dev, schnell, flux-pro, flux-pro/v1.1
    input["image_size"]            = imageSize;
    input["num_inference_steps"]   = numInferenceSteps;
    input["guidance_scale"]        = guidanceScale;
    input["output_format"]         = outputFormat;
    if (model === "fal-ai/flux-pro" || model === "fal-ai/flux-pro/v1.1") {
      input["safety_tolerance"] = safetyTolerance;
    }
  }

  // Phase 6: ai_std_seed retired; admin overrides still flow via paramsOverride.

  // Apply admin per-request overrides last — they win over all config values
  applyParamOverrides(input, paramsOverride);

  // Layer 2 (request side): set fal.ai safety_tolerance for models that
  // accept it. No-op for models whose schema rejects the field.
  await applyFalSafetyTolerance(input, model);

  const result = await fal.subscribe(model, {
    input,
    logs: false,
  }) as { data: { images: Array<{ url: string }> } };

  // Layer 2 (response side): refuse outputs the model itself flagged as NSFW.
  try {
    assertNoFalNsfwConcepts(result, model);
  } catch (err) {
    if (err instanceof FalSafetyTriggeredError) {
      logger.warn({ model, factId, gender }, "[aiMemePipeline] fal safety triggered — rejecting standard generation");
      throw new ModerationRejectedError("fal_safety", "Image rejected.", {
        source: "fal_safety",
        classifierModel: model,
        raw: err.raw,
      });
    }
    throw err;
  }

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error(`No image URL returned from fal.ai model ${model}`);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download image from fal.ai: ${imgRes.status}`);
  const { contentType, ext } = detectImageFormat(imgRes);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  // Layer 3: NSFW classifier on the generated bytes (via the fal-hosted URL).
  // System backfill: no user, so no user NSFW opt-in applies.
  const decision = await classifyAndDecide(imageUrl, { nsfwModeEnabled: false });
  if (decision.outcome === "reject") {
    try {
      await quarantineImage({
        source: "classifier",
        bytes: imageBuffer,
        mimeType: contentType,
        userId: null,
        evidence: {
          source: "classifier",
          classifierScore: decision.score,
          classifierModel: decision.model,
          raw: decision.raw,
        },
        reportToNcmec: false,
      });
    } catch (qErr) {
      logger.error({ err: qErr }, "[aiMemePipeline] quarantine failed for classifier reject");
    }
    throw new ModerationRejectedError("classifier", "Image rejected.", {
      source: "classifier",
      classifierScore: decision.score,
      classifierModel: decision.model,
      raw: decision.raw,
    });
  }
  if (decision.outcome === "error") {
    logger.warn({ message: decision.message, model }, "[aiMemePipeline] NSFW classifier error — failing closed");
    throw new ModerationRejectedError("classifier", "Image rejected.", {
      source: "classifier",
      classifierModel: model,
      raw: { error: decision.message },
    });
  }

  const subPath = aiBackgroundKey(factId, gender, uniqueKey, ext, false);
  // Public-read ACL, set in the same write, so thumbnails can be served via
  // /api/storage/objects/*. AI meme backgrounds are non-personal scene images —
  // public read is safe.
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType,
    aclPolicy: { owner: "system", visibility: "public" },
  });

  return storedPath;
}

// ─── Pipeline orchestration ───────────────────────────────────────────────────

/**
 * Generates AI meme backgrounds for a fact.
 * Runs the full pipeline: scene prompts → image generation → persistence.
 * Safe to call fire-and-forget: catches all errors internally.
 *
 * scope:
 *   - undefined / "full"  → generate all 9 images (3 genders × 3 indices)
 *   - "gendered"          → generate exactly 3 images (index 0 for each gender)
 *   - "abstract"          → generate exactly 1 image (neutral gender, index 0)
 *   - targetGender+targetIndex → generate a single specific image (legacy partial regen)
 */
export async function generateAiMemeBackgrounds(
  factId: number,
  factText: string,
  options?: {
    /** High-level scope shorthand; takes precedence over targetGender/targetIndex */
    scope?: "full" | "gendered" | "abstract";
    /** If provided, only regenerate one specific image (use with targetIndex) */
    targetGender?: "male" | "female" | "neutral";
    targetIndex?: number;
    /** If provided, use existing prompts from DB (skip prompt regen) */
    existingPrompts?: AiScenePrompts;
    /** Existing images to preserve when doing partial regen */
    existingImages?: AiMemeImages;
    /** Optional style suffix appended to each scene prompt before image generation. */
    styleSuffix?: string;
    /** Override the fal.ai model for this request (admin-only) */
    modelOverride?: string;
    /** Per-request param overrides for fal.ai (admin-only) */
    paramsOverride?: Record<string, string>;
    /** When true, errors are caught internally and logged; when false (default), errors propagate to caller */
    suppressErrors?: boolean;
  },
): Promise<void> {
  try {
    // 1. Generate scene prompts (or use existing)
    let prompts: AiScenePrompts;
    if (options?.existingPrompts) {
      prompts = options.existingPrompts;
    } else {
      logger.info({ factId }, "[aiMemePipeline] Generating scene prompts");
      prompts = await generateScenePrompts(factText);

      // Persist prompts immediately
      await db
        .update(factsTable)
        .set({ aiScenePrompts: prompts })
        .where(eq(factsTable.id, factId));
    }

    // 2. Resolve which (gender, index) slots to generate based on scope
    const scope = options?.scope ?? "full";
    let slots: Array<{ gender: "male" | "female" | "neutral"; index: number }>;

    if (scope === "abstract") {
      // 1 image: neutral, index 0
      slots = [{ gender: "neutral", index: 0 }];
    } else if (scope === "gendered") {
      // 3 images: one per gender, all at index 0
      slots = [
        { gender: "male",    index: 0 },
        { gender: "female",  index: 0 },
        { gender: "neutral", index: 0 },
      ];
    } else if (options?.targetGender !== undefined && options?.targetIndex !== undefined) {
      // Legacy single-slot regen
      slots = [{ gender: options.targetGender, index: options.targetIndex }];
    } else {
      // Full: all 9 images
      slots = (["male", "female", "neutral"] as const).flatMap(g =>
        [0, 1, 2].map(i => ({ gender: g, index: i })),
      );
    }

    // 3. Generate images for resolved slots
    // Start from existing images (filtered to remove legacy empty-string placeholders)
    const result: AiMemeImages = {
      male:    (options?.existingImages?.male    ?? []).filter(Boolean),
      female:  (options?.existingImages?.female  ?? []).filter(Boolean),
      neutral: (options?.existingImages?.neutral ?? []).filter(Boolean),
    };

    // Each generation creates a unique filename using timestamp so no two images collide
    const batchKey = Date.now();
    let slotCounter = 0;

    const maxPerGender = await getConfigInt("ai_max_images_per_gender", DEFAULT_MAX_IMAGES_PER_GENDER);

    for (const { gender } of slots) {
      const uniqueKey = `${batchKey}_${slotCounter++}`;
      const basePrompt = prompts[gender];
      const prompt = options?.styleSuffix ? `${basePrompt.trim()} ${options.styleSuffix}` : basePrompt;
      logger.info(
        { factId, gender, key: uniqueKey, modelOverride: options?.modelOverride },
        "[aiMemePipeline] Generating image",
      );
      const storedPath = await generateAndStoreImage(factId, gender, uniqueKey, prompt, options?.modelOverride, options?.paramsOverride);
      // Prepend newest image at the front — gallery always shows newest-first
      result[gender].unshift(storedPath);
      // Trim per-fact gallery to max per gender
      if (result[gender].length > maxPerGender) {
        result[gender] = result[gender].slice(0, maxPerGender);
      }
    }

    // 4. Persist image paths — explicitly set updatedAt so polling detection always works
    await db
      .update(factsTable)
      .set({ aiMemeImages: result, updatedAt: new Date() })
      .where(eq(factsTable.id, factId));

    const totalImages = result.male.filter(Boolean).length +
      result.female.filter(Boolean).length +
      result.neutral.filter(Boolean).length;
    logger.info({ factId, totalImages, scope }, "[aiMemePipeline] AI meme images stored");
  } catch (err) {
    logger.error({ err, factId }, "[aiMemePipeline] Failed");
    if (!options?.suppressErrors) throw err;
  }
}
