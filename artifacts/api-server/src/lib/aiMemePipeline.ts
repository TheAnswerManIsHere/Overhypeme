/**
 * AI Meme Pipeline
 *
 * 1. Calls gpt-4o-mini to generate three scene prompt variants (male/female/neutral).
 * 2. Calls OpenAI Images API (gpt-image-1, low quality, 1024x1024) to generate
 *    3 images per gender variant = 9 images total.
 * 3. Saves each PNG to object storage and persists the paths on the fact record.
 *
 * Runs async (non-blocking) — callers fire-and-forget with void.
 * Should never throw — catches all errors internally.
 */

import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { toFile } from "openai/core/uploads";
import { ObjectStorageService } from "./objectStorage";
import { db } from "@workspace/db";
import { factsTable, userAiImagesTable } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";
import { getConfigInt, getConfigString } from "./adminConfig";

const DEFAULT_REFERENCE_FRAME_PROMPT =
  "Generate an image using the provided reference photo. The person's face, facial structure, skin tone, eye shape, hair, and all distinguishing features must be preserved with photorealistic accuracy and remain visually identical to the reference — this is the highest priority. Do not alter, stylize, or idealize the person's facial features in any way. The person should be placed into the scene as described. The scene and environment should be stylized as described, but the person's face and likeness must remain untouched by any stylization. No text, words, or letters anywhere in the image.";

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

// ─── LLM scene prompt generation ──────────────────────────────────────────────

const SCENE_PROMPT_SYSTEM = `You generate cinematic scene prompts for AI image generation for meme backgrounds.

Given a personalized fact template (using tokens like {NAME}, {SUBJ}, {OBJ}, {POSS}), produce three scene prompts for DALL-E style image generation.

Rules:
1. Classify the fact:
   - "action" = a person doing something physical, social, or occupational
   - "abstract" = cosmic, metaphysical, or impossible to photograph
2. For "action" facts: produce 3 different prompts (male, female, neutral subject).
   For "abstract" facts: all 3 prompts can be identical dramatic cinematic scenes.
3. Each prompt must:
   - Describe a SQUARE 1024x1024 cinematic scene
   - Have dramatic lighting, high contrast, cinematic quality
   - NOT contain any text or letters
   - Be 20-40 words
   - Start with "Cinematic " or "Epic " or "Dramatic "

Return ONLY valid JSON:
{"fact_type":"action","male":"Cinematic shot of a muscular man...","female":"Cinematic shot of a strong woman...","neutral":"Dramatic scene of a person..."}`;

async function generateScenePrompts(factText: string): Promise<AiScenePrompts> {
  const openai = getOpenAIClient();
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 400,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SCENE_PROMPT_SYSTEM },
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

async function generateAndStoreImage(
  factId: number,
  gender: "male" | "female" | "neutral",
  uniqueKey: string,
  prompt: string,
): Promise<string> {
  const openai = getOpenAIClient();

  const response = await (openai.images.generate as Function)({
    model: "gpt-image-1",
    prompt,
    n: 1,
    size: "1024x1024",
    quality: "low",
    output_format: "png",
  });

  const imageData = response.data?.[0];
  if (!imageData) throw new Error("No image data returned from OpenAI");

  let imageBuffer: Buffer;
  if (imageData.b64_json) {
    imageBuffer = Buffer.from(imageData.b64_json, "base64");
  } else if (imageData.url) {
    const imgRes = await fetch(imageData.url);
    if (!imgRes.ok) throw new Error(`Failed to fetch image from URL: ${imgRes.status}`);
    imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error("No image URL or b64_json in response");
  }

  const subPath = `ai_meme_${factId}_${gender}_${uniqueKey}.png`;
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType: "image/png",
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
 * Generates a single AI image using openai.images.edit with a reference photo.
 * The reference photo is stylized into a cinematic meme background matching the scene prompt.
 */
async function generateAndStoreImageFromReference(
  factId: number,
  gender: "male" | "female" | "neutral",
  uniqueKey: string,
  prompt: string,
  referenceBuffer: Buffer,
  includeReferenceFrame: boolean,
): Promise<string> {
  const openai = getOpenAIClient();

  // Uploads stored via /storage/upload-meme are always JPEG
  const referenceFile = await toFile(referenceBuffer, "reference.jpg", { type: "image/jpeg" });

  const referenceFramePrompt = await getConfigString(
    "ai_reference_frame_prompt",
    DEFAULT_REFERENCE_FRAME_PROMPT,
  );
  const editPrompt = includeReferenceFrame
    ? `${referenceFramePrompt} ${prompt}`
    : prompt;

  const response = await (openai.images.edit as Function)({
    model: "gpt-image-1",
    image: referenceFile,
    prompt: editPrompt,
    n: 1,
    size: "1024x1024",
    quality: "low",
    output_format: "png",
  });

  const imageData = response.data?.[0];
  if (!imageData) throw new Error("No image data returned from OpenAI images.edit");

  let imageBuffer: Buffer;
  if (imageData.b64_json) {
    imageBuffer = Buffer.from(imageData.b64_json, "base64");
  } else if (imageData.url) {
    const imgRes = await fetch(imageData.url);
    if (!imgRes.ok) throw new Error(`Failed to fetch image from URL: ${imgRes.status}`);
    imageBuffer = Buffer.from(await imgRes.arrayBuffer());
  } else {
    throw new Error("No image URL or b64_json in response");
  }

  const subPath = `ai_meme_${factId}_${gender}_ref_${uniqueKey}.png`;
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType: "image/png",
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
    console.log(`[aiMemePipeline] Generating reference-based image for fact ${factId}, gender=${targetGender}`);
    const storedPath = await generateAndStoreImageFromReference(factId, targetGender, uniqueKey, prompt, referenceBuffer, true);

    // Track only in user_ai_images (type='reference') — NOT in the shared aiMemeImages on the fact
    try {
      await trackUserAiImage(options.userId, factId, targetGender, storedPath, "reference");
    } catch (trackErr) {
      console.warn(`[aiMemePipeline] Failed to track reference image for user ${options.userId}:`, trackErr);
    }

    console.log(`[aiMemePipeline] fact ${factId}: reference-based AI image stored for user ${options.userId} (gender=${targetGender})`);
  } catch (err) {
    console.error(`[aiMemePipeline] Reference generation failed for fact ${factId}:`, err);
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
      console.log(`[aiMemePipeline] Generating image for fact ${factId}, gender=${gender}, key=${uniqueKey}`);
      const storedPath = await generateAndStoreImage(factId, gender, uniqueKey, prompt);
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
  }
}
