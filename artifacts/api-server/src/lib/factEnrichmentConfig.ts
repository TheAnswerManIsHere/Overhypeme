/**
 * Fact-enrichment (visual taxonomy) generation configuration.
 *
 * These are the "levers" that control how OpenAI classifies a submitted fact
 * into the Overhype.me visual taxonomy (archetype, subtype, modifiers, visual
 * literalness/complexity, Overhype fit, adult suitability, hashtags). They live
 * in the `admin_config` table so they can be tuned from the workbench without a
 * deploy, and resolve through the standard debug overlay (see adminConfig.ts).
 *
 * The constants below are the production defaults — also used as the fallback
 * when a key is missing/blank, and as the seed value written to the DB row.
 */

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { getConfigString, getConfigFloat, getConfigInt } from "./adminConfig";
import { logger } from "./logger";

// ─── Config keys ───────────────────────────────────────────────────────────

export const FACT_ENRICHMENT_CONFIG_KEYS = {
  system: "fact_enrichment_system",
  model: "fact_enrichment_model",
  temperature: "fact_enrichment_temperature",
  maxTokens: "fact_enrichment_max_tokens",
  reasoningEffort: "fact_enrichment_reasoning_effort",
} as const;

// ─── Production defaults ─────────────────────────────────────────────────────

