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
import { callUtilityLLM } from "./utilityLLM";
import { ObjectStorageService } from "./objectStorage";
import { aiBackgroundKey } from "./storageKeys";
import { db } from "@workspace/db";
import { factsTable, userAiImagesTable, usersTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getConfigInt, getConfigString } from "./adminConfig";
import { getScenePromptSystem } from "./scenePromptConfig";
import { getCachedPrice, type CachedPrice } from "./falPricing";
import { computeImageCost, resolveImageSizePx } from "./costComputation";
import { BudgetExceededError, checkBudget, recordCost } from "./budgetGate";
import { logger } from "./logger";
import { applyFalSafetyTolerance, assertNoFalNsfwConcepts, FalSafetyTriggeredError } from "./moderation/falSafety";
import { classifyAndDecide } from "./moderation/nsfwClassifier";
import { quarantineImage } from "./moderation/quarantine";
import { ModerationRejectedError } from "./moderation/types";

/** Look up the user's nsfw mode flag with a small per-call cost. */
async function getUserNsfwModeEnabled(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const [row] = await db
      .select({ nsfwModeEnabled: usersTable.nsfwModeEnabled })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    return !!row?.nsfwModeEnabled;
  } catch (err) {
    logger.warn({ err, userId }, "[aiMemePipeline] failed to read nsfw_mode_enabled — defaulting false");
    return false;
  }
}

const DEFAULT_REFERENCE_FRAME_PROMPT =
  "The person's face, facial structure, skin tone, eye shape, hair, and all distinguishing features must be preserved with photorealistic accuracy and remain visually identical to the reference — this is the highest priority. Do not alter, stylize, or idealize the person's facial features in any way. The person should be placed into the scene as described. The scene and environment should be stylized as described, but the person's face and likeness must remain untouched by any stylization. No text, words, or letters anywhere in the image.";

const DEFAULT_IMAGE_MODEL_STANDARD  = "fal-ai/flux-pro/v1.1";
const DEFAULT_IMAGE_MODEL_REFERENCE = "fal-ai/flux-pulid";
const DEFAULT_IMAGE_SIZE            = "square_hd";

/**
 * Models that accept a face-reference image input.
 * Each uses a different parameter name for the reference URL.
 */
const REFERENCE_MODEL_INPUT_PARAM: Record<string, string> = {
  "fal-ai/flux-pulid":              "reference_image_url",
  "fal-ai/ip-adapter-face-id-plus": "face_image_url",
};

/** Returns true if the model supports a face reference image input. */
function isReferenceCapableModel(model: string): boolean {
  return model in REFERENCE_MODEL_INPUT_PARAM;
}

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
 * @deprecated Legacy FLUX/PuLID scene-prompt generator. The t2i/i2i engine
 * bench and the image meme generator now use the render-time image-prompt engine
 * (`lib/imagePrompt/*` + `buildAndEnqueueImagePromptAttempt`) rendering with Nano
 * Banana 2. This function survives ONLY for the video pipeline, the PuLID
 * reference jobs, `regenerate-scene-prompts`, and admin/script backfill, until
 * the Nano Banana video rebuild retires those paths. Do NOT wire new
 * image-generation surfaces to this path.
 */
