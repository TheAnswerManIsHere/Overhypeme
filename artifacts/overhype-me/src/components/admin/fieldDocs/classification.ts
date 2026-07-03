/**
 * Field docs — "AI Visual Classification" section (13 fields) + the small
 * enum value-docs (literalness, complexity, fit, adult suitability).
 *
 * Pure data. Meanings are extracted from the classifier system prompt
 * (FACT_ENRICHMENT_SYSTEM_DEFAULT) and render behavior from the traced prompt
 * pipeline — see sourceRefs on each record.
 */

import {
  VISUAL_LITERALNESS_VALUES,
  VISUAL_COMPLEXITY_VALUES,
  OVERHYPE_FIT_VALUES,
  ADULT_SUITABILITY_VALUES,
  PRIMARY_ARCHETYPES,
  ALL_SUBTYPES,
  KNOWN_FACT_MODIFIERS,
  type VisualLiteralness,
  type VisualComplexity,
  type OverhypeFit,
  type AdultSuitability,
} from "@workspace/api-zod";
import { valuesFrom, type FieldDoc, type ValueDoc, type FieldDocSourceRef } from "./types";
import { PRIMARY_ARCHETYPE_DOCS, SUBTYPE_DOCS } from "./archetypes";
import { KNOWN_MODIFIER_DOCS } from "./modifiers";

// Shared source refs used across this section.
const CLASSIFIER_PROMPT: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factEnrichmentConfig.ts",
  symbol: "FACT_ENRICHMENT_SYSTEM_DEFAULT",
  note: "The classifier system prompt — the authoritative definition of what the AI is told this field means.",
};
const PLANNER_TAXONOMY_BLOCK: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/generator.ts",
  symbol: "buildImagePromptUserMessage",
  note: "Where the enrichment is injected into the image-prompt planner message (the TAXONOMY block is marked FIXED — DO NOT reclassify).",
};
const STALE_HASH: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factRenderScenarios.ts",
  symbol: "renderAffectingEnrichment",
  note: "The render-input hash projection — fields listed here flip render-scenario tiles stale when edited.",
};

// ─── Small enum value-docs ───────────────────────────────────────────────────

