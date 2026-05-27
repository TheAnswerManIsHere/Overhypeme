/**
 * Overhype.me fact visual taxonomy — shared source of truth.
 *
 * Lives in @workspace/api-zod (zod-only, browser-safe) so both the API server
 * (enrichment service + validation) and the admin UI (selects, chips, edit
 * validation) import the SAME enums, subtype map, and schema.
 *
 * Taxonomy classifies the *joke mechanism* of a fact so later image/video
 * prompt routing can pick the right visual strategy. It is intentionally
 * separate from style (aesthetics) and render policy (allowed content level).
 */

import { z } from "zod";

// ─── Primary archetypes ────────────────────────────────────────────────────

export const PRIMARY_ARCHETYPES = [
  "superhuman_physical_feat",
  "object_logic_impossibility",
  "environmental_obedience_immunity",
  "authority_threat_reversal",
  "temporal_causality_inversion",
  "presence_induced_reaction_aura",
  "logic_formal_impossibility",
  "intellectual_omniscience",
  "technology_system_reaction",
  "intrinsic_legendary_attribute",
  "mundane_act_made_legendary",
] as const;

export type PrimaryArchetype = (typeof PRIMARY_ARCHETYPES)[number];

// ─── Subtypes (per archetype) ──────────────────────────────────────────────

export const SUBTYPES_BY_ARCHETYPE = {
  superhuman_physical_feat: [
    "force_scaled_action",
    "strength_scaled_action",
    "speed_scaled_action",
    "endurance_scaled_action",
    "precision_scaled_action",
    "sensory_scaled_action",
    "ordinary_action_extreme_consequence",
  ],
  object_logic_impossibility: [
    "mechanical_contradiction",
    "semantic_instrument_contradiction",
    "material_state_contradiction",
    "medium_contradiction",
    "target_nature_contradiction",
    "object_agency_inversion",
  ],
  environmental_obedience_immunity: [
    "environmental_immunity",
    "environmental_agency_inversion",
    "environmental_control_interface",
    "environmental_retreat_obedience",
    "personified_natural_force",
  ],
  authority_threat_reversal: [
    "social_role_reversal",
    "institutional_authority_reversal",
    "predator_danger_reversal",
  ],
  temporal_causality_inversion: [
    "pure_timeline_inversion",
    "pre_cause_consequence",
    "reverse_process_entropy_reversal",
  ],
  presence_induced_reaction_aura: [
    "surrender",
    "awe_deference",
    "prestige_transfer",
    "world_waits_for_subject",
    "object_obsession",
    "respectful_refusal",
    "tiny_gesture_massive_reaction",
  ],
  logic_formal_impossibility: [
    "infinity_impossibility",
    "zero_division_impossibility",
    "probability_impossibility",
    "rule_system_impossibility",
    "paradox_impossibility",
    "formal_language_impossibility",
  ],
  intellectual_omniscience: [
    "hidden_knowledge",
    "future_prediction",
    "impossible_problem_solving",
    "memory_omniscience",
    "strategic_omniscience",
    "secret_mastery",
  ],
  technology_system_reaction: [
    "security_system_submission",
    "device_obedience",
    "software_permission_inversion",
    "ai_deference",
    "machine_intimidation",
    "network_system_reaction",
  ],
  intrinsic_legendary_attribute: [
    "body_feature_impossibility",
    "aura_property",
    "biological_impossibility",
    "metaphor_made_physical",
    "personal_effect_field",
    "legendary_possession",
  ],
  mundane_act_made_legendary: [
    "domestic_task_mythologized",
    "ordinary_errand_mythologized",
    "food_drink_ritualized",
    "commute_travel_mythologized",
    "social_habit_mythologized",
    "work_task_mythologized",
  ],
} as const satisfies Record<PrimaryArchetype, readonly string[]>;

export type FactSubtype =
  (typeof SUBTYPES_BY_ARCHETYPE)[PrimaryArchetype][number];

/** Flat list of every subtype across all archetypes (for enum/validation). */
export const ALL_SUBTYPES = Object.values(SUBTYPES_BY_ARCHETYPE).flat() as FactSubtype[];

/** Allowed subtypes for an archetype (used by the admin subtype select). */
export function subtypesForArchetype(
  archetype: PrimaryArchetype,
): readonly FactSubtype[] {
  return SUBTYPES_BY_ARCHETYPE[archetype];
}

// ─── Other enums ───────────────────────────────────────────────────────────

export const VISUAL_LITERALNESS_VALUES = [
  "literal_dramatization",
  "symbolic_abstraction",
  "metaphorical_visualization",
  "grounded_roleplay",
  "mixed",
] as const;
export type VisualLiteralness = (typeof VISUAL_LITERALNESS_VALUES)[number];

export const VISUAL_COMPLEXITY_VALUES = ["low", "medium", "high"] as const;
export type VisualComplexity = (typeof VISUAL_COMPLEXITY_VALUES)[number];

export const OVERHYPE_FIT_VALUES = ["strong", "questionable", "reject"] as const;
export type OverhypeFit = (typeof OVERHYPE_FIT_VALUES)[number];

