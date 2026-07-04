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
import { visualPromptStrategyOverrideSchema } from "./visualStrategyOverride";

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
    "probability_impossibility",
    "rule_system_impossibility",
    "paradox_or_undefined_impossibility",
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
  // Finer-grained age stages the compiler renders distinctly (newborn vs. young
  // child) — see the age-transform binding in nanoBanana2.ts. Recognized +
  // documented + moderator-addable; the classifier's suggestion catalog does
  // not currently list them, so the AI won't auto-emit them.
  "infant_version",
  "child_version",
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
  "avoid_weapons_focus",
  "avoid_gross_literalization",
  "avoid_extra_faces",
  "avoid_duplicate_subject",
  "astronomical_consequence",
  "celestial_object",
  "subject_object_reversal",
  // Redundant-mechanism jokes: the subject's impossible power accomplishes the
  // result before an object/tool/weapon/process's normal mechanism is needed.
  // The normal mechanism may still happen afterward, but it is comically
  // redundant — NOT a temporal/causality inversion. (e.g. "threw a grenade and
  // killed 50 people, then it exploded".)
  "normal_function_rendered_unnecessary",
  "projectile_impact_power",
  "brand_context",
  "workplace_context",
  "audience_inside_reference",
] as const;
export type KnownFactModifier = (typeof KNOWN_FACT_MODIFIERS)[number];

export function isKnownModifier(modifier: string): boolean {
  return (KNOWN_FACT_MODIFIERS as readonly string[]).includes(modifier);
}

/**
 * Text/brand suppression modifiers RETIRED from the catalog (2026-07). The AI
 * classifier over-applied a blanket "no readable text on any surface" that
 * contradicted intentional in-scene text (a book cover, a scoreboard). These
 * concerns now have single, correct owners: incidental-text gibberish is a
 * built-in yielding line in the compiler's supporting-text rules; a full in-scene
 * text ban is the moderator's `supportingTextPolicyOverride` (mode "forbid"); and
 * logos/brand marks are always banned by the overlay-text exclusion.
 *
 * Deliberately typed as its own list (NOT `KnownFactModifier`): these are no
 * longer valid known values. They may survive on old fact rows as inert legacy
 * strings — filtered out of planner context AND the render-scenario hash so they
 * are display-only provenance, never render-affecting.
 */
export const RETIRED_TEXT_MODIFIERS = [
  "no_readable_text",
  "avoid_readable_ui",
  "avoid_real_logos",
] as const;
export type RetiredTextModifier = (typeof RETIRED_TEXT_MODIFIERS)[number];

/** True when a modifier string is a retired text/logo suppression flag. */
export function isRetiredTextModifier(modifier: string): boolean {
  return (RETIRED_TEXT_MODIFIERS as readonly string[]).includes(modifier);
}

// ─── Cultural-reference metadata (Phase 2A) ────────────────────────────────

/**
 * What kind of outside-context dependency a cultural reference is. Used in the
 * fact enrichment blob so admins (and the future image-prompt generator) know
 * the joke depends on culture/brand/workplace/idiom knowledge that may not be
 * obvious from the literal words.
 *
 * `none` is intentionally NOT a value — when a fact has no outside-context
 * dependency, `culturalReferences` is an empty array `[]`.
 */
export const REFERENCE_TYPE_VALUES = [
  "cultural_reference",
  "brand_reference",
  "workplace_context",
  "professional_domain_context",
  "idiom_or_phrase",
  "wordplay",
  "mechanism_knowledge",
  "inside_reference",
] as const;
export type ReferenceType = (typeof REFERENCE_TYPE_VALUES)[number];

// ─── Versioning (lightweight; useful for debugging + future prompt changes) ─

export const TAXONOMY_VERSION = "v1";
// v4: redundant-mechanism guard — "then"/result-before-mechanism jokes (e.g.
// "threw a grenade and killed 50 people, then it exploded") classify as a
// superhuman physical feat with the `normal_function_rendered_unnecessary`
// modifier, NOT temporal causality inversion.
// v6: retired the text/brand suppression modifiers (no_readable_text,
// avoid_readable_ui, avoid_real_logos) from the classifier catalog — see
// RETIRED_TEXT_MODIFIERS. The AI no longer emits blanket text bans; incidental
// text is owned by the compiler's supporting-text rules and full bans by the
// moderator override.
export const CLASSIFICATION_PROMPT_VERSION = "v6";
export const PREVIEW_PROMPT_VERSION = "v1";

// ─── Hashtag normalization ─────────────────────────────────────────────────

