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
import { ObjectStorageService } from "./objectStorage";
import { db } from "@workspace/db";
import { factsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

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

// ─── Image generation ─────────────────────────────────────────────────────────

const objectStorage = new ObjectStorageService();

async function generateAndStoreImage(
  factId: number,
  gender: "male" | "female" | "neutral",
  index: number,
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

  const subPath = `ai_meme_${factId}_${gender}_${index}.png`;
  const storedPath = await objectStorage.uploadObjectBuffer({
    subPath,
    buffer: imageBuffer,
    contentType: "image/png",
  });

  return storedPath;
}

async function generateImagesForFact(
  factId: number,
  prompts: AiScenePrompts,
  existingImages?: AiMemeImages,
  targetGender?: "male" | "female" | "neutral",
  targetIndex?: number,
): Promise<AiMemeImages> {
  const genders: Array<"male" | "female" | "neutral"> = ["male", "female", "neutral"];
  const result: AiMemeImages = {
    male:    [...(existingImages?.male    ?? ["", "", ""])],
    female:  [...(existingImages?.female  ?? ["", "", ""])],
    neutral: [...(existingImages?.neutral ?? ["", "", ""])],
  };

  // Ensure each array has exactly 3 slots
  for (const g of genders) {
    while (result[g].length < 3) result[g].push("");
  }

  for (const gender of genders) {
    for (let i = 0; i < 3; i++) {
      // If targeting a specific gender+index, skip others
      if (targetGender !== undefined && (gender !== targetGender || i !== targetIndex)) continue;

      const prompt = prompts[gender];
      console.log(`[aiMemePipeline] Generating image for fact ${factId}, gender=${gender}, index=${i}`);
      const path = await generateAndStoreImage(factId, gender, i, prompt);
      result[gender][i] = path;
    }
  }

  return result;
}

// ─── Pipeline orchestration ───────────────────────────────────────────────────

/**
 * Generates AI meme backgrounds for a fact.
 * Runs the full pipeline: scene prompts → image generation → persistence.
 * Safe to call fire-and-forget: catches all errors internally.
 */
export async function generateAiMemeBackgrounds(
  factId: number,
  factText: string,
  options?: {
    /** If provided, only regenerate one specific image */
    targetGender?: "male" | "female" | "neutral";
    targetIndex?: number;
    /** If provided, use existing prompts from DB (skip prompt regen) */
    existingPrompts?: AiScenePrompts;
    /** Existing images to preserve when doing partial regen */
    existingImages?: AiMemeImages;
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

    // 2. Generate images
    const images = await generateImagesForFact(
      factId,
      prompts,
      options?.existingImages,
      options?.targetGender,
      options?.targetIndex,
    );

    // 3. Persist image paths
    await db
      .update(factsTable)
      .set({ aiMemeImages: images })
      .where(eq(factsTable.id, factId));

    const totalImages = images.male.filter(Boolean).length +
      images.female.filter(Boolean).length +
      images.neutral.filter(Boolean).length;
    console.log(`[aiMemePipeline] fact ${factId}: ${totalImages} AI meme images generated`);
  } catch (err) {
    console.error(`[aiMemePipeline] Failed for fact ${factId}:`, err);
  }
}