export const ADULT_SUITABILITY_VALUES = [
  "safe",
  "compatible",
  "incompatible",
  "requires_review",
] as const;
export type AdultSuitability = (typeof ADULT_SUITABILITY_VALUES)[number];

// ─── Known modifier catalog (semi-controlled; custom allowed) ──────────────

export const KNOWN_FACT_MODIFIERS = [
  "single_subject_focus",
  "identity_strict",
  "identity_essence_only",
  "face_prominent",
  "full_body_needed",
  "age_transform",
  "baby_child_version",
  "older_self_version",
  "grounded_realism",
  "mock_heroic",
  "action_comedy",
  "cinematic_aftermath",
  "symbolic_abstraction_required",
  "metaphorical_visualization",
  "clear_causal_relationship",
  "crowd_reaction",
  "environmental_reaction",
  "object_transformation",
  "technology_reaction",
  "official_setting",
  "professional_context",
  "domestic_setting",
  "office_setting",
  "school_setting",
  "hospital_setting",
  "courtroom_setting",
  "airport_setting",
  "gym_setting",
  "bar_setting",
  "battlefield_setting",
  "technology_setting",
  "underwater_setting",
  "space_setting",
  "outdoor_nature_setting",
  "city_setting",
  "no_readable_text",
  "avoid_real_logos",
  "avoid_readable_ui",
  "avoid_gore",
  "non_graphic_action",
  "avoid_weapons_focus",
  "avoid_gross_literalization",
  "avoid_extra_faces",
  "avoid_duplicate_subject",
  "astronomical_consequence",
  "celestial_object",
  "subject_object_reversal",
  "brand_context",
  "workplace_context",
  "audience_inside_reference",
] as const;
export type KnownFactModifier = (typeof KNOWN_FACT_MODIFIERS)[number];

export function isKnownModifier(modifier: string): boolean {
  return (KNOWN_FACT_MODIFIERS as readonly string[]).includes(modifier);
}

// ─── Versioning (lightweight; useful for debugging + future prompt changes) ─

export const TAXONOMY_VERSION = "v1";
export const CLASSIFICATION_PROMPT_VERSION = "v1";

// ─── Hashtag normalization ─────────────────────────────────────────────────

/** Lowercase, strip `#` and any non-alphanumeric character. May return "". */
export function normalizeHashtag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Enrichment schema ─────────────────────────────────────────────────────

const archetypeEnum = z.enum(PRIMARY_ARCHETYPES);
const subtypeEnum = z.enum(ALL_SUBTYPES as [FactSubtype, ...FactSubtype[]]);

/**
 * Validates a raw enrichment object (from OpenAI or an admin edit). Normalizes
 * hashtags, trims strings, defaults notes to "", and enforces that the subtype
 * is valid for the chosen archetype.
 */
export const factEnrichmentSchema = z
  .object({
    primaryArchetype: archetypeEnum,
    subtype: subtypeEnum,
    modifiers: z
      .array(z.string().trim().min(1))
      .max(20)
      .default([]),
    visualLiteralness: z.enum(VISUAL_LITERALNESS_VALUES),
    visualComplexity: z.enum(VISUAL_COMPLEXITY_VALUES),
    overhypeFit: z.enum(OVERHYPE_FIT_VALUES),
    adultSuitability: z.enum(ADULT_SUITABILITY_VALUES),
    adultSuitabilityNotes: z.string().trim().max(500).default(""),
    suggestedHashtags: z
      .array(z.string())
      .transform((arr) =>
        Array.from(new Set(arr.map(normalizeHashtag).filter((t) => t.length > 0))),
      )
      .pipe(z.array(z.string().regex(/^[a-z0-9]+$/)).min(3).max(8)),
    taxonomyConfidence: z.number().min(0).max(1),
    adminReviewNotes: z.string().trim().max(800).default(""),
    // Optional provenance — stamped by the enrichment service.
    taxonomyVersion: z.string().optional(),
    classificationPromptVersion: z.string().optional(),
    enrichedAt: z.string().optional(),
    enrichedBy: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    const allowed = SUBTYPES_BY_ARCHETYPE[val.primaryArchetype] as readonly string[];
    if (!allowed.includes(val.subtype)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subtype"],
        message: `subtype "${val.subtype}" is not valid for primaryArchetype "${val.primaryArchetype}"`,
      });
    }
  });

export type FactEnrichment = z.infer<typeof factEnrichmentSchema>;

export type EnrichmentValidationResult =
  | { ok: true; data: FactEnrichment }
  | { ok: false; error: string; subtypeMismatch: boolean };

/** Safe-parse wrapper returning a flat error string and a subtype-mismatch flag. */
export function validateEnrichment(raw: unknown): EnrichmentValidationResult {
  const result = factEnrichmentSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const subtypeMismatch = result.error.issues.some(
    (i) => i.path.length === 1 && i.path[0] === "subtype",
  );
  const error = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error, subtypeMismatch };
}