/** Lowercase, strip `#` and any non-alphanumeric character. May return "". */
export function normalizeHashtag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ─── Hashtag denylist (shared, browser-safe) ───────────────────────────────
//
// Tags that must never reach a fact, whatever produced them. Lives here (the
// base package) so BOTH the server (sanitizeHashtagsForPersistence /
// stripDeniedHashtags) and the client (the moderation "Add hashtag" button)
// enforce the SAME list — the admin is blocked at Add time instead of adding a
// junk tag that only gets stripped later at approval.
//
// Three families:
//   1. Subject placeholder name. Facts render to the canonical placeholder
//      "Alex" (they/them), so classifiers propose "alex" — a stand-in, not a
//      topic. Mirrors renderCanonical.CANONICAL_SUBJECT_NAMES (exactly one
//      canonical name by design); keep in sync if a placeholder is ever added.
//   2. App name. Prompts are steeped in "Overhype.me" branding, so the model
//      leaks "overhype" / "overhypeme".
//   3. Generic-humor descriptors. EVERY fact here is meant to be funny, so
//      "humor"/"funny"/"joke"/… describe the whole database, not this fact.
const DENIED_SUBJECT_HASHTAGS: readonly string[] = ["alex", "alexs"];
const APP_NAME_HASHTAGS: readonly string[] = ["overhype", "overhypeme"];
const GENERIC_HUMOR_HASHTAGS: readonly string[] = [
  "humor", "humour", "humorous",
  "funny", "funnier", "funniest", "funnyfacts",
  "joke", "jokes", "joking",
  "comedy", "comedic", "comedian",
  "hilarious", "hilarity",
  "lol", "lmao", "rofl", "haha", "hahaha",
  "laugh", "laughs", "laughing", "laughter",
  "amusing", "amusement", "funnies",
  "witty", "humorists",
];

/** The normalized set of denied hashtags (subject name + app name + generic humor). */
export const DENIED_HASHTAGS: ReadonlySet<string> = new Set<string>(
  [...DENIED_SUBJECT_HASHTAGS, ...APP_NAME_HASHTAGS, ...GENERIC_HUMOR_HASHTAGS]
    .map(normalizeHashtag)
    .filter((t) => t.length > 0),
);

/** True when a raw tag normalizes to a denied hashtag (empty tags are not denied). */
export function isDeniedHashtag(rawTag: string): boolean {
  const n = normalizeHashtag(rawTag);
  return n.length > 0 && DENIED_HASHTAGS.has(n);
}

// ─── Cultural reference + supporting-text policy + visual preview ──────────

/**
 * A single outside-context dependency surfaced during enrichment. Informs
 * visual interpretation but never reclassifies the archetype/subtype.
 *
 * Fields with `.default("")` cover the case where the model omits a soft field
 * (e.g. no canonical reference name for an idiom). `requiresAdminReview` flips
 * to true when the model is uncertain or when the reference is brand/workplace
 * adjacent.
 */
// Source-type vocabulary for the admin reference-research tool. Mirrored
// here (rather than imported from referenceResearch.ts) so taxonomy.ts has no
// upward dep on the research module; the values are kept in lockstep.
const CULTURAL_REFERENCE_RESEARCH_SOURCE_TYPE_VALUES = [
  "official",
  "encyclopedic",
  "news",
  "community",
  "search_result",
  "admin_context",
  "other",
] as const;

const culturalReferenceResearchSourceSchema = z.object({
  title: z.string().trim().min(1).max(300),
  url: z.string().trim().max(1024).default(""),
  sourceType: z.enum(CULTURAL_REFERENCE_RESEARCH_SOURCE_TYPE_VALUES),
  summary: z.string().trim().max(800).default(""),
});

export const culturalReferenceSchema = z.object({
  sourcePhrase: z.string().trim().min(1).max(300),
  referenceType: z.enum(REFERENCE_TYPE_VALUES),
  canonicalReference: z.string().trim().max(300).default(""),
  explanation: z.string().trim().max(800).default(""),
  visualImplication: z.string().trim().max(800).default(""),
  confidence: z.number().min(0).max(1),
  requiresAdminReview: z.boolean().default(false),
  // Optional research metadata stamped when an admin runs the "Research
  // Reference" tool. Absent for enrichment blobs the enrichment AI emitted
  // without a research pass.
  researchConfidence: z.enum(["high", "medium", "low"]).optional(),
  researchSources: z.array(culturalReferenceResearchSourceSchema).max(20).optional(),
  researchNotes: z.string().trim().max(2000).optional(),
  ambiguityWarnings: z.array(z.string().trim().min(1)).max(10).optional(),
  researchedAt: z.string().optional(),
  researchedBy: z.literal("ai_reference_research").optional(),
});
export type CulturalReference = z.infer<typeof culturalReferenceSchema>;

