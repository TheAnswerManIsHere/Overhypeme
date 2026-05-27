/**
 * AI Video Motion Prompt generation configuration + generator.
 *
 * The video counterpart to the AI Image Style Prompt (lib/scenePromptConfig.ts).
 * Image-to-video animates an already-rendered still, so this is a VISION call:
 * the LLM is shown the source image (ground truth for what exists in the frame)
 * plus the fact, and returns MOTION-ONLY direction. It runs once per VIDEO
 * RENDER. The chosen motion preset (camera) is appended afterwards in
 * videoPipelineRunner.runStage2.
 *
 * Only the system prompt lives in admin_config here (debug-overlay aware). The
 * model + sampling come from the shared General Intelligence engine
 * (lib/utilityLLM.ts / /admin/engines) — which must be vision-capable.
 */

import type OpenAI from "openai";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString } from "./adminConfig";
import { callUtilityLLM } from "./utilityLLM";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────────

export const VIDEO_DIRECTION_CONFIG_KEYS = {
  system: "video_direction_system",
} as const;

// ─── Production default ───────────────────────────────────────────────────────

export const VIDEO_DIRECTION_SYSTEM_DEFAULT = `You write motion instructions for an AI image-to-video generator. You are given two things:

1. An IMAGE — the rendered scene that will be animated. Treat it as ground truth for what exists, where everything is, what it looks like, the lighting, and the mood. None of that needs to be in your output; the video model already sees it.

2. A FACT — an over-the-top claim about the person in the image. They are the subject. The fact is the joke. Your output animates the joke.

# Your task

Look at the image first. Identify the subject, any other people, any animals, any key objects, and the environment. Then read the fact and decide what motion over the next 5–8 seconds will land the joke for someone watching this animate.

Write a short motion description — plain prose, 30–60 words, no labels, no JSON, no formatting. The video model reads it as direction.

# What to describe

- **Subject action.** What the person in the fact does in this beat. ONE deliberate action. Calm restraint reads more powerful than visible effort — "pokes the fire and leans back," "exhales slowly," "lifts a single finger," "tilts their head." If the fact claims they do something impossible, they perform the smallest motion that triggers the outcome. The world does the work.

- **World reaction.** What the other elements visible in the image do in response. ONE clear, readable motion — bears strain and glance nervously, a wolf flinches and backs away, a crowd freezes mid-cheer, a wave curls back, soldiers lower their rifles. Their effort is visible. The subject's is not. This contrast is how the viewer reads the subject's power.

- **Ambient motion.** One environmental element that moves on its own — embers rising, smoke curling, dust drifting, breath fogging, rain falling, a flag stirring, leaves spinning. Pick something consistent with what you see in the image.

If the action requires a sequence, write it in clear order using "then" or commas. Keep it to one or two beats — i2v models lose coherence past that.

# What NOT to describe

- Anything visible in the image — the setting, the lighting, the mood, the style, what people or animals look like, what they're wearing. Repeating this fights the image.
- Anything NOT visible in the image. If there are two bears in the frame, don't prompt motion for a third. If the subject isn't holding a rope, don't have them tug one. The model cannot create new elements without producing morphing artifacts — it tries, badly.
- Cinematic openers ("Cinematic," "Epic," "Dramatic," "A shot of," "We see") — these read as scene direction and confuse i2v models, especially Veo.
- Camera moves, lens choices, shot types, angles — handled separately.
- Adjective stacks describing characters ("bears clad in tiny hiking gear," "warriors dressed as kings") — these trigger Veo's safety filters by creating novel concept combinations the filter can't classify. Describe what things DO, not how they look.
- Dialogue, speech, captions, or any text content.

# Style

Concrete verbs. Active voice. Present tense. Specific over general — "the bears strain to haul a food sack up the pine branch" beats "the bears do something with food." Plain English, not film-school vocabulary.

Output the motion description only. No preamble, no explanation.`;

/**
 * The original text-only motion default this generator shipped with. Retained
 * ONLY so seeding can migrate an unmodified production row to the new
 * image-grounded default above without clobbering an admin's customized prompt.
 */