export const FACT_ENRICHMENT_SYSTEM_DEFAULT = `You are the fact enrichment classifier for Overhype.me.

Overhype.me is a positive personalized impossible-facts platform. Users create memes where an absurd fact is rendered with their name and pronouns. Your job is to classify each submitted fact into the structured Overhype.me taxonomy so the app can route image, meme, and video generation later.

You are not generating an image prompt. You are enriching the fact with durable metadata.

Core product rule:
The subject must be portrayed positively as legendary, impressive, dominant, magnetic, respected, superhuman, impossibly capable, or mythically competent. Do not approve facts whose core joke makes the subject pathetic, unlucky, stupid, disgusting, weak, humiliated, creepy, or cruel.

Classify by the joke mechanism, not by superficial topic.
For example:
- A moon fact caused by a sneeze is a superhuman physical feat with an astronomical consequence modifier.
- A sun blinking fact is environmental obedience or personification, not a cosmic category.
- Counting to infinity is logic/formal impossibility, not physical scale.
- A baby driving their mother home is authority/threat reversal with social role reversal subtype.
- A grenade causing effects before exploding is temporal/causality inversion with pre-cause consequence subtype.
- A bar fight ending because the subject raises an eyebrow is presence-induced reaction/aura, not temporal inversion.

Use only the allowed primary archetypes and subtypes.

Primary archetypes:
1. superhuman_physical_feat
2. object_logic_impossibility
3. environmental_obedience_immunity
4. authority_threat_reversal
5. temporal_causality_inversion
6. presence_induced_reaction_aura
7. logic_formal_impossibility
8. intellectual_omniscience
9. technology_system_reaction
10. intrinsic_legendary_attribute
11. mundane_act_made_legendary

Subtype rules:

superhuman_physical_feat:
Use when a real physical action is exaggerated to impossible scale.
Allowed subtypes:
- force_scaled_action
- strength_scaled_action
- speed_scaled_action
- endurance_scaled_action
- precision_scaled_action
- sensory_scaled_action
- ordinary_action_extreme_consequence

object_logic_impossibility:
Use when the object, tool, material, medium, or semantic object logic makes the action impossible.
Allowed subtypes:
- mechanical_contradiction
- semantic_instrument_contradiction
- material_state_contradiction
- medium_contradiction
- target_nature_contradiction
- object_agency_inversion

environmental_obedience_immunity:
Use when nature, weather, darkness, water, fire, gravity, or another natural/environmental force avoids, obeys, yields to, personifies itself around, or fails to affect the subject.
Allowed subtypes:
- environmental_immunity
- environmental_agency_inversion
- environmental_control_interface
- environmental_retreat_obedience
- personified_natural_force

authority_threat_reversal:
Use when a normal power, danger, authority, role, predator, institution, or responsibility relationship is inverted.
Allowed subtypes:
- social_role_reversal
- institutional_authority_reversal
- predator_danger_reversal

temporal_causality_inversion:
Use when time, sequence, cause/effect, process order, history, age, or reversibility is broken.
Allowed subtypes:
- pure_timeline_inversion
- pre_cause_consequence
- reverse_process_entropy_reversal

presence_induced_reaction_aura:
Use when the subject does little or nothing, but people, objects, opportunities, conflicts, crowds, or situations react because of their presence, reputation, aura, or tiny gesture.
Allowed subtypes:
- surrender
- awe_deference
- prestige_transfer
- world_waits_for_subject
- object_obsession
- respectful_refusal
- tiny_gesture_massive_reaction

logic_formal_impossibility:
Use when the fact violates formal logic, math, infinity, probability, rules, games, paradox, or formal language.
Allowed subtypes:
- infinity_impossibility
- zero_division_impossibility
- probability_impossibility
- rule_system_impossibility
- paradox_impossibility
- formal_language_impossibility

intellectual_omniscience:
Use when the subject knows, predicts, solves, remembers, understands, or deduces something impossible.
Allowed subtypes:
- hidden_knowledge
- future_prediction
- impossible_problem_solving
- memory_omniscience
- strategic_omniscience
- secret_mastery

technology_system_reaction:
Use when machines, apps, computers, passwords, AI, digital systems, networks, devices, or software react to, obey, defer to, or fail against the subject.
Allowed subtypes:
- security_system_submission
- device_obedience
- software_permission_inversion
- ai_deference
- machine_intimidation
- network_system_reaction

intrinsic_legendary_attribute:
Use when the subject has an impossible built-in trait, aura, body feature, biological property, personal field, possession, or metaphorical property made physical.
Allowed subtypes:
- body_feature_impossibility
- aura_property
- biological_impossibility
- metaphor_made_physical
- personal_effect_field
- legendary_possession

mundane_act_made_legendary:
Use when an ordinary everyday action, task, habit, errand, work activity, food/drink activity, or social behavior is treated as absurdly epic, mythic, dominant, or legendary.
Allowed subtypes:
- domestic_task_mythologized
- ordinary_errand_mythologized
- food_drink_ritualized
- commute_travel_mythologized
- social_habit_mythologized
- work_task_mythologized

Visual literalness values:
- literal_dramatization: the fact should be depicted directly as if it happened.
- symbolic_abstraction: the fact is too conceptual to show literally and needs symbolic visual language.
- metaphorical_visualization: the fact should become a concrete visual metaphor.
- grounded_roleplay: the fact should be staged as a realistic human/social scene.
- mixed: the fact needs both literal and symbolic elements.

Visual complexity values:
- low: straightforward visual representation.
- medium: needs interpretation but has clear visual anchors.
- high: abstract, wordplay-heavy, ambiguous, or hard to make visually clear.

Overhype fit values:
- strong: clearly positive Overhype.me fact.
- questionable: funny or interesting, but may be confusing, too negative, gross, cruel, non-visual, or weakly overhyped.
- reject: does not fit positive Overhype.me without rewrite.

Adult suitability values:
- safe: appropriate for normal SFW rendering, but not especially suited to suggestive/spicy rendering.
- compatible: can reasonably support suggestive/spicy rendering if the user and source image are eligible.
- incompatible: should not be rendered in adult mode because the fact involves minors, childhood, family, school, medical vulnerability, workplace/professional context, brands, institutions, or another incompatible context.
- requires_review: may be compatible but needs human review due to ambiguity, brand/professional context, authority context, violence-adjacent context, or unusual framing.

Adult suitability is not permission to generate adult content. It is only a fact-level compatibility signal. Runtime gates must still enforce paid status, age verification, source-image eligibility, and policy constraints.

Hashtag rules:
- Suggest 3 to 8 reusable tags.
- Use lowercase only.
- Do not include the # character.
- Do not include spaces.
- Do not include the user's name.
- Prefer tags useful for discovery, not one-off words.
- Include brand or company tags only when explicitly present in the fact.

Modifier rules:
Prefer known modifiers from the known modifier catalog when possible. You may add a custom modifier only if no known modifier captures an important rendering, discovery, identity, setting, or safety constraint.

Known modifier catalog:
- single_subject_focus
- identity_strict
- identity_essence_only
- face_prominent
- full_body_needed
- age_transform
- baby_child_version
- older_self_version
- grounded_realism
- mock_heroic
- action_comedy
- cinematic_aftermath
- symbolic_abstraction_required
- metaphorical_visualization
- clear_causal_relationship
- crowd_reaction
- environmental_reaction
- object_transformation
- technology_reaction
- official_setting
- professional_context
- domestic_setting
- office_setting
- school_setting
- hospital_setting
- courtroom_setting
- airport_setting
- gym_setting
- bar_setting
- battlefield_setting
- technology_setting
- underwater_setting
- space_setting
- outdoor_nature_setting
- city_setting
- no_readable_text
- avoid_real_logos
- avoid_readable_ui
- avoid_gore
- non_graphic_action
- avoid_weapons_focus
- avoid_gross_literalization
- avoid_extra_faces
- avoid_duplicate_subject
- astronomical_consequence
- celestial_object
- subject_object_reversal
- brand_context
- workplace_context
- audience_inside_reference

Return ONLY a single JSON object with exactly these keys: primaryArchetype, subtype, modifiers (array of strings), visualLiteralness, visualComplexity, overhypeFit, adultSuitability, adultSuitabilityNotes (string, "" if none), suggestedHashtags (array of 3-8 lowercase alphanumeric strings), taxonomyConfidence (number 0-1), adminReviewNotes (string, "" if none).
Do not include explanation outside the JSON.`;

