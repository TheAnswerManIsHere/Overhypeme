/**
 * Scene-prompt generation configuration.
 *
 * These are the "levers" that control how OpenAI turns a fact template into the
 * scene prompts used for AI image generation (text-to-image and image-to-image).
 * They used to be hard-coded constants; they now live in the `admin_config`
 * table so they can be tuned from the workbench without a deploy.
 *
 * Each value resolves through the standard admin_config debug overlay: when
 * `debug_mode_active` is "true", a key's `debug_value` (if set) wins over its
 * `value`. That lets an admin experiment with a candidate prompt in the
 * workbench (debug value), verify it, then promote it to production (value).
 *
 * The constants below are the production defaults — also used as the fallback
 * when a key is missing/blank, and as the seed value written to the DB row.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString, getConfigFloat, getConfigInt } from "./adminConfig";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────────

export const SCENE_PROMPT_CONFIG_KEYS = {
  system: "scene_prompt_system",
  model: "scene_prompt_model",
  temperature: "scene_prompt_temperature",
  maxTokens: "scene_prompt_max_tokens",
} as const;

// ─── Production defaults ─────────────────────────────────────────────────────

export const SCENE_PROMPT_SYSTEM_DEFAULT = `You write cinematic scene descriptions for an AI image generator. The output is a dramatic, photo-real background for a meme built around an over-the-top "fact" about a person.

You are given a personalized fact template that uses tokens like {NAME}, {SUBJ}, {OBJ}, {POSS}. Treat the tokens as one subject person; ignore the literal token text and describe what is actually happening in the fact.

STEP 1 — Classify the fact (the "fact_type" field):
- "action" — the fact can be staged as a real scene: a person doing an activity, in a place, with objects/animals/other people, a sport, a feat, a profession, a social moment, etc. Use this EVEN WHEN the claim is exaggerated, absurd, or physically impossible — you still depict it literally and play it straight. Example: "bears hang their own food high in a tree when {NAME} goes camping" → a moonlit campsite where nervous bears string a food sack up a pine while the person relaxes by the fire.
- "abstract" — ONLY when the fact has no stageable subject, place, or action at all: a purely metaphysical or cosmic claim about willpower, luck, time, probability, reality, etc., with nothing concrete to photograph. Example: "{NAME}'s confidence rewrites the laws of probability." When in doubt, choose "action".

STEP 2 — Write the scene. Describe the LITERAL content of the fact: the subject, what they are doing, the setting, and the key objects/characters/animals that make the joke land. Never default to a generic gym or studio portrait unless the fact is actually about that.
- For "action" facts: write three variants of the SAME scene that differ ONLY in how the subject is rendered — "male" = a man, "female" = a woman, "neutral" = a gender-ambiguous person. Keep the setting, action, and props identical across all three.
- For "abstract" facts: all three may be the same dramatic, symbolic scene.

Every prompt must:
- depict the fact's actual subject and setting
- use dramatic lighting, high contrast, and a cinematic, photo-real quality
- contain NO text, letters, words, captions, watermarks, or logos
- be 25-45 words
- begin with "Cinematic", "Epic", or "Dramatic"

Do not describe the image's shape or aspect ratio — framing is handled separately.

Return ONLY valid JSON in exactly this shape:
{"fact_type":"action","male":"Cinematic ...","female":"Cinematic ...","neutral":"Cinematic ..."}`;

export const SCENE_PROMPT_MODEL_DEFAULT = "gpt-4o-mini";
export const SCENE_PROMPT_TEMPERATURE_DEFAULT = 0.7;
export const SCENE_PROMPT_MAX_TOKENS_DEFAULT = 400;

// ─── Getters (debug-overlay aware via adminConfig) ─────────────────────────────

export interface ScenePromptGenerationConfig {
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

/** Resolve the OpenAI generation settings for scene-prompt generation. */
export async function getScenePromptGenerationConfig(): Promise<ScenePromptGenerationConfig> {
  const [systemPrompt, model, temperature, maxTokens] = await Promise.all([
    getConfigString(SCENE_PROMPT_CONFIG_KEYS.system, SCENE_PROMPT_SYSTEM_DEFAULT),
    getConfigString(SCENE_PROMPT_CONFIG_KEYS.model, SCENE_PROMPT_MODEL_DEFAULT),
    getConfigFloat(SCENE_PROMPT_CONFIG_KEYS.temperature, SCENE_PROMPT_TEMPERATURE_DEFAULT),
    getConfigInt(SCENE_PROMPT_CONFIG_KEYS.maxTokens, SCENE_PROMPT_MAX_TOKENS_DEFAULT),
  ]);
  return { systemPrompt, model, temperature, maxTokens };
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

interface ScenePromptConfigDef {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string;
}

export const SCENE_PROMPT_CONFIG_DEFS: ScenePromptConfigDef[] = [
  {
    key: SCENE_PROMPT_CONFIG_KEYS.system,
    value: SCENE_PROMPT_SYSTEM_DEFAULT,
    // "text" renders as a multi-line textarea in the workbench (vs a single-line input).
    dataType: "text",
    label: "AI Image Style Prompt — System Prompt",
    description: "OpenAI system prompt that turns a fact template into the scene prompts used for AI image generation. Must still return JSON with fact_type/male/female/neutral.",
  },
  {
    key: SCENE_PROMPT_CONFIG_KEYS.model,
    value: SCENE_PROMPT_MODEL_DEFAULT,
    dataType: "string",
    label: "AI Image Style Prompt — OpenAI Model",
    description: "OpenAI chat model used to generate the image scene prompts (e.g. gpt-4o-mini, gpt-4o).",
  },
  {
    key: SCENE_PROMPT_CONFIG_KEYS.temperature,
    value: String(SCENE_PROMPT_TEMPERATURE_DEFAULT),
    dataType: "string",
    label: "AI Image Style Prompt — Temperature",
    description: "Sampling temperature for image scene-prompt generation (0–2). Higher = more varied.",
  },
  {
    key: SCENE_PROMPT_CONFIG_KEYS.maxTokens,
    value: String(SCENE_PROMPT_MAX_TOKENS_DEFAULT),
    dataType: "integer",
    label: "AI Image Style Prompt — Max Tokens",
    description: "Maximum tokens for the generated image scene-prompt JSON response.",
  },
];

/**
 * Idempotently seed the scene-prompt config rows with their production defaults.
 * Safe to call on every boot — existing rows (including admin edits) are left
 * untouched via ON CONFLICT DO NOTHING.
 */
export async function seedScenePromptConfig(): Promise<void> {
  for (const def of SCENE_PROMPT_CONFIG_DEFS) {
    try {
      await db.execute(sql`
        INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES (${def.key}, ${def.value}, ${def.dataType}, ${def.label}, ${def.description}, false)
        ON CONFLICT (key) DO NOTHING
      `);
      // Backfill data_type for rows seeded before these keys became multi-line
      // textareas. INSERT ... ON CONFLICT DO NOTHING leaves existing rows alone,
      // so promote the type explicitly (idempotent — only touches stale rows).
      if (def.dataType === "text") {
        await db.execute(sql`
          UPDATE admin_config SET data_type = 'text'
          WHERE key = ${def.key} AND data_type <> 'text'
        `);
      }
      // Labels/descriptions are code-owned (not admin-editable), so force them
      // to the current copy. Brings rows seeded under the old "Scene Prompt"
      // naming up to the "AI Image Style Prompt" naming (idempotent).
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[scenePromptConfig] seed failed for key");
    }
  }
}