// ─── Semantic entities (capitalization-aware visual referents) ─────────────

/**
 * The kind of thing a surface term refers to in this fact. Drives visual
 * interpretation downstream (Phase 2 image-prompt generation reads these as
 * HARD context — see imagePromptGeneration.ts).
 *
 * Not a new archetype layer — entity interpretation is render context, not
 * taxonomy. The fact's primaryArchetype + subtype don't change because we
 * resolved "Earth" to the planet.
 */
export const SEMANTIC_ENTITY_KIND_VALUES = [
  "proper_noun",
  "common_noun",
  "named_entity",
  "brand_or_cultural_reference",
  "abstract_concept",
  "personified_concept",
  "physical_object",
  "place",
  "celestial_body",
  "institution_or_system",
  "ambiguous",
] as const;
export type SemanticEntityKind = (typeof SEMANTIC_ENTITY_KIND_VALUES)[number];

/**
 * What signal the surface casing carried for THIS interpretation. Sentence-
 * initial ambiguity is the common reason an entry needs admin review even
 * when confidence is otherwise high.
 */
export const CAPITALIZATION_SIGNAL_VALUES = [
  "capitalized_named_entity",
  "lowercase_common_noun",
  "sentence_initial_ambiguous",
  "all_caps_presentation_ignored",
  "mixed_case_brand_or_title",
  "not_relevant",
] as const;
export type CapitalizationSignal = (typeof CAPITALIZATION_SIGNAL_VALUES)[number];

/**
 * One disambiguated surface term in the fact text. The enrichment AI lists
 * only entries where interpretation MATTERS for visual prompting — not every
 * noun. Entries with `materiallyAffectsVisualPrompt=true` are echoed back by
 * the Phase 2 prompt generator in `visualPlan.semanticEntitiesUsed`.
 *
 * Capitalization is preserved on `surfaceText` (do NOT normalize the case
 * before enrichment). `normalizedText` is the lowercase comparable form.
 */
export const semanticEntitySchema = z.object({
  surfaceText: z.string().trim().min(1).max(120),
  normalizedText: z.string().trim().min(1).max(120),
  entityKind: z.enum(SEMANTIC_ENTITY_KIND_VALUES),
  visualReferent: z.string().trim().min(1).max(400),
  capitalizationSignal: z.enum(CAPITALIZATION_SIGNAL_VALUES),
  materiallyAffectsVisualPrompt: z.boolean(),
  requiresAdminReview: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  notes: z.string().trim().max(800).default(""),
});
export type SemanticEntity = z.infer<typeof semanticEntitySchema>;

// ─── Classification-prompt provenance ──────────────────────────────────────

/**
 * Provenance of the EFFECTIVE fact-enrichment system prompt at classify time.
 * Server-stamped (never model-produced) so it is NOT part of the strict wire
 * schema. Proves which prompt text actually ran — a stale `admin_config` value
 * can diverge from the code default while `classificationPromptVersion` still
 * reads the current constant, so the version stamp alone isn't proof.
 */
export const classificationPromptDiagnosticsSchema = z.object({
  source: z.enum([
    "code_default",
    "admin_config_value",
    "admin_config_debug_value",
    "fallback_default",
  ]),
  hash: z.string().trim().min(1).max(64),
  length: z.number().int().nonnegative(),
  codeDefaultHash: z.string().trim().min(1).max(64),
  matchesCodeDefault: z.boolean(),
});
export type ClassificationPromptDiagnostics = z.infer<
  typeof classificationPromptDiagnosticsSchema
>;

// ─── Enrichment schema ─────────────────────────────────────────────────────

const archetypeEnum = z.enum(PRIMARY_ARCHETYPES);
const subtypeEnum = z.enum(ALL_SUBTYPES as [FactSubtype, ...FactSubtype[]]);

/**
 * Base object (no superRefine yet) so we can lift it into wire schemas / extend
 * downstream. Apply the subtype cross-field refine in `factEnrichmentSchema`.
 *
 * `culturalReferences` is REQUIRED but may be `[]` (`.default([])` keeps
 * Phase-1 / backfilled blobs valid). The enrichment blob no longer carries a
 * `visualPromptPreview`/`previewStatus`: the render-time visualPlan + Nano
 * Banana compiler is the single source of truth for the visual, and approval
 * runs a non-persistent renderability preflight instead. Any stale
 * `visualPromptPreview`/`previewStatus` keys left in old stored JSONB are
 * simply dropped on the next validate/save.
 */
