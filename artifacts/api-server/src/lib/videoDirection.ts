/**
 * AI Video Style Prompt generation configuration + generator.
 *
 * This is the video counterpart to the AI Image Style Prompt
 * (lib/scenePromptConfig.ts) and works the same way: an OpenAI call turns the
 * fact into a cinematic scene/style prompt, which is then merged with a second,
 * separate layer before being sent to fal.ai. For images that second layer is
 * the look-style suffix; for video it is the motion preset (camera/movement)
 * the user selects, appended in videoPipelineRunner.runStage2.
 *
 * The levers (system prompt, model, temperature, max tokens) live in
 * admin_config, resolve through the standard debug overlay, and are tuned from
 * the AI Style Prompt Configuration panel on the admin config page.
 *
 * NOTE: the config keys keep their original `video_direction_*` names so the
 * already-seeded production rows (and any admin edits) carry over — only the
 * human-facing labels and the generated content changed.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getOpenAIClient } from "@workspace/integrations-openai-ai-server";
import { getConfigString, getConfigFloat, getConfigInt } from "./adminConfig";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────────

export const VIDEO_DIRECTION_CONFIG_KEYS = {
  system: "video_direction_system",
  model: "video_direction_model",
  temperature: "video_direction_temperature",
  maxTokens: "video_direction_max_tokens",
} as const;

// ─── Production defaults ─────────────────────────────────────────────────────

export const VIDEO_DIRECTION_SYSTEM_DEFAULT = `You write a cinematic scene description for an AI video generator. The output is a dramatic, photo-real scene for a short video built around an over-the-top "fact" about a person.

You are given a personalized fact that may contain a name and pronouns. Treat it as one subject person and describe what is actually happening in the fact — play even absurd, exaggerated, or physically impossible claims completely straight and depict them literally.

Describe the LITERAL content of the fact: the subject, what they are doing, the setting, and the key objects/characters/animals that make the joke land. Never default to a generic gym or studio portrait unless the fact is actually about that.

Your description must:
- depict the fact's actual subject and setting
- use dramatic lighting, high contrast, and a cinematic, photo-real quality
- contain NO text, letters, words, captions, watermarks, or logos
- be 25-45 words
- begin with "Cinematic", "Epic", or "Dramatic"

Do NOT include camera directions, shot types, lens, motion, or aspect-ratio notes — movement is added separately from the chosen motion preset.

Output the plain scene description only: no quotes, labels, or JSON.`;

/**
 * The original motion-only default this generator shipped with. Retained ONLY
 * so seeding can migrate an unmodified production row to the new scene/style
 * default above without clobbering an admin's customized prompt.
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

// ─── Getter (debug-overlay aware via adminConfig) ─────────────────────────────

export interface VideoDirectionGenerationConfig {
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** Resolve the OpenAI generation settings for video-direction generation. */
export async function getVideoDirectionGenerationConfig(): Promise<VideoDirectionGenerationConfig> {
  const [systemPrompt, model, temperature, maxTokens] = await Promise.all([
    getConfigString(VIDEO_DIRECTION_CONFIG_KEYS.system, VIDEO_DIRECTION_SYSTEM_DEFAULT),
    getConfigString(VIDEO_DIRECTION_CONFIG_KEYS.model, VIDEO_DIRECTION_MODEL_DEFAULT),
    getConfigFloat(VIDEO_DIRECTION_CONFIG_KEYS.temperature, VIDEO_DIRECTION_TEMPERATURE_DEFAULT),
    getConfigInt(VIDEO_DIRECTION_CONFIG_KEYS.maxTokens, VIDEO_DIRECTION_MAX_TOKENS_DEFAULT),
  ]);
  return { systemPrompt, model, temperature, maxTokens };
}

// ─── Generator ─────────────────────────────────────────────────────────────────

/**
 * Generate a short motion/action direction from the fact text. Returns "" when
 * the fact text is blank so the caller can fall back to the motion preset alone.
 */
export async function generateVideoDirection(factText: string): Promise<string> {
  const trimmed = factText?.trim() ?? "";
  if (!trimmed) return "";

  const openai = getOpenAIClient();
  const { systemPrompt, model, temperature, maxTokens } = await getVideoDirectionGenerationConfig();
  const response = await openai.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Fact: "${trimmed}"` },
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
    label: "AI Video Style Prompt — System Prompt",
    description: "OpenAI system prompt that turns a fact into the scene/style prompt used for AI video generation. The motion preset the user selects is appended for movement.",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.model,
    value: VIDEO_DIRECTION_MODEL_DEFAULT,
    dataType: "string",
    label: "AI Video Style Prompt — OpenAI Model",
    description: "OpenAI chat model used to generate the video style prompt (e.g. gpt-4o-mini, gpt-4o).",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.temperature,
    value: String(VIDEO_DIRECTION_TEMPERATURE_DEFAULT),
    dataType: "string",
    label: "AI Video Style Prompt — Temperature",
    description: "Sampling temperature for video style-prompt generation (0–2). Higher = more varied.",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.maxTokens,
    value: String(VIDEO_DIRECTION_MAX_TOKENS_DEFAULT),
    dataType: "integer",
    label: "AI Video Style Prompt — Max Tokens",
    description: "Maximum tokens for the generated video style-prompt text.",
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

  // One-time content migration: this generator originally produced a motion-only
  // direction. It now produces a full scene/style prompt (mirroring the image
  // style prompt). Promote a row that still holds the unmodified legacy default
  // to the new default; rows an admin has edited are left as-is.
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