export const VIDEO_DIRECTION_SYSTEM_LEGACY_DEFAULT = `You write a short motion direction for an AI image-to-video generator. The output animates an over-the-top "fact" about a person.

A still image of the scene ALREADY EXISTS, so do NOT re-describe the setting, the subject's appearance, or the visual style — that is already locked in by the image. Treat any tokens like {NAME}, {SUBJ}, {OBJ}, {POSS} as one subject person and ignore the literal token text.

Your job: describe ONLY what should move and happen over the next few seconds to bring the fact to life — the subject's action, the motion of the key objects/animals/people/elements, and atmospheric dynamics (wind, fire, water, smoke, crowd, light).

Rules:
- 1-2 sentences, 40 words max.
- Describe present, continuous motion and action only.
- Do NOT include camera directions, shot types, lens, or aspect-ratio notes — those are added separately.
- Output the plain direction text only: no quotes, labels, or JSON.`;

// ─── Getter (debug-overlay aware via adminConfig) ─────────────────────────────

/** Resolve the admin-configurable video motion-prompt system prompt. */
export async function getVideoDirectionSystem(): Promise<string> {
  return getConfigString(VIDEO_DIRECTION_CONFIG_KEYS.system, VIDEO_DIRECTION_SYSTEM_DEFAULT);
}

// ─── Generator ─────────────────────────────────────────────────────────────────

/**
 * Generate motion direction for image-to-video. The model is shown the SOURCE
 * IMAGE that will be animated (so it only animates elements that actually exist
 * in the frame) plus the fact. Returns "" when the fact text is blank so the
 * caller can fall back to the motion preset alone.
 *
 * `imageUrl` must be a URL the vision model can fetch (e.g. the fal CDN URL of
 * the uploaded still). When null/empty the call degrades to text-only. The
 * model + sampling come from the General Intelligence engine (must be vision-
 * capable; the gpt-4o / 4.1 default family is).
 */
export async function generateVideoDirection(
  factText: string,
  imageUrl?: string | null,
): Promise<string> {
  const trimmed = factText?.trim() ?? "";
  if (!trimmed) return "";

  const systemPrompt = await getVideoDirectionSystem();
  const url = imageUrl?.trim() ?? "";
  const userContent: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] = url
    ? [
        { type: "text", text: `Fact: "${trimmed}"` },
        { type: "image_url", image_url: { url } },
      ]
    : `Fact: "${trimmed}"`;
  const response = await callUtilityLLM({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return (response.choices[0]?.message?.content ?? "").trim();
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

interface VideoDirectionConfigDef {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string;
}

export const VIDEO_DIRECTION_CONFIG_DEFS: VideoDirectionConfigDef[] = [
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.system,
    value: VIDEO_DIRECTION_SYSTEM_DEFAULT,
    // "text" renders as a multi-line textarea in the workbench (vs a single-line input).
    dataType: "text",
    label: "AI Video Motion Prompt — System Prompt",
    description: "LLM system prompt for image-to-video. The model is shown the source still (vision) plus the fact and returns motion-only direction; the motion preset the user selects is appended for camera. Output a single plain-text description — no JSON, and do NOT re-describe the scene or add elements not in the image. The model + sampling come from the General Intelligence engine (must be vision-capable).",
  },
];

/**
 * Idempotently seed the video motion-prompt system prompt with its production
 * default. Safe to call on every boot — admin-customized values are left
 * untouched via ON CONFLICT DO NOTHING (and the legacy-default migration below
 * only fires on a row that still holds the original motion-only prompt).
 */
export async function seedVideoDirectionConfig(): Promise<void> {
  for (const def of VIDEO_DIRECTION_CONFIG_DEFS) {
    try {
      await db.execute(sql`
        INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES (${def.key}, ${def.value}, ${def.dataType}, ${def.label}, ${def.description}, false)
        ON CONFLICT (key) DO NOTHING
      `);
      if (def.dataType === "text") {
        await db.execute(sql`
          UPDATE admin_config SET data_type = 'text'
          WHERE key = ${def.key} AND data_type <> 'text'
        `);
      }
      // Labels/descriptions are code-owned — force them to the current copy.
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[videoDirection] seed failed for key");
    }
  }

  // One-time content migration: promote a row that still holds the unmodified
  // legacy text-only default to the new image-grounded default; rows an admin
  // has edited are left as-is.
  try {
    await db.execute(sql`
      UPDATE admin_config SET value = ${VIDEO_DIRECTION_SYSTEM_DEFAULT}
      WHERE key = ${VIDEO_DIRECTION_CONFIG_KEYS.system}
        AND value = ${VIDEO_DIRECTION_SYSTEM_LEGACY_DEFAULT}
    `);
  } catch (err) {
    logger.warn({ err }, "[videoDirection] legacy system-prompt migration failed");
  }
}
