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

import { fal } from "@fal-ai/client";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { ObjectStorageService } from "./objectStorage";
import { db } from "@workspace/db";
import { factsTable, userAiImagesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getConfigInt, getConfigString } from "./adminConfig";

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

// ─── fal.ai client initialisation ────────────────────────────────────────────

function getFalApiKey(): string {
  const key = process.env.FAL_AI_API_KEY;
  if (!key) {
    console.error("[aiMemePipeline] FAL_AI_API_KEY environment variable is not set — image generation unavailable");
    throw new Error("FAL_AI_API_KEY environment variable is not set — image generation unavailable");
  }
  return key;
}

function configureFal(): void {
  fal.config({ credentials: getFalApiKey() });
}

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

const SCENE_PROMPT_SYSTEM = `You generate cinematic scene prompts for AI image generation for meme backgrounds.

Given a personalized fact template (using tokens like {NAME}, {SUBJ}, {OBJ}, {POSS}), produce three scene prompts for cinematic AI image generation.

Rules:
1. Classify the fact:
   - "action" = a person doing something physical, social, or occupational
   - "abstract" = cosmic, metaphysical, or impossible to photograph
2. For "action" facts: produce 3 different prompts (male, female, neutral subject).
   For "abstract" facts: all 3 prompts can be identical dramatic cinematic scenes.
3. Each prompt must:
   - Describe a SQUARE cinematic scene
   - Have dramatic lighting, high contrast, cinematic quality
   - NOT contain any text or letters
   - Be 20-40 words
   - Start with "Cinematic " or "Epic " or "Dramatic "

Return ONLY valid JSON:
{"fact_type":"action","male":"Cinematic shot of a muscular man...","female":"Cinematic shot of a strong woman...","neutral":"Dramatic scene of a person..."}`;