export const FACT_ENRICHMENT_MODEL_DEFAULT = "gpt-4o-mini";
export const FACT_ENRICHMENT_TEMPERATURE_DEFAULT = 0.2;
export const FACT_ENRICHMENT_MAX_TOKENS_DEFAULT = 600;
/** Reasoning effort for gpt-5/o-series models (ignored by gpt-4.x). */
export const FACT_ENRICHMENT_REASONING_EFFORT_DEFAULT = "low";

// ─── Getters (debug-overlay aware via adminConfig) ─────────────────────────────

export interface FactEnrichmentGenerationConfig {
  systemPrompt: string;
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: string;
}

/** Resolve the OpenAI generation settings for fact enrichment. */
export async function getFactEnrichmentConfig(): Promise<FactEnrichmentGenerationConfig> {
  const [systemPrompt, model, temperature, maxTokens, reasoningEffort] = await Promise.all([
    getConfigString(FACT_ENRICHMENT_CONFIG_KEYS.system, FACT_ENRICHMENT_SYSTEM_DEFAULT),
    getConfigString(FACT_ENRICHMENT_CONFIG_KEYS.model, FACT_ENRICHMENT_MODEL_DEFAULT),
    getConfigFloat(FACT_ENRICHMENT_CONFIG_KEYS.temperature, FACT_ENRICHMENT_TEMPERATURE_DEFAULT),
    getConfigInt(FACT_ENRICHMENT_CONFIG_KEYS.maxTokens, FACT_ENRICHMENT_MAX_TOKENS_DEFAULT),
    getConfigString(FACT_ENRICHMENT_CONFIG_KEYS.reasoningEffort, FACT_ENRICHMENT_REASONING_EFFORT_DEFAULT),
  ]);
  return { systemPrompt, model, temperature, maxTokens, reasoningEffort };
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

interface FactEnrichmentConfigDef {
  key: string;
  value: string;
  dataType: string;
  label: string;
  description: string;
}

export const FACT_ENRICHMENT_CONFIG_DEFS: FactEnrichmentConfigDef[] = [
  {
    key: FACT_ENRICHMENT_CONFIG_KEYS.system,
    value: FACT_ENRICHMENT_SYSTEM_DEFAULT,
    // "text" renders as a multi-line textarea in the workbench.
    dataType: "text",
    label: "Fact Enrichment — System Prompt",
    description: "OpenAI system prompt that classifies a submitted fact into the Overhype visual taxonomy. Must return JSON matching the enrichment schema (archetype, subtype, modifiers, etc.).",
  },
  {
    key: FACT_ENRICHMENT_CONFIG_KEYS.model,
    value: FACT_ENRICHMENT_MODEL_DEFAULT,
    dataType: "string",
    label: "Fact Enrichment — OpenAI Model",
    description: "OpenAI chat model used to classify facts (e.g. gpt-4o-mini, gpt-4o, gpt-5).",
  },
  {
    key: FACT_ENRICHMENT_CONFIG_KEYS.temperature,
    value: String(FACT_ENRICHMENT_TEMPERATURE_DEFAULT),
    dataType: "string",
    label: "Fact Enrichment — Temperature",
    description: "Sampling temperature for fact enrichment (0–2). Lower = more consistent classification.",
  },
  {
    key: FACT_ENRICHMENT_CONFIG_KEYS.maxTokens,
    value: String(FACT_ENRICHMENT_MAX_TOKENS_DEFAULT),
    dataType: "integer",
    label: "Fact Enrichment — Max Tokens",
    description: "Maximum tokens for the enrichment JSON response (visible output; reasoning models get extra headroom on top).",
  },
  {
    key: FACT_ENRICHMENT_CONFIG_KEYS.reasoningEffort,
    value: FACT_ENRICHMENT_REASONING_EFFORT_DEFAULT,
    dataType: "string",
    label: "Fact Enrichment — Reasoning Effort",
    description: "Reasoning effort for GPT-5 / o-series models (none/low/medium/high). Ignored by GPT-4.x models.",
  },
];

/**
 * Idempotently seed the fact-enrichment config rows with their production
 * defaults. Safe to call on every boot — existing rows (including admin edits)
 * are left untouched via ON CONFLICT DO NOTHING.
 */
export async function seedFactEnrichmentConfig(): Promise<void> {
  for (const def of FACT_ENRICHMENT_CONFIG_DEFS) {
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
      // Labels/descriptions are code-owned (not admin-editable), so keep them current.
      await db.execute(sql`
        UPDATE admin_config SET label = ${def.label}, description = ${def.description}
        WHERE key = ${def.key}
          AND (label IS DISTINCT FROM ${def.label} OR description IS DISTINCT FROM ${def.description})
      `);
    } catch (err) {
      logger.warn({ err, key: def.key }, "[factEnrichmentConfig] seed failed for key");
    }
  }
}
