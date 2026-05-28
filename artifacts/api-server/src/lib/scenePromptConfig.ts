/**
 * AI Image Style Prompt configuration.
 *
 * The system prompt that controls how the LLM turns a fact template into the
 * scene prompts used for AI image generation. It lives in `admin_config` so it
 * can be tuned from the workbench without a deploy, and resolves through the
 * standard debug overlay (a key's `debug_value` wins when `debug_mode_active`).
 *
 * The model + sampling are NOT configured here — they come from the shared
 * General Intelligence engine (see lib/utilityLLM.ts / /admin/engines).
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString } from "./adminConfig";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────────

export const SCENE_PROMPT_CONFIG_KEYS = {
  system: "scene_prompt_system",
} as const;

// ─── Production default ───────────────────────────────────────────────────────

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

// ─── Getter (debug-overlay aware via adminConfig) ─────────────────────────────

/** Resolve the admin-configurable image style-prompt system prompt. */
export async function getScenePromptSystem(): Promise<string> {
  return getConfigString(SCENE_PROMPT_CONFIG_KEYS.system, SCENE_PROMPT_SYSTEM_DEFAULT);
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
    description: "LLM system prompt that turns a fact template into the scene prompts used for AI image generation. Must still return JSON with fact_type/male/female/neutral. The model + sampling come from the General Intelligence engine.",
  },
];

/**
 * Idempotently seed the image style-prompt system prompt with its production
 * default. Safe to call on every boot — existing rows (including admin edits)
 * are left untouched via ON CONFLICT DO NOTHING.
 */
export async function seedScenePromptConfig(): Promise<void> {
  for (const def of SCENE_PROMPT_CONFIG_DEFS) {
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
      logger.warn({ err, key: def.key }, "[scenePromptConfig] seed failed for key");
    }
  }
}