export async function generateScenePrompts(factText: string): Promise<AiScenePrompts> {
  const openai = getOpenAIClient();
  const systemPrompt = await getConfigString("ai_scene_prompt_system", SCENE_PROMPT_SYSTEM);
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 400,
    temperature: 0.7,
    response_format: { type: "json_object" },
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
): Promise<string> {
  configureFal();

  const model             = modelOverride || await getConfigString("ai_image_model_standard", DEFAULT_IMAGE_MODEL_STANDARD);
  const imageSize         = await getConfigString("ai_image_size", DEFAULT_IMAGE_SIZE);
  const numInferenceSteps = await getConfigInt("ai_std_num_inference_steps", 28);
  const guidanceScale     = parseFloat(await getConfigString("ai_std_guidance_scale", "3.5"));
  const safetyTolerance   = await getConfigString("ai_std_safety_tolerance", "2");
  const seedStr           = await getConfigString("ai_std_seed", "");
  const outputFormat      = await getConfigString("ai_std_output_format", "jpeg");
  const aspectRatio       = await getConfigString("ai_std_aspect_ratio", "1:1");
  const ultraRaw          = await getConfigString("ai_std_ultra_raw", "false");

  const input: Record<string, unknown> = { prompt, num_images: 1 };

  if (model === "fal-ai/flux-pro/v1.1-ultra") {
    input["aspect_ratio"]      = aspectRatio;
    input["safety_tolerance"]  = safetyTolerance;
    input["raw"]               = ultraRaw === "true";
    input["output_format"]     = outputFormat;
  } else if (model === "fal-ai/flux-2-pro" || model === "fal-ai/flux-2-max") {
    input["aspect_ratio"]  = aspectRatio;
    input["output_format"] = outputFormat;
  } else {
    // FLUX 1 models: dev, schnell, flux-pro, flux-pro/v1.1
    input["image_size"]            = imageSize;
    input["num_inference_steps"]   = numInferenceSteps;
    input["guidance_scale"]        = isNaN(guidanceScale) ? 3.5 : guidanceScale;
    input["output_format"]         = outputFormat;
    if (model === "fal-ai/flux-pro" || model === "fal-ai/flux-pro/v1.1") {
      input["safety_tolerance"] = safetyTolerance;
    }
  }

  const seedNum = seedStr.trim() ? parseInt(seedStr.trim(), 10) : NaN;
  if (!isNaN(seedNum)) input["seed"] = seedNum;

  // Apply admin per-request overrides last — they win over all config values
  applyParamOverrides(input, paramsOverride);

  const result = await fal.subscribe(model, {
    input,
    logs: false,
  }) as { data: { images: Array<{ url: string }> } };

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error(`No image URL returned from fal.ai model ${model}`);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download image from fal.ai: ${imgRes.status}`);
  const { contentType, ext } = detectImageFormat(imgRes);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  const subPath = `ai_meme_${factId}_${gender}_${uniqueKey}.${ext}`;
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
    console.warn(`[aiMemePipeline] Failed to set ACL for ${storedPath}:`, aclErr);
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
async function generateAndStoreImageFromReference(
  factId: number,
  gender: "male" | "female" | "neutral",
  uniqueKey: string,
  prompt: string,
  referenceBuffer: Buffer,
  modelOverride?: string,
  paramsOverride?: Record<string, string>,
): Promise<string> {
  configureFal();

  const model     = modelOverride || await getConfigString("ai_image_model_reference", DEFAULT_IMAGE_MODEL_REFERENCE);
  const imageSize = await getConfigString("ai_image_size", DEFAULT_IMAGE_SIZE);

  // If the selected model is not reference-capable (e.g. FLUX Pro 1.1 chosen via admin override),
  // fall through to standard generation — don't upload the reference photo or pass a face param.
  if (!isReferenceCapableModel(model)) {
    console.log(`[aiMemePipeline] model "${model}" is not reference-capable — falling back to standard generation`);
    return generateAndStoreImage(factId, gender, uniqueKey, prompt, model, paramsOverride);
  }

  // Upload reference photo to fal.ai transient storage so we have a URL to pass
  const referenceBlob = new Blob([referenceBuffer], { type: "image/jpeg" });
  const faceImageUrl = await fal.storage.upload(referenceBlob);

  // IMPORTANT: For PuLID and IP-Adapter models, face likeness comes from the image embedding,
  // NOT from text. Adding face-preservation instructions to the text prompt crowds out the scene
  // description and produces headshots. Keep the prompt focused on the scene only.
  //
  // The reference_frame_prompt (face preservation text) is intentionally NOT used here.
  // It is kept in admin_config for legacy use cases but should not be prepended to the scene prompt.

  // Each reference model uses a different parameter name for the face image URL.
  const faceParamName = REFERENCE_MODEL_INPUT_PARAM[model]!;

  // Append composition suffix so PuLID shows a full scene rather than a portrait close-up.
  const DEFAULT_COMPOSITION_SUFFIX =
    "Full body wide angle shot. Person shown in action within the scene environment. " +
    "Show the full setting and context. NOT a portrait or close-up.";
  const compositionSuffix = await getConfigString("ai_pulid_composition_suffix", DEFAULT_COMPOSITION_SUFFIX);
  const finalPrompt = compositionSuffix ? `${prompt.trim()} ${compositionSuffix}` : prompt;

  const input: Record<string, unknown> = {
    [faceParamName]: faceImageUrl,
    prompt: finalPrompt,
    image_size: imageSize,
    num_images: 1,
  };

  // PuLID-specific parameters — all read from admin_config
  if (model === "fal-ai/flux-pulid") {
    const idScale        = parseFloat(await getConfigString("ai_ref_pulid_id_scale", "0.70"));
    const guidanceScale  = parseFloat(await getConfigString("ai_ref_pulid_guidance_scale", "5.5"));
    const numSteps       = await getConfigInt("ai_ref_pulid_num_inference_steps", 30);
    const trueCfgStr     = await getConfigString("ai_ref_pulid_true_cfg_scale", "");
    const startStepStr   = await getConfigString("ai_ref_pulid_start_step", "");

    input["id_scale"]            = isNaN(idScale) ? 0.70 : idScale;
    input["guidance_scale"]      = isNaN(guidanceScale) ? 5.5 : guidanceScale;
    input["num_inference_steps"] = numSteps;
    if (trueCfgStr.trim()) {
      const trueCfg = parseFloat(trueCfgStr.trim());
      if (!isNaN(trueCfg)) input["true_cfg_scale"] = trueCfg;
    }
    if (startStepStr.trim()) {
      const startStep = parseInt(startStepStr.trim(), 10);
      if (!isNaN(startStep)) input["start_step"] = startStep;
    }
    // Note: FLUX-based models (including PuLID) do NOT support negative_prompt.
  }

  // Apply admin per-request overrides last — they win over all config values
  applyParamOverrides(input, paramsOverride);

  const result = await fal.subscribe(model, {
    input,
    logs: false,
  }) as { data: { images: Array<{ url: string }> } };

  const imageUrl = result.data?.images?.[0]?.url;
  if (!imageUrl) throw new Error(`No image URL returned from fal.ai reference model ${model}`);

  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`Failed to download reference image from fal.ai: ${imgRes.status}`);
  const { contentType, ext } = detectImageFormat(imgRes);
  const imageBuffer = Buffer.from(await imgRes.arrayBuffer());

  const subPath = `ai_meme_${factId}_${gender}_ref_${uniqueKey}.${ext}`;
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
    console.warn(`[aiMemePipeline] Failed to set ACL for ${storedPath}:`, aclErr);
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
    if (!options?.userId) {
      console.warn(`[aiMemePipeline] Reference generation for fact ${factId} called without userId — skipping`);
      return;
    }

    let prompts: AiScenePrompts;
    if (options?.existingPrompts) {
      prompts = options.existingPrompts;
    } else {
      console.log(`[aiMemePipeline] Generating scene prompts for fact ${factId} (reference mode)`);
      prompts = await generateScenePrompts(factText);
      await db
        .update(factsTable)
        .set({ aiScenePrompts: prompts })
        .where(eq(factsTable.id, factId));
    }

    const uniqueKey = `${Date.now()}`;
    const basePrompt = prompts[targetGender];
    const prompt = options?.styleSuffix ? `${basePrompt.trim()} ${options.styleSuffix}` : basePrompt;
    console.log(`[aiMemePipeline] Generating reference-based image for fact ${factId}, gender=${targetGender}${options?.modelOverride ? ` (model override: ${options.modelOverride})` : ""}`);
    const storedPath = await generateAndStoreImageFromReference(factId, targetGender, uniqueKey, prompt, referenceBuffer, options?.modelOverride, options?.paramsOverride);

    // Track only in user_ai_images (type='reference') — NOT in the shared aiMemeImages on the fact
    try {
      await trackUserAiImage(options.userId, factId, targetGender, storedPath, "reference");
    } catch (trackErr) {
      console.warn(`[aiMemePipeline] Failed to track reference image for user ${options.userId}:`, trackErr);
    }

    console.log(`[aiMemePipeline] fact ${factId}: reference-based AI image stored for user ${options.userId} (gender=${targetGender})`);
  } catch (err) {
    console.error(`[aiMemePipeline] Reference generation failed for fact ${factId}:`, err);
    if (!options?.suppressErrors) throw err;
  }
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
     * ID of the premium user triggering the generation.
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
      console.log(`[aiMemePipeline] Generating scene prompts for fact ${factId}`);
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
      console.log(`[aiMemePipeline] Generating image for fact ${factId}, gender=${gender}, key=${uniqueKey}${options?.modelOverride ? ` (model override: ${options.modelOverride})` : ""}`);
      const storedPath = await generateAndStoreImage(factId, gender, uniqueKey, prompt, options?.modelOverride, options?.paramsOverride);
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
          console.warn(`[aiMemePipeline] Failed to track user image for ${userId}:`, trackErr);
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
    console.log(`[aiMemePipeline] fact ${factId}: ${totalImages} AI meme images stored (scope=${scope})`);
  } catch (err) {
    console.error(`[aiMemePipeline] Failed for fact ${factId}:`, err);
    if (!options?.suppressErrors) throw err;
  }
}