export async function generateScenePrompts(factText: string): Promise<AiScenePrompts> {
  // The system prompt is admin-configurable (debug-overlay aware). The model +
  // sampling come from the shared General Intelligence engine, which picks the
  // right call shape for reasoning vs non-reasoning models. See lib/utilityLLM.ts.
  const systemPrompt = await getScenePromptSystem();
  const response = await callUtilityLLM({
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
const DEFAULT_USER_STORAGE_LIMIT = 1000;

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
  userId?: string,
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

  // ── Budget gate ──────────────────────────────────────────────────────────────
  let cachedImgPrice: CachedPrice | null = null;
  if (userId) {
    let priced: { price: CachedPrice; costUsd: number } | null = null;
    try {
      const price = await getCachedPrice(model);
      const { width, height } = resolveImageSizePx(imageSize);
      const costUsd = computeImageCost({ widthPx: width, heightPx: height, count: 1 }, price).costUsd;
      priced = { price, costUsd };
    } catch (err) {
      // Pricing unavailable — fail open, log and continue. Deliberately its
      // own catch, separate from the gate call below: a gate failure must
      // never be swallowed here as if it were a pricing miss (#409).
      logger.warn({ err, model }, "[aiMemePipeline] Budget gate skipped (pricing unavailable)");
    }
    if (priced) {
      // Deliberately outside the catch above (#409): a gate failure is not a
      // pricing failure, and must propagate rather than be swallowed.
      const budget = await checkBudget(userId, priced.costUsd);
      if (!budget.allowed) throw new BudgetExceededError(budget);
      cachedImgPrice = priced.price;
    }
  }

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
  const nsfwModeEnabled = await getUserNsfwModeEnabled(userId);
  const decision = await classifyAndDecide(imageUrl, { nsfwModeEnabled });
  if (decision.outcome === "reject") {
    try {
      await quarantineImage({
        source: "classifier",
        bytes: imageBuffer,
        mimeType: contentType,
        userId: userId ?? null,
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
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType,
  });

  // Set public-read ACL so thumbnails can be served via /api/storage/objects/*
  // AI meme backgrounds are non-personal scene images — public read is safe
  try {
    await objectStorage.trySetObjectEntityAclPolicy(storedPath, {
      owner: `system`,
      visibility: "public",
    });
  } catch (aclErr) {
    logger.warn({ err: aclErr, storedPath }, "[aiMemePipeline] Failed to set ACL");
  }

  // Record cost AFTER successful storage (spec: not before)
  if (userId && cachedImgPrice) {
    const { width, height } = resolveImageSizePx(imageSize);
    const { billingUnits, costUsd } = computeImageCost({ widthPx: width, heightPx: height, count: 1 }, cachedImgPrice);
    await recordCost({
      userId,
      jobType: "image",
      endpointId: model,
      unitPriceAtCreation: cachedImgPrice.unitPrice,
      billingUnits,
      computedCostUsd: costUsd,
      pricingFetchedAt: cachedImgPrice.fetchedAt,
      jobReferenceId: storedPath,
    });
  }

  return storedPath;
}

// ─── Per-user storage tracking ────────────────────────────────────────────────

/**
 * Returns true if the user is currently AT OR OVER their image storage limit.
 * Counts both AI-generated images and uploaded photos.
 */
export async function isUserAtImageLimit(userId: string): Promise<boolean> {
  const result = await db.execute<{ total: string }>(sql`
    SELECT (
      (SELECT count(*) FROM user_ai_images WHERE user_id = ${userId}) +
      (SELECT count(*) FROM upload_image_metadata WHERE user_id = ${userId})
    )::text AS total
  `);
  const total = parseInt(result.rows[0]?.total ?? "0", 10);
  const limit = await getConfigInt("user_max_images", DEFAULT_USER_STORAGE_LIMIT);
  return total >= limit;
}

/**
 * Records a newly generated AI image for a user.
 * Does NOT enforce the storage limit (callers must check first via isUserAtImageLimit).
 */
async function trackUserAiImage(
  userId: string,
  factId: number,
  gender: "male" | "female" | "neutral",
  storagePath: string,
  imageType: "generic" | "reference" = "generic",
): Promise<void> {
  await db.insert(userAiImagesTable).values({ userId, factId, gender, storagePath, imageType });
}

// ─── Reference-photo image generation ────────────────────────────────────────

/**
 * Generates a single AI image using fal.ai IP-Adapter with a reference photo.
 * The reference photo is uploaded to fal.ai storage, then used as a face_image_url
 * to place the person into a cinematic meme background matching the scene prompt.
 */
export type PulidProgressPhase = "queued" | "in_progress" | "completed";
export interface PulidProgressEvent {
  phase: PulidProgressPhase;
  /** fal queue position when phase==="queued"; undefined otherwise. */
  queuePosition?: number;
}
export type PulidProgressCallback = (event: PulidProgressEvent) => void;

async function generateAndStoreImageFromReference(
  factId: number,
  gender: "male" | "female" | "neutral",
  uniqueKey: string,
  prompt: string,
  referenceBuffer: Buffer,
  modelOverride?: string,
  paramsOverride?: Record<string, string>,
  userId?: string,
  onProgress?: PulidProgressCallback,
  imageSizeOverride?: string,
): Promise<string> {
  ensureFalConfigured();

  // Phase 6: ai_image_model_reference and ai_image_size are retired keys.
  // The PuLID engine row (kind="image", isDefault=true) is the canonical
  // source of truth for the reference model id today, but the legacy
  // codepath also supports IP-Adapter as an override target — so we
  // continue to honour modelOverride here. The default is the same value
  // that the engines table seeds for the PuLID engine's endpoint_id.
  const model     = modelOverride || DEFAULT_IMAGE_MODEL_REFERENCE;
  // The video pipeline supplies the target aspect's image_size so the still
  // matches the user's chosen output orientation; everything else defaults
  // to the bundled square.
  const imageSize = imageSizeOverride ?? DEFAULT_IMAGE_SIZE;

  // If the selected model is not reference-capable (e.g. FLUX Pro 1.1 chosen via admin override),
  // fall through to standard generation — don't upload the reference photo or pass a face param.
  if (!isReferenceCapableModel(model)) {
    logger.info({ model }, "[aiMemePipeline] model is not reference-capable — falling back to standard generation");
    return generateAndStoreImage(factId, gender, uniqueKey, prompt, model, paramsOverride, userId);
  }

  // Upload reference photo to fal.ai transient storage so we have a URL to pass
  const referenceBlob = new Blob([new Uint8Array(referenceBuffer)], { type: "image/jpeg" });
  const faceImageUrl = await fal.storage.upload(referenceBlob);

  // IMPORTANT: For PuLID and IP-Adapter models, face likeness comes from the image embedding,
  // NOT from text. Adding face-preservation instructions to the text prompt crowds out the scene
  // description and produces headshots. Keep the prompt focused on the scene only.
  //
  // The reference_frame_prompt (face preservation text) is intentionally NOT used here.
  // It is kept in admin_config for legacy use cases but should not be prepended to the scene prompt.

  // Each reference model uses a different parameter name for the face image URL.
  const faceParamName = REFERENCE_MODEL_INPUT_PARAM[model]!;

  const input: Record<string, unknown> = {
    [faceParamName]: faceImageUrl,
    prompt: prompt.trim(),
    image_size: imageSize,
    num_images: 1,
  };

  // PuLID-specific parameters.
  // Phase 6: ai_ref_pulid_* admin_config keys retired. Defaults baked in;
  // admin per-request overrides via `paramsOverride` still apply below.
  if (model === "fal-ai/flux-pulid") {
    input["id_scale"]            = 0.70;
    input["guidance_scale"]      = 5.5;
    input["num_inference_steps"] = 30;
    // true_cfg_scale and start_step intentionally omitted — defaults are
    // model-provided when not present.
    // Note: FLUX-based models (including PuLID) do NOT support negative_prompt.
  }

  // Apply admin per-request overrides last — they win over all config values
  applyParamOverrides(input, paramsOverride);

  // Layer 2 (request side). PuLID does not currently advertise the field;
  // helper is a no-op for unsupported models.
  await applyFalSafetyTolerance(input, model);

  // ── Budget gate ──────────────────────────────────────────────────────────────
  let cachedRefPrice: CachedPrice | null = null;
  if (userId) {
    let priced: { price: CachedPrice; costUsd: number } | null = null;
    try {
      const price = await getCachedPrice(model);
      const { width, height } = resolveImageSizePx(imageSize);
      const costUsd = computeImageCost({ widthPx: width, heightPx: height, count: 1 }, price).costUsd;
      priced = { price, costUsd };
    } catch (err) {
      // Pricing unavailable — fail open, log and continue. Deliberately its
      // own catch, separate from the gate call below: a gate failure must
      // never be swallowed here as if it were a pricing miss (#409).
      logger.warn({ err, model, path: "reference" }, "[aiMemePipeline] Budget gate skipped (pricing unavailable)");
    }
    if (priced) {
      // Deliberately outside the catch above (#409): a gate failure is not a
      // pricing failure, and must propagate rather than be swallowed.
      const budget = await checkBudget(userId, priced.costUsd);
      if (!budget.allowed) throw new BudgetExceededError(budget);
      cachedRefPrice = priced.price;
    }
  }

  const result = await fal.subscribe(model, {
    input,
    logs: false,
    onQueueUpdate: onProgress
      ? (status) => {
          if (status.status === "IN_QUEUE") {
            onProgress({ phase: "queued", queuePosition: status.queue_position });
          } else if (status.status === "IN_PROGRESS") {
            onProgress({ phase: "in_progress" });
          } else if (status.status === "COMPLETED") {
            onProgress({ phase: "completed" });
          }
        }
      : undefined,
  }) as { data: { images: Array<{ url: string }> } };

  // Layer 2 (response side).
  try {
    assertNoFalNsfwConcepts(result, model);
  } catch (err) {
    if (err instanceof FalSafetyTriggeredError) {
      logger.warn({ model, factId, gender }, "[aiMemePipeline] fal safety triggered — rejecting reference generation");
      throw new ModerationRejectedError("fal_safety", "Image rejected.", {
        source: "fal_safety",
        classifierModel: model,
        raw: err.raw,
      });
    }
    throw err;
  }

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error(`No image URL returned from fal.ai reference model ${model}`);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download reference image from fal.ai: ${imgRes.status}`);
  const { contentType, ext } = detectImageFormat(imgRes);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  // Layer 3.
  const refNsfwModeEnabled = await getUserNsfwModeEnabled(userId);
  const refDecision = await classifyAndDecide(imageUrl, { nsfwModeEnabled: refNsfwModeEnabled });
  if (refDecision.outcome === "reject") {
    try {
      await quarantineImage({
        source: "classifier",
        bytes: imageBuffer,
        mimeType: contentType,
        userId: userId ?? null,
        evidence: {
          source: "classifier",
          classifierScore: refDecision.score,
          classifierModel: refDecision.model,
          raw: refDecision.raw,
        },
        reportToNcmec: false,
      });
    } catch (qErr) {
      logger.error({ err: qErr }, "[aiMemePipeline] quarantine failed for ref classifier reject");
    }
    throw new ModerationRejectedError("classifier", "Image rejected.", {
      source: "classifier",
      classifierScore: refDecision.score,
      classifierModel: refDecision.model,
      raw: refDecision.raw,
    });
  }
  if (refDecision.outcome === "error") {
    logger.warn({ message: refDecision.message, model }, "[aiMemePipeline] ref NSFW classifier error — failing closed");
    throw new ModerationRejectedError("classifier", "Image rejected.", {
      source: "classifier",
      classifierModel: model,
      raw: { error: refDecision.message },
    });
  }

  const subPath = aiBackgroundKey(factId, gender, uniqueKey, ext, true);
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType,
  });

  try {
    await objectStorage.trySetObjectEntityAclPolicy(storedPath, {
      owner: "system",
      visibility: "public",
    });
  } catch (aclErr) {
    logger.warn({ err: aclErr, storedPath }, "[aiMemePipeline] Failed to set ACL");
  }

  // Record cost AFTER successful storage
  if (userId && cachedRefPrice) {
    const { width, height } = resolveImageSizePx(imageSize);
    const { billingUnits, costUsd } = computeImageCost({ widthPx: width, heightPx: height, count: 1 }, cachedRefPrice);
    await recordCost({
      userId,
      jobType: "image",
      endpointId: model,
      unitPriceAtCreation: cachedRefPrice.unitPrice,
      billingUnits,
      computedCostUsd: costUsd,
      pricingFetchedAt: cachedRefPrice.fetchedAt,
      jobReferenceId: storedPath,
    });
  }

  return storedPath;
}

/**
 * Generates a single AI meme background from a reference photo.
 * Generates exactly 1 image for the given targetGender, stored ONLY in user_ai_images
 * (with image_type='reference') so it does not pollute the shared fact-level aiMemeImages.
 * Safe to call fire-and-forget: catches all errors internally.
 */
export async function generateAiMemeBackgroundFromReference(
  factId: number,
  factText: string,
  referenceBuffer: Buffer,
  targetGender: "male" | "female" | "neutral",
  options?: {
    existingPrompts?: AiScenePrompts;
    userId?: string;
    /** Object path of the source reference image — written as source_object_path in upload_image_metadata for picker lineage. */
    sourceObjectPath?: string;
    styleSuffix?: string;
    /** Override the fal.ai model for this request (admin-only) */
    modelOverride?: string;
    /** Per-request param overrides for fal.ai (admin-only) */
    paramsOverride?: Record<string, string>;
    /** When true, errors are caught internally and logged; when false (default), errors propagate to caller */
    suppressErrors?: boolean;
    /** Optional progress callback — invoked when fal queue status changes. */
    onProgress?: PulidProgressCallback;
    /**
     * fal.ai `image_size` for the generated still (e.g. "square_hd",
     * "portrait_16_9", "landscape_16_9"). Defaults to the square bundled
     * default when omitted. The video pipeline passes this so the stylized
     * still matches the user's chosen output aspect ratio.
     */
    imageSize?: string;
  },
): Promise<string | null> {
  try {
    if (!options?.userId) {
      logger.warn({ factId }, "[aiMemePipeline] Reference generation called without userId — skipping");
      return null;
    }

    let prompts: AiScenePrompts;
    if (options?.existingPrompts) {
      prompts = options.existingPrompts;
    } else {
      logger.info({ factId }, "[aiMemePipeline] Generating scene prompts (reference mode)");
      prompts = await generateScenePrompts(factText);
      await db
        .update(factsTable)
        .set({ aiScenePrompts: prompts })
        .where(eq(factsTable.id, factId));
    }

    const uniqueKey = `${Date.now()}`;
    const basePrompt = prompts[targetGender];
    const prompt = options?.styleSuffix ? `${basePrompt.trim()} ${options.styleSuffix}` : basePrompt;
    logger.info(
      { factId, gender: targetGender, modelOverride: options?.modelOverride },
      "[aiMemePipeline] Generating reference-based image",
    );
    const storedPath = await generateAndStoreImageFromReference(factId, targetGender, uniqueKey, prompt, referenceBuffer, options?.modelOverride, options?.paramsOverride, options?.userId, options?.onProgress, options?.imageSize);

    // Track only in user_ai_images (type='reference') — NOT in the shared aiMemeImages on the fact
    try {
      await trackUserAiImage(options.userId, factId, targetGender, storedPath, "reference");
    } catch (trackErr) {
      logger.warn({ err: trackErr, userId: options.userId }, "[aiMemePipeline] Failed to track reference image");
    }

    // Also write to upload_image_metadata so the AI Stylings picker (GET /users/me/uploads?transform=ai)
    // can surface this image when the user creates a second meme for the same fact.
    try {
      // Phase 6: ai_image_size retired; default to the bundled square unless
      // the caller (video pipeline) supplies a target aspect's image_size.
      const imageSize = options?.imageSize ?? DEFAULT_IMAGE_SIZE;
      const { width, height } = resolveImageSizePx(imageSize);

      // source_object_path has a self-FK constraint (→ upload_image_metadata.object_path).
      // Only include it when the source row actually exists — older uploads processed
      // before metadata tracking was added may not have a row, and violating the FK
      // would cause the entire insert to fail, leaving the AI image unrecorded.
      let validatedSourcePath: string | null = null;
      if (options.sourceObjectPath) {
        const sourceCheck = await db.execute<{ count: string }>(sql`
          SELECT COUNT(*)::text AS count FROM upload_image_metadata
          WHERE object_path = ${options.sourceObjectPath}
        `);
        if (parseInt(sourceCheck.rows[0]?.count ?? "0", 10) > 0) {
          validatedSourcePath = options.sourceObjectPath;
        }
      }

      await db.execute(sql`
        INSERT INTO upload_image_metadata (
          object_path, user_id, width, height, is_low_res, file_size_bytes,
          transform, source_object_path, fact_id
        ) VALUES (
          ${storedPath}, ${options.userId}, ${width}, ${height}, false, 0,
          'pulid', ${validatedSourcePath}, ${factId}
        ) ON CONFLICT (object_path) DO NOTHING
      `);
    } catch (insertErr) {
      logger.warn({ err: insertErr, userId: options.userId }, "[aiMemePipeline] Failed to write pulid row to upload_image_metadata");
    }

    logger.info(
      { factId, userId: options.userId, gender: targetGender },
      "[aiMemePipeline] reference-based AI image stored",
    );
    return storedPath;
  } catch (err) {
    logger.error({ err, factId }, "[aiMemePipeline] Reference generation failed");
    if (!options?.suppressErrors) throw err;
    return null;
  }
}

/**
 * Standalone single-image generator used when face-based generation fails
 * (e.g. PuLID returns "no face detected"). Bypasses the face-reference model
 * and uses the standard text-to-image model, then persists the result in the
 * same places `generateAiMemeBackgroundFromReference` does so the wizard's
 * existing "AI stylings" picker surfaces it identically.
 *
 * Safe to call when the upstream PuLID call has already paid the budget for
 * the failed attempt — this is a second charge, intentional.
 */
export async function generateAiMemeBackgroundStandalone(
  factId: number,
  factText: string,
  targetGender: "male" | "female" | "neutral",
  options: {
    existingPrompts?: AiScenePrompts;
    userId: string;
    /** Object path of the reference upload the user picked — written as source_object_path for picker lineage. */
    sourceObjectPath?: string;
    styleSuffix?: string;
    /** Override the fal.ai standard model for this request (admin-only) */
    modelOverride?: string;
    /** Per-request param overrides for fal.ai (admin-only) */
    paramsOverride?: Record<string, string>;
  },
): Promise<string> {
  let prompts: AiScenePrompts;
  if (options.existingPrompts) {
    prompts = options.existingPrompts;
  } else {
    prompts = await generateScenePrompts(factText);
    await db
      .update(factsTable)
      .set({ aiScenePrompts: prompts })
      .where(eq(factsTable.id, factId));
  }

  const uniqueKey = `${Date.now()}_nf`;
  const basePrompt = prompts[targetGender];
  const prompt = options.styleSuffix ? `${basePrompt.trim()} ${options.styleSuffix}` : basePrompt;
  logger.info(
    { factId, gender: targetGender, userId: options.userId },
    "[aiMemePipeline] Generating standalone (non-face) fallback image",
  );

  const storedPath = await generateAndStoreImage(
    factId,
    targetGender,
    uniqueKey,
    prompt,
    options.modelOverride,
    options.paramsOverride,
    options.userId,
  );

  // Track in user_ai_images so storage limits include it.
  try {
    await trackUserAiImage(options.userId, factId, targetGender, storedPath, "reference");
  } catch (trackErr) {
    logger.warn({ err: trackErr, userId: options.userId }, "[aiMemePipeline] Failed to track standalone image");
  }

  // Mirror the metadata write done by the reference path so the AI Stylings
  // picker (GET /users/me/uploads?transform=ai) surfaces it.
  try {
    // Phase 6: ai_image_size retired; use the bundled default.
    const imageSize = DEFAULT_IMAGE_SIZE;
    const { width, height } = resolveImageSizePx(imageSize);

    let validatedSourcePath: string | null = null;
    if (options.sourceObjectPath) {
      const sourceCheck = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*)::text AS count FROM upload_image_metadata
        WHERE object_path = ${options.sourceObjectPath}
      `);
      if (parseInt(sourceCheck.rows[0]?.count ?? "0", 10) > 0) {
        validatedSourcePath = options.sourceObjectPath;
      }
    }

    await db.execute(sql`
      INSERT INTO upload_image_metadata (
        object_path, user_id, width, height, is_low_res, file_size_bytes,
        transform, source_object_path, fact_id
      ) VALUES (
        ${storedPath}, ${options.userId}, ${width}, ${height}, false, 0,
        'pulid', ${validatedSourcePath}, ${factId}
      ) ON CONFLICT (object_path) DO NOTHING
    `);
  } catch (insertErr) {
    logger.warn({ err: insertErr, userId: options.userId }, "[aiMemePipeline] Failed to write standalone fallback to upload_image_metadata");
  }

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
    /**
     * ID of the legendary user triggering the generation.
     * When provided, each generated image is tracked in user_ai_images and
     * the per-user 1000-image storage limit is enforced.
     * Omit for admin/system backfill operations.
     */
    userId?: string;
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

    const userId = options?.userId;
    const maxPerGender = await getConfigInt("ai_max_images_per_gender", DEFAULT_MAX_IMAGES_PER_GENDER);

    for (const { gender } of slots) {
      const uniqueKey = `${batchKey}_${slotCounter++}`;
      const basePrompt = prompts[gender];
      const prompt = options?.styleSuffix ? `${basePrompt.trim()} ${options.styleSuffix}` : basePrompt;
      logger.info(
        { factId, gender, key: uniqueKey, modelOverride: options?.modelOverride },
        "[aiMemePipeline] Generating image",
      );
      const storedPath = await generateAndStoreImage(factId, gender, uniqueKey, prompt, options?.modelOverride, options?.paramsOverride, userId);
      // Prepend newest image at the front — gallery always shows newest-first
      result[gender].unshift(storedPath);
      // Trim per-fact gallery to max per gender
      if (result[gender].length > maxPerGender) {
        result[gender] = result[gender].slice(0, maxPerGender);
      }
      // Track per-user storage and enforce 1000-image limit (AI + uploads combined)
      if (userId) {
        try {
          await trackUserAiImage(userId, factId, gender, storedPath);
        } catch (trackErr) {
          logger.warn({ err: trackErr, userId }, "[aiMemePipeline] Failed to track user image");
        }
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

// ─── Debug preview ────────────────────────────────────────────────────────────

/**
 * Builds a preview of the fal.ai call that would be made for a given prompt,
 * reading all params from admin_config. Does NOT call fal.ai — for debug display only.
 */
export async function buildFalInputPreview(
  prompt: string,
  options?: {
    modelOverride?: string;
    isReference?: boolean;
    paramsOverride?: Record<string, string>;
  },
): Promise<{ model: string; input: Record<string, unknown> }> {
  // Phase 6: legacy ai_image_model_*, ai_image_size, ai_std_*, ai_ref_pulid_*,
  // ai_pulid_composition_suffix keys retired. Defaults baked in.
  const isRef = options?.isReference ?? false;
  const model = options?.modelOverride ||
    (isRef ? DEFAULT_IMAGE_MODEL_REFERENCE : DEFAULT_IMAGE_MODEL_STANDARD);

  const imageSize         = DEFAULT_IMAGE_SIZE;

  if (isRef && isReferenceCapableModel(model)) {
    // Reference path (PuLID / IP-Adapter)
    const faceParamName = REFERENCE_MODEL_INPUT_PARAM[model]!;
    const input: Record<string, unknown> = {
      [faceParamName]: "<reference_image_url>",
      prompt: prompt.trim(),
      image_size: imageSize,
      num_images: 1,
    };
    if (model === "fal-ai/flux-pulid") {
      input["id_scale"]            = 0.70;
      input["guidance_scale"]      = 5.5;
      input["num_inference_steps"] = 30;
    }
    applyParamOverrides(input, options?.paramsOverride);
    return { model, input };
  }

  // Standard path — defaults baked in.
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
    input["aspect_ratio"]     = aspectRatio;
    input["safety_tolerance"] = safetyTolerance;
    input["raw"]              = ultraRaw;
    input["output_format"]    = outputFormat;
  } else if (model === "fal-ai/flux-2-pro" || model === "fal-ai/flux-2-max") {
    input["aspect_ratio"]  = aspectRatio;
    input["output_format"] = outputFormat;
  } else {
    input["image_size"]          = imageSize;
    input["num_inference_steps"] = numInferenceSteps;
    input["guidance_scale"]      = guidanceScale;
    input["output_format"]       = outputFormat;
    if (model === "fal-ai/flux-pro" || model === "fal-ai/flux-pro/v1.1") {
      input["safety_tolerance"] = safetyTolerance;
    }
  }
  applyParamOverrides(input, options?.paramsOverride);
  return { model, input };
}
