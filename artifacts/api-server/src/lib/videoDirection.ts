/**
 * AI Video Motion Prompt generation configuration + generator.
 *
 * The video counterpart to the AI Image Style Prompt (lib/scenePromptConfig.ts),
 * but it is NOT text-only and NOT run per fact. Image-to-video animates an
 * already-rendered still, so this is a VISION call: OpenAI is shown the source
 * image (ground truth for what exists in the frame) plus the fact, and returns
 * MOTION-ONLY direction — what the subject/world/ambient elements do — never a
 * re-description of the scene and never new elements (which would morph or trip
 * Veo's safety filter). Because it depends on the specific still, it runs once
 * per VIDEO RENDER, not once per fact. The chosen motion preset (camera) is
 * appended afterwards in videoPipelineRunner.runStage2.
 *
 * The levers (system prompt, model, temperature, max tokens) live in
 * admin_config, resolve through the standard debug overlay, and are tuned from
 * the AI Style Prompt Configuration panel on the admin config page. The model
 * must be vision-capable (the GPT-4o / 4.1 families all are).
 *
 * NOTE: the config keys keep their original `video_direction_*` names so the
 * already-seeded production rows (and any admin edits) carry over — only the
 * human-facing labels and the generated content changed.
 */

import type OpenAI from "openai";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { getConfigString, getConfigFloat, getConfigInt } from "./adminConfig";
import { chatModelTuningParams } from "./openaiChatParams";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────────

export const VIDEO_DIRECTION_CONFIG_KEYS = {
  system: "video_direction_system",
  model: "video_direction_model",
  temperature: "video_direction_temperature",
  maxTokens: "video_direction_max_tokens",
  reasoningEffort: "video_direction_reasoning_effort",
} as const;

// ─── Production defaults ─────────────────────────────────────────────────────

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

export const VIDEO_DIRECTION_MODEL_DEFAULT = "gpt-4o-mini";
export const VIDEO_DIRECTION_TEMPERATURE_DEFAULT = 0.7;
export const VIDEO_DIRECTION_MAX_TOKENS_DEFAULT = 200;
/** Reasoning effort for gpt-5/o-series models (ignored by gpt-4.x). */
export const VIDEO_DIRECTION_REASONING_EFFORT_DEFAULT = "low";

// ─── Getter (debug-overlay aware via adminConfig) ─────────────────────────────

export interface VideoDirectionGenerationConfig {
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: string;
}

/** Resolve the OpenAI generation settings for video-direction generation. */
export async function getVideoDirectionGenerationConfig(): Promise<VideoDirectionGenerationConfig> {
  const [systemPrompt, model, temperature, maxTokens, reasoningEffort] = await Promise.all([
    getConfigString(VIDEO_DIRECTION_CONFIG_KEYS.system, VIDEO_DIRECTION_SYSTEM_DEFAULT),
    getConfigString(VIDEO_DIRECTION_CONFIG_KEYS.model, VIDEO_DIRECTION_MODEL_DEFAULT),
    getConfigFloat(VIDEO_DIRECTION_CONFIG_KEYS.temperature, VIDEO_DIRECTION_TEMPERATURE_DEFAULT),
    getConfigInt(VIDEO_DIRECTION_CONFIG_KEYS.maxTokens, VIDEO_DIRECTION_MAX_TOKENS_DEFAULT),
    getConfigString(VIDEO_DIRECTION_CONFIG_KEYS.reasoningEffort, VIDEO_DIRECTION_REASONING_EFFORT_DEFAULT),
  ]);
  return { systemPrompt, model, temperature, maxTokens, reasoningEffort };
}

// ─── Generator ─────────────────────────────────────────────────────────────────

/**
 * Generate motion direction for image-to-video. The model is shown the SOURCE
 * IMAGE that will be animated (so it only animates elements that actually exist
 * in the frame) plus the fact. Returns "" when the fact text is blank so the
 * caller can fall back to the motion preset alone.
 *
 * `imageUrl` must be a URL the OpenAI vision model can fetch (e.g. the fal CDN
 * URL of the uploaded still). When null/empty the call degrades to text-only.
 */
export async function generateVideoDirection(
  factText: string,
  imageUrl?: string | null,
): Promise<string> {
  const trimmed = factText?.trim() ?? "";
  if (!trimmed) return "";

  const openai = getOpenAIClient();
  const { systemPrompt, model, temperature, maxTokens, reasoningEffort } = await getVideoDirectionGenerationConfig();
  const url = imageUrl?.trim() ?? "";
  const userContent: string | OpenAI.Chat.Completions.ChatCompletionContentPart[] = url
    ? [
        { type: "text", text: `Fact: "${trimmed}"` },
        { type: "image_url", image_url: { url } },
      ]
    : `Fact: "${trimmed}"`;
  const response = await openai.chat.completions.create({
    model,
    ...chatModelTuningParams({ model, maxTokens, temperature, reasoningEffort }),
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
    description: "OpenAI system prompt for image-to-video. The model is shown the source still (vision) plus the fact and returns motion-only direction; the motion preset the user selects is appended for camera. Output a single plain-text description — no JSON, no gender variants, and do NOT re-describe the scene or add elements not in the image.",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.model,
    value: VIDEO_DIRECTION_MODEL_DEFAULT,
    dataType: "string",
    label: "AI Video Motion Prompt — OpenAI Model",
    description: "Vision-capable OpenAI model used to generate the video motion direction from the source image (e.g. gpt-4o-mini, gpt-4o).",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.temperature,
    value: String(VIDEO_DIRECTION_TEMPERATURE_DEFAULT),
    dataType: "string",
    label: "AI Video Motion Prompt — Temperature",
    description: "Sampling temperature for video motion-prompt generation (0–2). Higher = more varied.",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.maxTokens,
    value: String(VIDEO_DIRECTION_MAX_TOKENS_DEFAULT),
    dataType: "integer",
    label: "AI Video Motion Prompt — Max Tokens",
    description: "Maximum tokens for the generated video motion-direction text (visible output; reasoning models get extra headroom on top).",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.reasoningEffort,
    value: VIDEO_DIRECTION_REASONING_EFFORT_DEFAULT,
    dataType: "string",
    label: "AI Video Motion Prompt — Reasoning Effort",
    description: "Reasoning effort for GPT-5 / o-series models (none/low/medium/high). Higher = more capable but more tokens/cost. Ignored by GPT-4.x models.",
  },
];

/**
 * Idempotently seed the video style-prompt config rows with their production
 * defaults. Safe to call on every boot — admin-customized values are left
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
      // Backfill data_type for rows seeded before these keys became multi-line
      // textareas (idempotent — only touches stale rows).
      if (def.dataType === "text") {
        await db.execute(sql`
          UPDATE admin_config SET data_type = 'text'
          WHERE key = ${def.key} AND data_type <> 'text'
        `);
      }
      // Labels/descriptions are code-owned (not admin-editable), so force them
      // to the current copy. Brings rows seeded under the old "Video Prompt"
      // naming up to the "AI Video Style Prompt" naming (idempotent).
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[videoDirection] seed failed for key");
    }
  }

  // One-time content migration: this generator originally produced a text-only
  // motion direction. It now produces image-grounded motion direction (vision).
  // Promote a row that still holds the unmodified legacy default to the new
  // default; rows an admin has edited are left as-is.
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
