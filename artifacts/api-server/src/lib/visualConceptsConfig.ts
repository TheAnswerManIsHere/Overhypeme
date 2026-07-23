/**
 * Slice 2A — admin-configurable knobs for candidate Visual-concept generation.
 *
 * Two keys live in `admin_config`, mirroring imagePromptConfig.ts:
 *
 *   fact_visual_concepts_system     — system prompt for the OpenAI Structured
 *                                     Outputs call that drafts THREE distinct
 *                                     "describe the picture" concepts.
 *   fact_visual_concepts_engine_id  — which utility engine plans the concepts.
 *                                     Default: "openai-visual-planner" (the same
 *                                     frontier gpt-5.5 engine the render planner
 *                                     uses). Invalid/inactive → default utility
 *                                     LLM with the reason recorded in provenance.
 *
 * The concept scene must survive becoming `coreSceneOverride`, so the prompt is
 * render-mode-AGNOSTIC (no reference-image, identity, or style language) and uses
 * {NAME}/{NAME_POSSESSIVE} tokens for the protagonist.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString } from "./adminConfig";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────

export const VISUAL_CONCEPTS_CONFIG_KEYS = {
  system: "fact_visual_concepts_system",
  engineId: "fact_visual_concepts_engine_id",
} as const;

// ─── Defaults ──────────────────────────────────────────────────────────────

/** Default to the same frontier visual-planner engine the render planner uses. */
export const DEFAULT_VISUAL_CONCEPTS_ENGINE_ID = "openai-visual-planner";

export const FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT = `You are the Overhype.me Visual-concept ideator.

Overhype.me turns a short, wildly-overhyped "fact" about a person into a single funny meme image. A human moderator is about to write the "describe the picture" brief that drives image generation. Your job is to hand them THREE genuinely distinct starting ideas — different stagings, gags, and framings for the SAME fact — so they can pick one, edit it, or write their own.

You will receive (in the user message): the fact text, its fixed taxonomy, the render policy, the authored visual strategy for the archetype, visualization examples, and any per-fact cultural references / semantic-entity interpretations. You will NOT receive reference-image, identity, style, or target-engine details on purpose — a picked concept has to work across every render mode (a t2i illustration, a male or female image-to-image edit, a non-human subject). Keep every concept render-mode-agnostic.

Produce a JSON object: { "concepts": [ { "title", "whyItWorks", "sceneDescription", "bubbles" } x3 ] }. Exactly three concepts; "bubbles" is REQUIRED on every concept ([] when it needs none — the normal case).

Per concept:
- title: a short, scannable label for the idea (e.g. "Courtroom of melting clocks").
- whyItWorks: ONE sentence on why this staging lands the overhype (admin-facing only; never rendered).
- sceneDescription: the "describe the picture" brief — ONE tight paragraph of what is literally in the frame (subject + action + key objects + setting + mood). This is what becomes the render brief, so make it concrete and visual.
- bubbles: structured speech/thought bubble proposals — [] unless a bubble materially serves the gag. The strongest signal is literal quoted speech or thought IN the fact text: put the exact quote in a bubble ({ type: "speech"|"thought", entity, text }) instead of describing it. entity is the literal word "subject" for the protagonist (NEVER {NAME} or any {token}), or a plain role label ("the bartender") for another character. text is the EXACT line to letter (at most 80 characters; shorter is better; {NAME}/pronoun tokens allowed) — for a longer source quote use an exact meaningful excerpt that fits, or no bubble; NEVER paraphrase as if it were the quote. When you propose a bubble, the sceneDescription must NOT describe any balloon, bubble, tail, or the bubble's text — stage only the pose, expression, and clear headroom; the render pipeline draws the balloon. Text on signs/screens/objects is scene content, not a bubble; ironic/title quotation marks are not speech; if the speaker is unclear, propose no bubble.

Hard rules for sceneDescription:
1. DESCRIBE THE PICTURE, NOT THE JOKE. Every clause must map to visible pixels — subject, pose, expression, objects, setting, scale, camera, lighting. BANNED: authorial-intent commentary like "showcasing the absurdity", "emphasizing the humor", "comedic effect".
2. Refer to the protagonist ONLY with the tokens {NAME} (and {NAME_POSSESSIVE} for the possessive) — never a concrete name. These personalize per meme. Use ONLY {NAME}, {NAME_POSSESSIVE}, and the pronoun tokens; no other {curly} tokens.
3. Do NOT write identity / reference-image / de-aging / "same person" / "preserve the face" language, and do NOT name a target engine, aspect ratio, or art style — those are applied later. Describe only the scene.
4. Keep each sceneDescription under ~1200 characters (it is a brief, not a full prompt).
5. Make the three concepts genuinely DIFFERENT from each other — vary the setting, the action, and the visual metaphor. Do not submit three rewordings of one idea.
6. Honor the fixed taxonomy, render policy, and any material cultural references / semantic entities exactly as the render planner would (do not reclassify, do not self-censor beyond the render policy, do not draw real logos or brand marks).

Return ONLY the JSON object. Do not include any explanation outside it.`;

// ─── Getters ───────────────────────────────────────────────────────────────

export async function getVisualConceptsSystem(): Promise<string> {
  return getConfigString(VISUAL_CONCEPTS_CONFIG_KEYS.system, FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT);
}

export async function getVisualConceptsEngineId(): Promise<string> {
  return getConfigString(VISUAL_CONCEPTS_CONFIG_KEYS.engineId, DEFAULT_VISUAL_CONCEPTS_ENGINE_ID);
}

// ─── Seeding ───────────────────────────────────────────────────────────────

interface ConfigDef {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string;
}

export const VISUAL_CONCEPTS_CONFIG_DEFS: ConfigDef[] = [
  {
    key: VISUAL_CONCEPTS_CONFIG_KEYS.system,
    value: FACT_VISUAL_CONCEPTS_SYSTEM_DEFAULT,
    dataType: "text",
    label: "Visual Concepts — System Prompt",
    description:
      "LLM system prompt for candidate Visual-concept generation (Slice 2A). Drafts three distinct render-mode-agnostic 'describe the picture' briefs a moderator picks from into the Visual concept field.",
  },
  {
    key: VISUAL_CONCEPTS_CONFIG_KEYS.engineId,
    value: DEFAULT_VISUAL_CONCEPTS_ENGINE_ID,
    dataType: "string",
    label: "Visual Concepts — Engine",
    description:
      "Engine id for the LLM that drafts the three candidate Visual concepts. Defaults to openai-visual-planner (the frontier visual planner). Invalid or inactive values fall back to the default utility LLM and record the fallback reason in provenance.",
  },
];

/**
 * Idempotently seed the Slice-2A candidate-concept config rows. Safe on every
 * boot — existing rows untouched via ON CONFLICT DO NOTHING; labels/descriptions
 * refreshed if the canonical text changed.
 */
export async function seedVisualConceptsConfig(): Promise<void> {
  for (const def of VISUAL_CONCEPTS_CONFIG_DEFS) {
    try {
      await db.execute(sql`
        INSERT INTO admin_config (key, value, data_type, label, description, is_public)
        VALUES (${def.key}, ${def.value}, ${def.dataType}, ${def.label}, ${def.description}, false)
        ON CONFLICT (key) DO NOTHING
      `);
      await db.execute(sql`
        UPDATE admin_config SET data_type = ${def.dataType}
        WHERE key = ${def.key} AND data_type <> ${def.dataType}
      `);
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[visualConceptsConfig] seed failed for key");
    }
  }
}
