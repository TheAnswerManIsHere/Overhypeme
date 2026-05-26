/**
 * Video-direction generation configuration + generator.
 *
 * Stage 2 of the video pipeline is image-to-video: the still already encodes
 * the scene, subject, composition, and style. The video engine therefore needs
 * a prompt describing what should MOVE and HAPPEN — not a re-description of the
 * static scene. Today it only receives the motion preset (camera/movement),
 * which is scene-blind.
 *
 * This module adds an admin-configurable "video direction" generator: an OpenAI
 * call that turns the fact into a short motion/action description. That
 * direction is then layered on top of the motion preset (see
 * videoPipelineRunner.runStage2) — the preset stays a separate, retained knob.
 *
 * Mirrors lib/scenePromptConfig.ts: the levers live in admin_config, resolve
 * through the standard debug overlay, and are tunable from the workbench.
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

export const VIDEO_DIRECTION_SYSTEM_DEFAULT = `You write a short motion direction for an AI image-to-video generator. The output animates an over-the-top "fact" about a person.

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
    label: "Video Prompt — System Prompt",
    description: "OpenAI system prompt that generates the motion/action direction for image-to-video. Describes what moves; the motion preset (camera) is layered on separately.",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.model,
    value: VIDEO_DIRECTION_MODEL_DEFAULT,
    dataType: "string",
    label: "Video Prompt — OpenAI Model",
    description: "OpenAI chat model used to generate the video motion direction (e.g. gpt-4o-mini, gpt-4o).",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.temperature,
    value: String(VIDEO_DIRECTION_TEMPERATURE_DEFAULT),
    dataType: "string",
    label: "Video Prompt — Temperature",
    description: "Sampling temperature for video-direction generation (0–2). Higher = more varied.",
  },
  {
    key: VIDEO_DIRECTION_CONFIG_KEYS.maxTokens,
    value: String(VIDEO_DIRECTION_MAX_TOKENS_DEFAULT),
    dataType: "integer",
    label: "Video Prompt — Max Tokens",
    description: "Maximum tokens for the generated video-direction text.",
  },
];

/**
 * Idempotently seed the video-direction config rows with their production
 * defaults. Safe to call on every boot — existing rows (including admin edits)
 * are left untouched via ON CONFLICT DO NOTHING.
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
    } catch (err) {
      logger.warn({ err, key: def.key }, "[videoDirection] seed failed for key");
    }
  }
}