export const factEnrichmentBase = z.object({
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
  culturalReferences: z.array(culturalReferenceSchema).max(20).default([]),
  /**
   * Capitalization-aware visual-referent disambiguation (CLASSIFICATION_PROMPT_VERSION v3).
   * Optional + defaults to `[]` so older enrichment blobs validate unchanged.
   * Only entries where interpretation materially affects the visual prompt
   * should be listed — the enrichment AI is instructed not to enumerate
   * every noun.
   */
  semanticEntities: z.array(semanticEntitySchema).max(20).default([]),
  /**
   * Phase 2 — optional moderator-authored visual-strategy override. NOT part of
   * the strict `factEnrichmentWireSchema` (the LLM never produces it); set only
   * by an admin and preserved across re-classification.
   */
  visualPromptStrategyOverride: visualPromptStrategyOverrideSchema.optional(),
  // Optional provenance — stamped by the enrichment service.
  /**
   * Identifies the AI generation that produced this baseline. Stamped fresh on
   * every (re-)classification so manual overrides can detect when the AI value
   * they were created against has since changed ("baseline changed"). Optional
   * so older blobs validate unchanged; legacy/backfilled blobs use "legacy".
   */
  aiGenerationId: z.string().optional(),
  taxonomyVersion: z.string().optional(),
  classificationPromptVersion: z.string().optional(),
  // Which prompt text actually ran (source/hash). Optional so older blobs and
  // admin edits validate unchanged; stamped onto fresh enrichments.
  classificationPromptDiagnostics: classificationPromptDiagnosticsSchema.optional(),
  enrichedAt: z.string().optional(),
  enrichedBy: z.string().optional(),
});

const enforceSubtypeBelongsToArchetype = (
  val: { primaryArchetype: PrimaryArchetype; subtype: string },
  ctx: z.RefinementCtx,
): void => {
  const allowed = SUBTYPES_BY_ARCHETYPE[val.primaryArchetype] as readonly string[];
  if (!allowed.includes(val.subtype)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["subtype"],
      message: `subtype "${val.subtype}" is not valid for primaryArchetype "${val.primaryArchetype}"`,
    });
  }
};

/**
 * Validates a raw enrichment object (from OpenAI or an admin edit). Normalizes
 * hashtags, trims strings, defaults notes to "", and enforces that the subtype
 * is valid for the chosen archetype.
 */
export const factEnrichmentSchema = factEnrichmentBase.superRefine(
  enforceSubtypeBelongsToArchetype,
);

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

// ─── Strict "wire" schemas for OpenAI Structured Outputs ───────────────────

/**
 * OpenAI's strict json_schema response_format requires every property to be
 * required, no `default`/`transform`/refinements. So the wire mirrors below
 * are plain objects describing only the transport contract; once we receive
 * the parsed response we run it through `validateEnrichment` for normalization
 * (hashtag transform) and business rules (subtype ∈ archetype).
 */

const culturalReferenceWireSchema = z.object({
  sourcePhrase: z.string(),
  referenceType: z.enum(REFERENCE_TYPE_VALUES),
  canonicalReference: z.string(),
  explanation: z.string(),
  visualImplication: z.string(),
  confidence: z.number(),
  requiresAdminReview: z.boolean(),
});

const semanticEntityWireSchema = z.object({
  surfaceText: z.string(),
  normalizedText: z.string(),
  entityKind: z.enum(SEMANTIC_ENTITY_KIND_VALUES),
  visualReferent: z.string(),
  capitalizationSignal: z.enum(CAPITALIZATION_SIGNAL_VALUES),
  materiallyAffectsVisualPrompt: z.boolean(),
  requiresAdminReview: z.boolean(),
  confidence: z.number(),
  notes: z.string(),
});

export const factEnrichmentWireSchema = z.object({
  primaryArchetype: archetypeEnum,
  subtype: subtypeEnum,
  modifiers: z.array(z.string()),
  visualLiteralness: z.enum(VISUAL_LITERALNESS_VALUES),
  visualComplexity: z.enum(VISUAL_COMPLEXITY_VALUES),
  overhypeFit: z.enum(OVERHYPE_FIT_VALUES),
  adultSuitability: z.enum(ADULT_SUITABILITY_VALUES),
  adultSuitabilityNotes: z.string(),
  suggestedHashtags: z.array(z.string()),
  taxonomyConfidence: z.number(),
  adminReviewNotes: z.string(),
  culturalReferences: z.array(culturalReferenceWireSchema),
  semanticEntities: z.array(semanticEntityWireSchema),
});
