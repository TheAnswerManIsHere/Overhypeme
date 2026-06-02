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
export const CLASSIFICATION_PROMPT_VERSION = "v3";
export const PREVIEW_PROMPT_VERSION = "v1";

// ─── Hashtag normalization ─────────────────────────────────────────────────

/** Lowercase, strip `#` and any non-alphanumeric character. May return "". */
export function normalizeHashtag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]/g, "");
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

/**
 * Per-fact supporting-text policy: what readable text the image model is
 * allowed vs forbidden to render for this specific joke. Centralized; the
 * default population (forbidden = full meme captions / full fact text /
 * hashtags / watermarks / real logos / brand marks / long paragraphs; allowed
 * = concise short labels / numbers / symbols / equations / UI fragments /
 * scoreboards / documents / keypad digits / signs when they directly support
 * the joke) is set in the prompt-strategy guardrails module.
 */
export const supportingTextPolicySchema = z.object({
  allowed: z.array(z.string().trim().min(1)).max(20).default([]),
  forbidden: z.array(z.string().trim().min(1)).max(20).default([]),
  notes: z.string().trim().max(800).default(""),
});
export type SupportingTextPolicy = z.infer<typeof supportingTextPolicySchema>;

/**
 * Fixed preview assumptions. Modeled as literals so the model can't quietly
 * change them (preview mode, style, face-preserve, physique-preserve are
 * product-fixed for this bridge phase). `sampleName` defaults to "David" — the
 * canonical brand example — and is used by the guardrail's subject-label rule
 * (literal "David" only when sampleName is "David", else "the named subject").
 */
export const PREVIEW_GENERATION_MODE = "i2i_and_t2i_preview" as const;
export const PREVIEW_STYLE = "default_sfw_cinematic" as const;

export const previewAssumptionsSchema = z.object({
  sampleName: z.string().trim().min(1).max(80).default("David"),
  generationMode: z.literal(PREVIEW_GENERATION_MODE).default(PREVIEW_GENERATION_MODE),
  style: z.literal(PREVIEW_STYLE).default(PREVIEW_STYLE),
  preserveFace: z.literal(true).default(true),
  preservePhysique: z.literal(false).default(false),
});

/**
 * Admin-visible text preview of the system's intended visual interpretation.
 * Structurally close to the Phase 2 render-time visual plan so the strategy
 * module is reusable: `archetypeApplication`, `selectedFrame`, `keyVisualElements`,
 * `supportingTextPolicy`, and `culturalReferencesUsed` mirror what render-time
 * will consume. NOT a real render prompt and NOT an image.
 */
export const visualPromptPreviewSchema = z.object({
  archetypeApplication: z.string().trim().min(1).max(1200),
  selectedFrame: z.string().trim().min(1).max(300),
  sceneConcept: z.string().trim().min(1).max(1200),
  visualGoal: z.string().trim().min(1).max(1200),
  visualApproach: z.string().trim().min(1).max(1200),
  keyVisualElements: z.array(z.string().trim().min(1)).max(30).default([]),
  engineNeutralVisualPlan: z.string().trim().min(1).max(3000),
  exampleI2iPrompt: z.string().trim().min(1).max(3000),
  exampleT2iPrompt: z.string().trim().min(1).max(3000),
  promptGuardrailsPreview: z.string().trim().max(2000).default(""),
  supportingTextPolicy: supportingTextPolicySchema,
  culturalReferencesUsed: z.array(z.string().trim().min(1)).max(20).default([]),
  interpretationWarnings: z.array(z.string().trim().min(1)).max(20).default([]),
  previewAssumptions: previewAssumptionsSchema,
  // Provenance (stamped by the preview generator, mirrors enrichment provenance).
  previewPromptVersion: z.string().optional(),
  generatedAt: z.string().optional(),
  generatedBy: z.string().optional(),
});
export type VisualPromptPreview = z.infer<typeof visualPromptPreviewSchema>;

// ─── Enrichment schema ─────────────────────────────────────────────────────

const archetypeEnum = z.enum(PRIMARY_ARCHETYPES);
const subtypeEnum = z.enum(ALL_SUBTYPES as [FactSubtype, ...FactSubtype[]]);

/**
 * Base object (no superRefine yet) so we can lift it into wire schemas / extend
 * downstream. Apply the subtype cross-field refine in `factEnrichmentSchema`.
 *
 * `culturalReferences` is REQUIRED but may be `[]` (`.default([])` keeps
 * Phase-1 / backfilled blobs valid). `visualPromptPreview` is optional — a
 * freshly-classified review may not have one yet; the approval gate checks its
 * presence separately. `previewStatus` tracks phase-2 status inside the blob
 * (keeps `enrichment_status` on `pending_reviews` semantic to phase-1 only).
 */
const factEnrichmentBase = z.object({
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
  visualPromptPreview: visualPromptPreviewSchema.optional(),
  previewStatus: z.enum(["pending", "ok", "failed", "stale"]).optional(),
  // Optional provenance — stamped by the enrichment service.
  taxonomyVersion: z.string().optional(),
  classificationPromptVersion: z.string().optional(),
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

export type VisualPreviewValidationResult =
  | { ok: true; data: VisualPromptPreview }
  | { ok: false; error: string };

/** Safe-parse wrapper for a standalone visual-preview object. */
export function validateVisualPreview(raw: unknown): VisualPreviewValidationResult {
  const result = visualPromptPreviewSchema.safeParse(raw);
  if (result.success) return { ok: true, data: result.data };
  const error = result.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

/**
 * Shared by the server approval gate (`/admin/reviews/:id/approve(/-variant)`)
 * and the client approve button so both stay in lockstep. True iff the
 * enrichment carries a valid, complete visualPromptPreview.
 */
export function hasUsableVisualPreview(
  enrichment: { visualPromptPreview?: unknown } | null | undefined,
): boolean {
  if (!enrichment || !enrichment.visualPromptPreview) return false;
  return validateVisualPreview(enrichment.visualPromptPreview).ok;
}

// ─── Strict "wire" schemas for OpenAI Structured Outputs ───────────────────

/**
 * OpenAI's strict json_schema response_format requires every property to be
 * required, no `default`/`transform`/refinements. So the wire mirrors below
 * are plain objects describing only the transport contract; once we receive
 * the parsed response we run it through `validateEnrichment` /
 * `validateVisualPreview` for normalization (hashtag transform) and business
 * rules (subtype ∈ archetype).
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

const supportingTextPolicyWireSchema = z.object({
  allowed: z.array(z.string()),
  forbidden: z.array(z.string()),
  notes: z.string(),
});

const previewAssumptionsWireSchema = z.object({
  sampleName: z.string(),
  generationMode: z.literal(PREVIEW_GENERATION_MODE),
  style: z.literal(PREVIEW_STYLE),
  preserveFace: z.literal(true),
  preservePhysique: z.literal(false),
});

export const visualPreviewWireSchema = z.object({
  archetypeApplication: z.string(),
  selectedFrame: z.string(),
  sceneConcept: z.string(),
  visualGoal: z.string(),
  visualApproach: z.string(),
  keyVisualElements: z.array(z.string()),
  engineNeutralVisualPlan: z.string(),
  exampleI2iPrompt: z.string(),
  exampleT2iPrompt: z.string(),
  promptGuardrailsPreview: z.string(),
  supportingTextPolicy: supportingTextPolicyWireSchema,
  culturalReferencesUsed: z.array(z.string()),
  interpretationWarnings: z.array(z.string()),
  previewAssumptions: previewAssumptionsWireSchema,
});