export const VISUAL_LITERALNESS_DOCS = {
  literal_dramatization: {
    meaning:
      "The fact should be depicted directly, as if it literally happened — the scene shows the impossible thing itself, dramatized cinematically.",
    renderImpact:
      "The planner writes a scene that stages the fact as a real event. Most physical-feat and reversal facts land here.",
    example:
      '"{NAME} bench-presses a bus" → a scene of the subject actually lifting a bus, full cinematic staging.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  symbolic_abstraction: {
    meaning:
      "The fact is too conceptual to show literally and needs symbolic visual language — the image represents the idea, not the event.",
    renderImpact:
      "The planner leans on symbols, scale metaphors, and abstract staging instead of a literal event. Common for logic/infinity facts.",
    example:
      '"{NAME} counted to infinity. Twice." → an endless number-scape receding past the horizon rather than a person counting.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  metaphorical_visualization: {
    meaning:
      "The fact should become a concrete visual metaphor — a phrase or concept made physically true in the image.",
    renderImpact:
      "The planner picks one clear metaphor and renders it as a real object/scene (a 'metaphor made physical').",
    example:
      '"{NAME}\'s handshake seals deals" → a literal wax-seal stamp pressed by a handshake onto a giant contract.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  grounded_roleplay: {
    meaning:
      "The fact should be staged as a realistic human/social scene — the comedy comes from people behaving impossibly, not from physics.",
    renderImpact:
      "The planner keeps the scene physically plausible and puts the impossibility in the social roles and reactions (e.g. authority reversals).",
    example:
      '"A baby drove {NAME}\'s mother home" → a realistic car interior; the impossibility is who\'s driving, not the physics.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  mixed: {
    meaning: "The fact needs both literal and symbolic elements to land.",
    renderImpact:
      "The planner combines a literal core event with symbolic supporting elements; expect a busier scene.",
    example:
      '"{NAME} argued with gravity and won" → a literal courtroom (roleplay) with gravity personified as a defeated force (symbolic).',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
} satisfies Record<VisualLiteralness, ValueDoc>;

export const VISUAL_COMPLEXITY_DOCS = {
  low: {
    meaning: "Straightforward visual representation — the fact translates to an image with no interpretation needed.",
    renderImpact: "No special handling; the planner stages it directly.",
    example: '"{NAME} lifts a car" → one subject, one car, one action.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  medium: {
    meaning: "Needs interpretation but has clear visual anchors — the AI has to make a staging choice, but the ingredients are obvious.",
    renderImpact: "The planner picks an interpretation; the test renders are worth a quick sanity check.",
    example: '"Sharks have a {NAME} Week" → needs the \'sharks as audience\' inversion, but sharks + TV are clear anchors.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  high: {
    meaning:
      "Abstract, wordplay-heavy, ambiguous, or hard to make visually clear. The admin UI surfaces a 'Hard to visualize' warning for these.",
    renderImpact:
      "Advisory to the planner only — but treat it as a signal to review the test renders closely and consider a Visual Strategy Override if the AI's interpretation misses.",
    example: '"{NAME} divided by zero and survived" → no natural image; expect symbolic staging and check it actually reads.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
} satisfies Record<VisualComplexity, ValueDoc>;

export const OVERHYPE_FIT_DOCS = {
  strong: {
    meaning: "Clearly positive Overhype.me fact — the subject is legendary/impressive/dominant per the core product rule.",
    renderImpact: "None at render time. No taxonomy-health flags; the fact proceeds normally.",
    example: '"{NAME} bench-presses the Earth" → unambiguously positive superhuman framing.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  questionable: {
    meaning:
      "Funny or interesting, but may be confusing, too negative, gross, cruel, non-visual, or weakly overhyped — a human should weigh in.",
    renderImpact:
      "None at render time. Taxonomy Health raises a warning ('admin should weigh in') and marks the fact needs_admin_review.",
    example: 'A fact whose joke edges on humiliating the subject — the classifier flags it rather than rejecting outright.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  reject: {
    meaning: "Does not fit positive Overhype.me without a rewrite — the core joke makes the subject pathetic, weak, humiliated, or cruel.",
    renderImpact:
      "None at render time. Taxonomy Health raises an error ('fact should likely be removed or rewritten') and marks needs_admin_review.",
    example: 'A fact whose only punchline is the subject failing — violates the "portray positively" product rule.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
} satisfies Record<OverhypeFit, ValueDoc>;

export const ADULT_SUITABILITY_DOCS = {
  safe: {
    meaning: "Appropriate for normal SFW rendering, but not especially suited to suggestive/spicy rendering.",
    renderImpact: "None — the actual SFW/spicy level of a render is the separate contentMode render control, not this field.",
    example: "A gym-feat fact: fine as SFW, nothing about it supports a spicy variant.",
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  compatible: {
    meaning: "Can reasonably support suggestive/spicy rendering if the user and source image are eligible.",
    renderImpact:
      "None directly — it is a fact-level compatibility signal only. Runtime gates (paid status, age verification, source-image eligibility, policy) still decide what actually renders.",
    example: "A confident-aura fact that could carry a spicy variant for an eligible adult user.",
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  incompatible: {
    meaning:
      "Should not be rendered in adult mode — the fact involves minors, childhood, family, school, medical vulnerability, workplace/professional context, brands, institutions, or another incompatible context.",
    renderImpact: "None at render time in SFW mode; blocks adult-mode consideration for this fact.",
    example: 'Any fact involving "{NAME} as a baby" — childhood context makes adult mode categorically incompatible.',
    sourceRefs: [CLASSIFIER_PROMPT],
  },
  requires_review: {
    meaning:
      "May be compatible but needs human review — ambiguity, brand/professional context, authority context, violence-adjacent context, or unusual framing.",
    renderImpact: "None at render time. Taxonomy Health flags the fact (adultRequiresReview) for a human decision.",
    example: "A workplace-adjacent fact where spicy compatibility depends on framing a human should judge.",
    sourceRefs: [CLASSIFIER_PROMPT],
  },
} satisfies Record<AdultSuitability, ValueDoc>;

// ─── Field docs ──────────────────────────────────────────────────────────────

export const CLASSIFICATION_FIELD_DOCS: FieldDoc[] = [
  {
    key: "primaryArchetype",
    label: "Joke Mechanism (Archetype)",
    hint: "The joke's MECHANISM — the single most important classification on this form.",
    whatItIs: [
      "The primary archetype classifies HOW the fact's joke works (its mechanism), not what it is superficially about. The classifier's own rule: \"Classify by the joke mechanism, not by superficial topic\" — a moon fact caused by a sneeze is a superhuman physical feat with an astronomical-consequence modifier, not a cosmic category.",
      "There are 11 archetypes, each with its own hand-authored visual strategy. Getting this wrong sends the renderer down the wrong strategy entirely, so it is the first thing to check when a test render misses the joke.",
    ],
    howDerived: [
      "The enrichment classifier reads the fact rendered to the canonical subject (\"Alex\", they/them) and picks exactly one archetype using per-archetype \"use when…\" rules, plus explicit disambiguation guidance (e.g. the redundant-mechanism rule: \"threw a grenade and killed 50 people, then it exploded\" is a superhuman physical feat, NOT temporal inversion — the explosion is a redundant normal mechanism).",
      "A deterministic repair guard also runs after classification: a low-confidence temporal_causality_inversion on a thrown-weapon/redundant-mechanism pattern is auto-repaired to superhuman_physical_feat with the normal_function_rendered_unnecessary modifier.",
    ],
    renderImpact: [
      "Selects the authored visual strategy template: the archetype's strategyBlock, core visual goal, i2i/t2i defaults, locked rules, and visualization examples are injected verbatim into the image-prompt planner under \"AUTHORED VISUAL STRATEGY (apply this — do not improvise)\".",
      "Also echoed into the planner's TAXONOMY block marked \"FIXED — DO NOT reclassify\", and the plan validator requires the plan to keep this archetype.",
      "Editing it flips existing test renders stale — rerun them to see the new strategy.",
    ],
    values: valuesFrom(PRIMARY_ARCHETYPES, PRIMARY_ARCHETYPE_DOCS),
    workedExamples: [
      {
        scenario: '"{NAME} once threw a grenade and killed 50 people, then it exploded."',
        input: "primaryArchetype: superhuman_physical_feat (NOT temporal_causality_inversion)",
        outcome:
          "The superhuman-feat strategy stages the throw as the overwhelming force with the explosion redundant — the canonical redundant-mechanism example from the classifier prompt.",
      },
      {
        scenario: '"{NAME} sneezed and the moon left orbit."',
        input: "primaryArchetype: superhuman_physical_feat + modifier astronomical_consequence",
        outcome: "Classified by mechanism (a physical act at impossible scale), not topic (space) — no cosmic archetype exists.",
      },
      {
        scenario: '"A baby drove {NAME}\'s mother home."',
        input: "primaryArchetype: authority_threat_reversal, subtype social_role_reversal",
        outcome: "The reversal strategy stages grounded human comedy — the wrong person holding the role — rather than physics.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [
      CLASSIFIER_PROMPT,
      PLANNER_TAXONOMY_BLOCK,
      {
        path: "lib/api-zod/src/visualPromptStrategies.ts",
        symbol: "getVisualPromptStrategy",
        note: "The 11 authored per-archetype strategy templates the archetype selects between.",
      },
      STALE_HASH,
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "subtype",
    label: "Mechanism Subtype",
    hint: "The archetype's refinement — picks the one-sentence visual principle the planner must apply.",
    whatItIs: [
      "Each archetype has 3–7 subtypes that pin down the joke's specific flavor (e.g. superhuman_physical_feat splits into force/strength/speed/endurance/precision/sensory scaling and ordinary-action-extreme-consequence). The subtype dropdown only offers subtypes valid for the selected archetype, and validation rejects a mismatched pair.",
    ],
    howDerived: [
      "The classifier picks the subtype from the allowed list for its chosen archetype, using the per-archetype subtype rules in its system prompt. If it emits an invalid pair, one corrective retry re-asks with the allowed list.",
    ],
    renderImpact: [
      "Injects the subtype's authored one-sentence visual principle into the planner as \"Subtype guidance for {subtype}: …\" — e.g. strength_scaled_action → \"Show the subject physically controlling an impossibly massive object while looking confident and in control.\"",
      "Echoed in the planner's FIXED taxonomy block; editing flips test renders stale.",
    ],
    values: valuesFrom(ALL_SUBTYPES, SUBTYPE_DOCS),
    workedExamples: [
      {
        scenario: '"{NAME} bench-presses the Earth." (superhuman_physical_feat)',
        input: "subtype: strength_scaled_action",
        outcome:
          "Planner receives: \"Show the subject physically controlling an impossibly massive object while looking confident and in control.\"",
      },
      {
        scenario: '"{NAME} rolled a seven on a six-sided die." (logic_formal_impossibility)',
        input: "subtype: probability_impossibility",
        outcome: "Planner shows the impossible outcome with enough context that the broken probability rule is obvious.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [
      CLASSIFIER_PROMPT,
      {
        path: "lib/api-zod/src/visualPromptStrategies.ts",
        symbol: "getSubtypeGuidance",
        note: "The per-subtype principle sentences injected into the planner.",
      },
      STALE_HASH,
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "visualLiteralness",
    label: "Depiction Style",
    hint: "How literally vs. symbolically the fact should be depicted.",
    whatItIs: [
      "A five-way classification of the depiction approach: show the fact literally as an event, abstract it symbolically, turn it into a concrete metaphor, stage it as realistic social roleplay, or mix literal and symbolic elements.",
    ],
    howDerived: [
      "The classifier judges whether the fact CAN be shown literally (most physical feats) or needs symbolic/metaphorical treatment (logic, infinity, wordplay), per the definitions in its system prompt.",
    ],
    renderImpact: [
      "Advisory to the planner: it is echoed in the TAXONOMY block so the scene-writing AI weighs it, but no deterministic compiler directive keys off it — the authored archetype strategy and modifiers do the hard steering.",
      "Despite being advisory, it IS part of the render-input hash — editing it flips test renders stale so you can rerun and compare.",
    ],
    values: valuesFrom(VISUAL_LITERALNESS_VALUES, VISUAL_LITERALNESS_DOCS),
    workedExamples: [
      {
        scenario: '"{NAME} counted to infinity. Twice."',
        input: "visualLiteralness: symbolic_abstraction",
        outcome: "The planner reaches for symbolic visual language (endless recursion imagery) instead of a person mouthing numbers.",
      },
      {
        scenario: '"A baby drove {NAME}\'s mother home."',
        input: "visualLiteralness: grounded_roleplay",
        outcome: "The planner keeps physics realistic and puts the impossibility in the social roles.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, PLANNER_TAXONOMY_BLOCK, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "visualComplexity",
    label: "Visualization Difficulty",
    hint: "The AI's rating of how hard this fact is to visualize.",
    whatItIs: [
      "A low/medium/high rating of visualization difficulty. High-complexity facts (abstract, wordplay-heavy, ambiguous) are where AI renders most often miss — the admin UI shows a \"Hard to visualize\" warning for them in both the editor and the Step-2 visual review summary.",
    ],
    howDerived: ["The classifier rates difficulty per its prompt definitions: low = straightforward, medium = needs interpretation but has clear anchors, high = abstract/wordplay/ambiguous."],
    renderImpact: [
      "Advisory to the planner only — no compiler directive branches on it. Treat 'high' as a cue to inspect test renders closely and reach for a Visual Strategy Override when the AI's interpretation misses.",
      "In the render-input hash: editing it flips test renders stale.",
    ],
    values: valuesFrom(VISUAL_COMPLEXITY_VALUES, VISUAL_COMPLEXITY_DOCS),
    workedExamples: [
      {
        scenario: 'The Step-2 "How the AI read this fact" summary shows a warning.',
        input: "visualComplexity: high",
        outcome: "\"Hard to visualize (high complexity).\" appears — your cue to scrutinize the test renders.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, PLANNER_TAXONOMY_BLOCK, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "overhypeFit",
    label: "Overhype Fit",
    hint: "Does this fact fit the positive Overhype.me product rule?",
    whatItIs: [
      "A three-way product-fit verdict against the core rule: the subject must be portrayed positively — legendary, impressive, dominant, magnetic, respected, superhuman — never pathetic, weak, humiliated, gross, or cruel.",
    ],
    howDerived: ["The classifier applies the core product rule from its system prompt: strong = clearly positive; questionable = funny but possibly confusing/negative/gross/non-visual/weakly overhyped; reject = doesn't fit without a rewrite."],
    renderImpact: [
      "NOT compiled into the prompt — this is a quality/approval gate. Taxonomy Health raises a warning for 'questionable' and an error for 'reject' (both mark the fact needs_admin_review), and the value is a filterable projected column in the admin fact list.",
      "It is NOT in the render-input hash, so editing it does not flip test renders stale (the compiled prompt doesn't depend on it).",
    ],
    values: valuesFrom(OVERHYPE_FIT_VALUES, OVERHYPE_FIT_DOCS),
    workedExamples: [
      {
        scenario: "A submitted fact whose punchline is the subject failing.",
        input: "overhypeFit: reject",
        outcome: "Taxonomy Health errors with 'fact should likely be removed or rewritten'; nothing about the render pipeline changes.",
      },
    ],
    effect: "gating-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [
      CLASSIFIER_PROMPT,
      {
        path: "artifacts/api-server/src/lib/taxonomyHealth/index.ts",
        symbol: "computeTaxonomyHealth",
        note: "The questionable/reject health flags and needs_admin_review gating.",
      },
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "adultSuitability",
    label: "Adult-Mode Compatibility",
    hint: "Whether this FACT could support adult/spicy rendering — NOT the render's SFW control.",
    whatItIs: [
      "A fact-level compatibility rating for adult/suggestive rendering. Important distinction: this does NOT set the SFW level of any render — the actual content level is the separate contentMode render control chosen at render time. This field only says whether the fact itself could ever support a spicy variant.",
      "It is explicitly not permission: runtime gates (paid status, age verification, source-image eligibility, policy) still enforce everything at render time.",
    ],
    howDerived: ["The classifier applies the definitions in its system prompt — notably the 'incompatible' list: minors, childhood, family, school, medical vulnerability, workplace/professional contexts, brands, institutions."],
    renderImpact: [
      "None on the compiled prompt. 'requires_review' raises a Taxonomy Health flag for a human decision; the value is a projected, filterable column.",
      "NOT in the render-input hash, so editing it does not flip test renders stale — the render's actual SFW/spicy level is the separate contentMode render control, not this field.",
    ],
    values: valuesFrom(ADULT_SUITABILITY_VALUES, ADULT_SUITABILITY_DOCS),
    workedExamples: [
      {
        scenario: '"{NAME} as a baby negotiated their own bedtime."',
        input: "adultSuitability: incompatible",
        outcome: "Childhood context — categorically incompatible with adult mode, regardless of user eligibility.",
      },
    ],
    effect: "gating-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  {
    key: "adultSuitabilityNotes",
    label: "Adult-Mode Notes",
    hint: "The classifier's free-text reasoning behind the adult-suitability rating.",
    whatItIs: [
      "Free text (max 500 chars) where the classifier explains WHY it chose the adult-suitability value — especially useful for 'requires_review', where it should name the ambiguity a human needs to resolve.",
    ],
    howDerived: ["Written by the classifier alongside the rating; empty when there is nothing to explain."],
    renderImpact: [
      "None — human-only. Never enters the planner message or the compiled prompt, and it is explicitly EXCLUDED from the render-input hash, so editing it does not flip test renders stale.",
    ],
    workedExamples: [
      {
        scenario: "adultSuitability came back requires_review.",
        input: 'adultSuitabilityNotes: "Workplace demo context — compatible only if framed outside the office."',
        outcome: "You read the note, decide, and adjust the rating; renders are untouched.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "modifiers",
    label: "Render Modifiers",
    hint: "Flags that inject specific directives into the engine prompt — the most direct lever on the image.",
    whatItIs: [
      "A list of flags from a 50-value known catalog (custom values allowed) that mark rendering, identity, setting, and safety constraints. They are the most direct admin lever on the final image: about 30 of them map to a literal, fixed English sentence injected into the engine prompt's SUBJECT DETAILS section.",
      "Unknown (custom) modifiers render as amber chips. They carry no fixed directive — the prompt planner sees them as raw context only, so their effect depends on the AI's interpretation. If a custom modifier should have a guaranteed effect, it needs a directive added in code.",
    ],
    howDerived: [
      "The classifier prefers known modifiers from its catalog and may add a custom one only when no known modifier captures an important rendering, discovery, identity, setting, or safety constraint. Admins freely add/remove them here.",
    ],
    renderImpact: [
      "Mapped modifiers inject their exact directive sentence (see per-value docs below — each quotes the literal text). Age/life-stage modifiers (baby_child_version, older_self_version, age_transform, …) additionally force the compiler's SUBJECT BINDING section, guaranteeing the reference person IS the transformed person (never a separate generic baby/elder added beside them).",
      "Setting/location modifiers (office_setting, gym_setting, …) and taxonomy-only flags have NO fixed directive — they are deliberately planner-context only, because the authored strategy and scene already cover setting.",
      "Three modifiers (cinematic_aftermath, projectile_impact_power, action_comedy) also mark the fact violence-relevant, which permits the default violence-allow line in the prompt.",
      "Editing modifiers flips test renders stale.",
    ],
    values: valuesFrom(KNOWN_FACT_MODIFIERS, KNOWN_MODIFIER_DOCS),
    workedExamples: [
      {
        scenario: '"{NAME} as a baby negotiated their own bedtime." — render shows an adult plus a random baby.',
        input: 'Add modifier: "baby_child_version"',
        outcome:
          'The compiler injects: "De-age the reference subject into the baby/child the fact describes — the same person rendered at that life stage… Do not add a separate, generic baby or child, and do not keep an adult version in the frame." Plus a SUBJECT BINDING section enforcing one entity.',
      },
      {
        scenario: "A render keeps drawing readable gibberish signage.",
        input: 'Add modifier: "no_readable_text"',
        outcome: 'Injects: "Keep all surfaces free of readable text, captions, and labels."',
      },
      {
        scenario: 'You add a custom modifier "sepia_flashback".',
        input: 'modifiers: [..., "sepia_flashback"] (amber chip)',
        outcome: "No fixed directive exists — the planner sees the token as context and may or may not honor it. Check the test render.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [
      {
        path: "artifacts/api-server/src/lib/imagePrompt/modifierDirectives.ts",
        symbol: "modifierDirectives",
        note: "The literal modifier→directive sentences quoted in the per-value docs.",
      },
      CLASSIFIER_PROMPT,
      STALE_HASH,
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "finalHashtags",
    label: "Final hashtags",
    labelSuffix: "— these ship on approval",
    hint: "The discovery tags that actually attach to the live fact when you approve.",
    whatItIs: [
      "The authoritative tag list for this fact. Whatever chips are here when you click Approve become the fact's live discovery hashtags. The 'AI suggested' row below feeds this list but ships nothing by itself.",
    ],
    howDerived: [
      "Priority on approval: tags you set here win; if empty, the submitter's tags are used; if those are empty too, the AI's suggested hashtags are the fallback. All are normalized (lowercase alphanumeric) and the subject/app names ('alex', 'overhype') are always stripped.",
    ],
    renderImpact: ["None — hashtags never enter the render pipeline. They are product metadata for discovery/browse."],
    workedExamples: [
      {
        scenario: "AI suggested [strength, legendary, earth]; you want a different focus.",
        input: 'Final hashtags: ["gymlife", "legendary", "strength"]',
        outcome: "Exactly those three attach to the live fact on approval; the unused AI suggestions are discarded.",
      },
    ],
    effect: "product-metadata",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [
      {
        path: "artifacts/api-server/src/lib/hashtags.ts",
        symbol: "resolveFinalApprovalTags",
        note: "The moderator > submitter > AI-suggested priority and normalization at approval.",
      },
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "aiSuggestedHashtags",
    label: "AI suggested",
    hint: "The classifier's tag ideas — a source list you can pull from, never shipped directly.",
    whatItIs: [
      "Read-only chips showing what the enrichment AI proposed (3–8 tags). Use '+' to pull one into Final hashtags, or 'Add all'. If Final hashtags is left empty at approval, these become the fallback source.",
    ],
    howDerived: [
      "Generated by the enrichment classifier under its hashtag rules: 3–8 reusable lowercase discovery tags; never the subject's name ('alex' — the canonical placeholder) or the app's name ('overhype'/'overhypeme') — both are also stripped deterministically after the model runs, with an automatic re-ask if stripping drops the list below 3.",
    ],
    renderImpact: ["None — never enters the render pipeline."],
    workedExamples: [
      {
        scenario: 'Fact: "{NAME} can hear WiFi."',
        input: "AI suggested: [wifi, superhearing, technology]",
        outcome: "You tap '+' on the ones worth keeping; they move into Final hashtags.",
      },
    ],
    effect: "product-metadata",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  {
    key: "suggestedHashtags",
    label: "Suggested Hashtags",
    labelSuffix: "(3–8)",
    hint: "The AI's stored tag list on a live fact — editable here, used as the fallback tag source.",
    whatItIs: [
      "On the Facts page (live facts), this edits the enrichment blob's stored suggestedHashtags directly: 3–8 lowercase alphanumeric tags, normalized and de-duplicated on entry.",
    ],
    howDerived: ["Same classifier rules as 'AI suggested' (this IS that list, stored). The subject name and app name are excluded by prompt rule + a deterministic post-filter."],
    renderImpact: ["None — never enters the render pipeline, and explicitly excluded from the render-input hash."],
    workedExamples: [
      {
        scenario: "A live fact's tags feel off.",
        input: 'Edit to: ["strength", "legendary", "gym"]',
        outcome: "Saved with the enrichment; render scenarios are NOT flagged stale (hashtags are excluded from the hash).",
      },
    ],
    effect: "product-metadata",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "taxonomyConfidence",
    label: "AI Classification Confidence",
    hint: "The classifier's 0–1 confidence in its own archetype/subtype call. Read-only.",
    whatItIs: [
      "The model's self-reported confidence (0–1) in the taxonomy classification. Below 0.75, Taxonomy Health raises a low-confidence flag and marks the fact needs_admin_review — your cue to sanity-check the archetype/subtype yourself.",
      "Read-only here: it describes the AI's classification event and is not meaningfully hand-editable.",
    ],
    howDerived: ["Emitted by the classifier with each classification; the deterministic redundant-mechanism repair caps it at 0.49 when it rewrites a misclassification, keeping the fact flagged for review."],
    renderImpact: [
      "Advisory only: echoed to the planner as context, never compiled, and explicitly excluded from the render-input hash.",
    ],
    workedExamples: [
      {
        scenario: "The Step-2 summary shows 'Low classification confidence — sanity-check it.'",
        input: "taxonomyConfidence: 0.62",
        outcome: "Below the 0.75 threshold — review the archetype/subtype before trusting the renders.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "not-applicable",
    sourceRefs: [
      CLASSIFIER_PROMPT,
      {
        path: "artifacts/api-server/src/lib/taxonomyHealth/index.ts",
        symbol: "LOW_CONFIDENCE_THRESHOLD",
        note: "The 0.75 low-confidence health threshold.",
      },
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "adminReviewNotes",
    label: "Admin Review Notes",
    hint: "Your notes to yourself and other admins — never seen by any AI or user.",
    whatItIs: [
      "Free text (max 800 chars) for human context: why you overrode something, what to watch for, open questions. The deterministic repair guard also appends its own notes here when it auto-corrects a misclassification.",
      "Taxonomy Health treats a non-empty note as evidence a human has reviewed the fact.",
    ],
    howDerived: ["Written by admins (and appended to by the repair guard). The classifier itself starts it empty."],
    renderImpact: [
      "None — human-only. Never enters the planner or compiled prompt; excluded from the render-input hash, so editing it never flips renders stale.",
    ],
    workedExamples: [
      {
        scenario: "You approved despite a questionable fit.",
        input: 'adminReviewNotes: "Fit is borderline but the visual is great — approved 7/2."',
        outcome: "Context preserved for the next admin; nothing else in the system changes.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [STALE_HASH],
    authoredStatus: "code-derived",
  },
];
