/**
 * Field docs — "Cultural / Inside References" + "Semantic Entities / Visual
 * Referents" sections (18 fields) + the enum value-docs (reference type,
 * entity kind, capitalization signal).
 *
 * Pure data. Meanings are extracted from the classifier system prompt
 * (FACT_ENRICHMENT_SYSTEM_DEFAULT), the schemas in taxonomy.ts, and the traced
 * planner/validator/compiler pipeline — see sourceRefs on each record. Enum
 * values without upstream prose are authored and flagged
 * `authored-needs-david-review`.
 */

import {
  REFERENCE_TYPE_VALUES,
  SEMANTIC_ENTITY_KIND_VALUES,
  CAPITALIZATION_SIGNAL_VALUES,
  type ReferenceType,
  type SemanticEntityKind,
  type CapitalizationSignal,
} from "@workspace/api-zod";
import { valuesFrom, type FieldDoc, type ValueDoc, type FieldDocSourceRef } from "./types";

// Shared source refs used across these sections.
const CLASSIFIER_PROMPT: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factEnrichmentConfig.ts",
  symbol: "FACT_ENRICHMENT_SYSTEM_DEFAULT",
  note: "The classifier system prompt — the cultural-reference and semantic-entity/capitalization rules plus their worked examples.",
};
const TAXONOMY_SCHEMAS: FieldDocSourceRef = {
  path: "lib/api-zod/src/taxonomy.ts",
  symbol: "culturalReferenceSchema",
  note: "The reference/entity schemas: field shapes, max lengths, and the research-metadata fields.",
};
const PLANNER_BLOCKS: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/generator.ts",
  symbol: "buildImagePromptUserMessage",
  note: "Where references/entities are injected into the planner message, including the materiality gate and the never-draw-a-real-logo instruction.",
};
const MATERIALITY_GATE: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/generator.ts",
  symbol: "isMaterialCulturalReference",
  note: 'A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review.',
};
const VALIDATOR: FieldDocSourceRef = {
  path: "lib/api-zod/src/imagePromptGeneration.ts",
  symbol: "validateImagePromptPlan",
  note: "Rules 14/15: material entities/references MUST be echoed back in the visual plan; a violation triggers one corrective retry.",
};
const COMPILER_GAP_FILL: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts",
  symbol: "composeKeyElementsDirective",
  note: 'The compiler-side guarantee: resolved visualImplicationUsed / visualReferentUsed values the prose omitted are folded into "Ensure these elements are clearly visible: …".',
};
const STALE_HASH: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factRenderScenarios.ts",
  symbol: "renderAffectingEnrichment",
  note: "The render-input hash includes culturalReferences and semanticEntities wholesale — editing any row field flips render-scenario tiles stale.",
};
const SUBJECT_STRIP: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/renderCanonical.ts",
  symbol: "stripSubjectNameSemanticEntities",
  note: "The subject-name defense: the personalized subject is never a semantic entity, even if an older enrichment stored it as one.",
};

// ─── Reference-type value-docs ───────────────────────────────────────────────

export const REFERENCE_TYPE_DOCS = {
  cultural_reference: {
    meaning: "The joke leans on a shared cultural artifact or phenomenon — a TV show, event, meme, tradition — that isn't named literally.",
    renderImpact:
      "The reference (with its visual implication) is injected into the planner's PER-FACT CULTURAL REFERENCES block; if material, the planner must bake the implication into the scene.",
    example: '"Sharks have a {NAME} Week" → cultural_reference, canonical "Shark Week" — sharks become the audience watching the subject as spectacle.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  brand_reference: {
    meaning: "The joke depends on a real brand or company (\"Victoria's Secret\", \"Apple\") — typically also flagged requiresAdminReview.",
    renderImpact:
      "Informs the planner's interpretation, but the canonical brand name is NEVER compiled into the engine prompt, and the planner is told to never draw a real logo or brand mark — only the brand's visual implication reaches the scene.",
    example: 'A "{NAME}\'s secret" wordplay on Victoria\'s Secret → the scene gets the runway-glamour implication, no logo.',
    sourceRefs: [CLASSIFIER_PROMPT, PLANNER_BLOCKS],
    authoredStatus: "code-derived",
  },
  workplace_context: {
    meaning: "The joke needs knowledge of a specific workplace or company context the audience shares.",
    renderImpact: "Planner context: the scene is staged inside the implied workplace world; usually requiresAdminReview (real workplace).",
    example: '"{NAME} doesn\'t prepare for demos, demos prepare for {NAME}. #Yardi" → the Yardi/SaaS-presales demo context.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  professional_domain_context: {
    meaning: "The joke needs domain-professional knowledge (how presales demos, courtrooms, or trading floors work) rather than a specific employer.",
    renderImpact: "Planner context: the scene borrows the domain's recognizable staging (demo screens, gavels, tickers) so the joke reads.",
    example: "The same Yardi demo fact classified for its presales-demo domain rather than the employer per se.",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  idiom_or_phrase: {
    meaning: "The joke reuses a familiar phrase, idiom, or saying whose recognition is the hook.",
    renderImpact: "Planner context: the visual implication usually literalizes the idiom; there may be no canonicalReference (empty is allowed).",
    example: '"{NAME}\'s handshake seals deals" riffing on "seal the deal" → a literal wax seal in the scene.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  wordplay: {
    meaning: "The joke's hook is a pun or double meaning in the words themselves.",
    renderImpact: "Planner context: the scene typically needs BOTH meanings visible for the pun to land — the visual implication should say how.",
    example: 'A "{NAME} raised the bar" fact → a literal bar being physically raised in a gym.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  mechanism_knowledge: {
    meaning: "The joke depends on knowing how something normally works, so the impossibility registers.",
    renderImpact: "Planner context: the scene must show the mechanism being defied clearly enough that a viewer who knows it gets the joke.",
    example: '"{NAME} can set an ant on fire with a magnifying glass. At night." → magnifying glasses focus SUNlight; nighttime breaks the mechanism.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  inside_reference: {
    meaning: "The joke references something only a specific in-group (a friend circle, a team, a community) will recognize.",
    renderImpact: "Planner context: often low-confidence and requiresAdminReview — the AI can't verify an inside joke, so a human should confirm the implication.",
    example: "A fact riffing on a submitter's group chat catchphrase — flagged for review because the AI is guessing at the referent.",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
} satisfies Record<ReferenceType, ValueDoc>;

// ─── Semantic-entity kind value-docs ─────────────────────────────────────────
//
// The classifier prompt defines the mechanism (capitalization-aware referent
// resolution) and gives worked examples for several kinds; kinds without
// upstream prose are authored from the value names and flagged for review.

export const SEMANTIC_ENTITY_KIND_DOCS = {
  proper_noun: {
    meaning: "A capitalized proper noun naming a specific thing that isn't better covered by a more specific kind.",
    renderImpact: "The visual referent pins WHICH specific thing the scene shows, treated by the planner as the locked meaning of the term.",
    example: '"Everest" in a climbing fact → the specific mountain, not a generic peak.',
    authoredStatus: "authored-needs-david-review",
  },
  common_noun: {
    meaning: "A lowercase common noun whose everyday meaning is the right reading — recorded when it could be confused with a capitalized referent.",
    renderImpact: "Locks the mundane interpretation so the planner doesn't upgrade it to the named entity.",
    example: '"earth" → dirt, soil, ground, or terrain — NOT the planet.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  named_entity: {
    meaning: "A specific named person, character, work, or event (other than the fact's subject — the subject is never listed).",
    renderImpact: "The planner renders the specific entity's recognizable characteristics per the visual referent.",
    example: '"Godzilla" in a size fact → the famous kaiju silhouette, per its visualReferent.',
    authoredStatus: "authored-needs-david-review",
  },
  brand_or_cultural_reference: {
    meaning: "The term is a brand or cultural reference ('Apple' the company, not the fruit) — usually paired with a culturalReferences entry.",
    renderImpact: "Locks the brand/cultural reading for the planner; as always, no real logo or brand mark is ever drawn — only the visual implication.",
    example: '"Apple" capitalized mid-sentence → the technology company, rendered as sleek-device context, never the logo.',
    sourceRefs: [CLASSIFIER_PROMPT, PLANNER_BLOCKS],
    authoredStatus: "code-derived",
  },
  abstract_concept: {
    meaning: "An abstraction (infinity, probability, time) that has no direct physical form.",
    renderImpact: "The visual referent must translate the abstraction into something showable; expect symbolic staging.",
    example: '"infinity" in a counting fact → an endless receding number-scape as the referent.',
    authoredStatus: "authored-needs-david-review",
  },
  personified_concept: {
    meaning: "A concept treated as a character in this fact — capitalization often signals it ('Law', 'Death', 'Gravity').",
    renderImpact: "The planner renders the concept as a figure per the visual referent, rather than as its abstract meaning.",
    example: '"Law" capitalized as an actor in the sentence → a personified authority figure, per the classifier\'s Law/law example.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  physical_object: {
    meaning: "A concrete object whose specific reading matters to the joke (which kind of 'bar', which 'mouse').",
    renderImpact: "Pins the object's interpretation so the scene shows the right thing.",
    example: '"mouse" in a tech fact → the computer peripheral, not the animal.',
    authoredStatus: "authored-needs-david-review",
  },
  place: {
    meaning: "A location whose identity matters — a named place or a specific kind of setting.",
    renderImpact: "The scene is staged in the pinned location per the visual referent.",
    example: '"Paris" → the city with recognizable landmarks, not the mythological figure.',
    authoredStatus: "authored-needs-david-review",
  },
  celestial_body: {
    meaning: "A named astronomical object — the classifier's flagship capitalization case.",
    renderImpact: "Locks the astronomical reading; the resolved referent (e.g. 'the planet Earth seen from orbit') is guaranteed to reach the engine prompt.",
    example: '"Earth" → the planet Earth; "Sun" → the named celestial body (or a personified entity, depending on context).',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  institution_or_system: {
    meaning: "An institution or a system of rules ('the Law' as the legal system, 'the Church', 'the Market').",
    renderImpact: "The planner stages the institution's recognizable trappings (courtrooms, trading floors) per the visual referent.",
    example: '"law" lowercase → legal rules generally; "Law" may indicate a title or an institution, per the classifier examples.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  ambiguous: {
    meaning: "The AI could not confidently resolve the referent — the interpretation is a guess that a human should settle.",
    renderImpact: "The classifier sets requiresAdminReview for ambiguous kinds; the tentative referent still informs the planner until you correct it.",
    example: "A sentence-initial capitalized term with two plausible readings — the AI picks one and flags the row for review.",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
} satisfies Record<SemanticEntityKind, ValueDoc>;

// ─── Capitalization-signal value-docs ────────────────────────────────────────

export const CAPITALIZATION_SIGNAL_DOCS = {
  capitalized_named_entity: {
    meaning: "The term is capitalized mid-sentence, signaling a named entity ('Earth', 'Apple', 'Shark Week').",
    renderImpact: "Supports the named-entity reading of the visual referent — capitalization is a strong signal, but never the sole basis.",
    example: '"…lifted Earth…" → capitalized mid-sentence → the planet.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  lowercase_common_noun: {
    meaning: "The term is lowercase, signaling the everyday common-noun reading.",
    renderImpact: "Supports the mundane referent (soil, fruit, sunlight) over the named entity.",
    example: '"…moved the earth beneath them…" → lowercase → soil/ground.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  sentence_initial_ambiguous: {
    meaning: "The term is capitalized only because it starts the sentence — casing carries NO signal, so the referent was inferred from context alone.",
    renderImpact: "The classifier's rule: set this signal, set requiresAdminReview to true, and infer the referent from context. Your review decides whether the inference was right.",
    example: '"Earth trembled when {NAME} stepped." → sentence-initial: planet or ground? Flagged for a human call.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  all_caps_presentation_ignored: {
    meaning: "The term appears in ALL CAPS for emphasis/styling — the shouting is presentation, not a semantic signal, and was ignored.",
    renderImpact: "The referent was resolved as if the term were normally cased; the caps carry no interpretation weight.",
    example: '"{NAME} BENCH-PRESSED THE EARTH" → styling caps ignored; context decides planet vs ground.',
    authoredStatus: "authored-needs-david-review",
  },
  mixed_case_brand_or_title: {
    meaning: "The term's distinctive mixed casing marks a brand or title (iPhone, YouTube, eBay).",
    renderImpact: "Supports the brand/title reading of the referent — with the usual no-logo rule downstream.",
    example: '"iPhone" → the branded device category, casing itself being the tell.',
    authoredStatus: "authored-needs-david-review",
  },
  not_relevant: {
    meaning: "Capitalization played no role in this interpretation — the entry exists for a non-casing reason (pure ambiguity, cultural reference).",
    renderImpact: "The visual referent stands on context alone; the casing axis is simply not part of the reasoning.",
    example: "An entity recorded because its wordplay reading matters, where either casing would read the same.",
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<CapitalizationSignal, ValueDoc>;

// ─── Shared render-impact prose (both collections ride the same pipeline) ────

const REF_PIPELINE_NOTE =
  "Pipeline: classifier detects → planner is informed → validator force-echoes material items → compiler guarantees the concrete visual reaches the engine.";

// ─── Field docs ──────────────────────────────────────────────────────────────

export const REFERENCES_ENTITIES_FIELD_DOCS: FieldDoc[] = [
  {
    key: "culturalReferences",
    label: "Cultural / Inside References",
    hint: "Outside-context dependencies the joke relies on — with a materiality gate deciding which ones the render MUST honor.",
    whatItIs: [
      "The list of outside-context dependencies detected during enrichment: knowledge the joke relies on that isn't obvious from the literal words — a brand, a workplace/professional context, an idiom, wordplay, mechanism knowledge, or an inside reference. A fact with no such dependency has an empty list (there is deliberately no 'none' type).",
      "Each row is fully editable, and the per-row 'Research Reference' tool can verify a reference and stamp research metadata (researchConfidence, sources, notes, ambiguity warnings) that both the admin and the planner see.",
      "References inform HOW to render the joke; they never change the archetype/subtype — the taxonomy classifies the mechanism, references flesh out the rendering.",
    ],
    howDerived: [
      "The classifier emits them under its cultural-reference rules, with the canonical worked examples: \"Sharks have a {NAME} Week\" → cultural_reference 'Shark Week' (visual implication: sharks are the audience watching the subject as spectacle); the Yardi demo fact → workplace/professional_domain_context; the magnifying-glass-at-night fact → mechanism_knowledge.",
    ],
    renderImpact: [
      "Every reference (with research context when present) is injected into the planner's PER-FACT CULTURAL REFERENCES block, each marked material=true/false. The MATERIALITY GATE: a reference is material when researchConfidence is \"high\", OR confidence ≥ 0.8 AND it is not flagged for admin review. Ambiguous/review-flagged references are context only — never forced (they may be wrong).",
      "FORCE-ECHO (validator rule 15): every material reference MUST be echoed back in visualPlan.culturalReferencesUsed (sourcePhrase verbatim + canonicalReferenceUsed + visualImplicationUsed + effectOnVisualPlan, all non-empty). A miss triggers one corrective retry re-asking the planner with the exact requirement.",
      'The planner is instructed to "Bake the reference\'s visual implication into keyVisualElements + the compiledPrompt.prompt, but never draw a real logo or brand mark." The compiler then guarantees delivery: any echoed visualImplicationUsed the prose omitted is folded into "Ensure these elements are clearly visible: …". The canonical reference and explanation are NEVER compiled — re-emitting them would leak meta-instruction and brand names (e.g. "Discovery Channel") into the engine prompt.',
      "The whole collection is in the render-input hash — editing any row flips render-scenario tiles stale.",
      REF_PIPELINE_NOTE,
    ],
    workedExamples: [
      {
        scenario: '"Sharks have a {NAME} Week." — confidence 0.9, not flagged.',
        input: 'cultural_reference, canonical "Shark Week", visualImplication "sharks are the audience watching the subject as spectacle"',
        outcome: "Material → the plan MUST echo it, and sharks-as-audience is guaranteed visible in the render; the words 'Shark Week'/'Discovery Channel' never reach the engine.",
      },
      {
        scenario: '"{NAME} can set an ant on fire with a magnifying glass. At night." — mechanism_knowledge.',
        input: 'visualImplication: "a magnifying glass focusing a beam under a starry night sky — the impossible part"',
        outcome: "The night-beam visual is echoed and gap-filled into the prompt so the mechanism-defiance reads.",
      },
      {
        scenario: "A brand reference at confidence 0.6 with requiresAdminReview=true.",
        input: "(unchanged, unresearched)",
        outcome: "NOT material: the planner sees it as context but is never forced to honor it. Running Research Reference to high confidence makes it material.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, PLANNER_BLOCKS, MATERIALITY_GATE, VALIDATOR, COMPILER_GAP_FILL, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.sourcePhrase",
    label: "Source phrase",
    hint: "The literal phrase in the fact that triggers the reference — also the echo-match key.",
    whatItIs: [
      "The verbatim word/phrase in the fact text that carries the reference (max 300 chars). It doubles as the reference's identity: the validator matches the plan's echo-back against it case-insensitively (falling back to the canonical reference when empty).",
    ],
    howDerived: ["The classifier quotes it from the fact; editable for manual-fill workflows."],
    renderImpact: ["Shown to the planner in the reference block; for material references, the plan must echo this exact sourcePhrase in culturalReferencesUsed or the corrective retry fires."],
    workedExamples: [
      {
        scenario: '"Sharks have a {NAME} Week."',
        input: 'sourcePhrase: "{NAME} Week"',
        outcome: "The plan's culturalReferencesUsed entry must carry this sourcePhrase verbatim (case-insensitive match).",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, VALIDATOR, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.referenceType",
    label: "Reference type",
    hint: "What KIND of outside-context dependency this is.",
    whatItIs: [
      "An eight-way categorization of the dependency (see the per-value docs). There is intentionally no 'none' value — a fact without references has an empty list instead.",
    ],
    howDerived: ["Chosen by the classifier per its rules; the canonical examples map Shark Week → cultural_reference, Yardi → workplace/professional_domain_context, the night magnifying glass → mechanism_knowledge."],
    renderImpact: ["Planner context only — it labels the dependency in the reference block. The materiality gate and echo rules don't branch on type, though brand/workplace types usually arrive with requiresAdminReview=true (which does affect materiality)."],
    values: valuesFrom(REFERENCE_TYPE_VALUES, REFERENCE_TYPE_DOCS),
    workedExamples: [
      {
        scenario: "The Yardi demo fact.",
        input: "referenceType: professional_domain_context",
        outcome: "The planner reads the joke through the SaaS-presales-demo lens when staging the scene.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.canonicalReference",
    label: "Canonical reference",
    hint: "The reference's canonical name — planner context that NEVER reaches the engine prompt.",
    whatItIs: [
      "The canonical name/source of the reference (e.g. \"Shark Week\", \"Victoria's Secret\"; max 300 chars). May be empty when no single canonical name exists (common for idioms). Also the echo-match fallback when sourcePhrase is empty.",
    ],
    howDerived: ["Named by the classifier; the Research Reference tool corrects/confirms it."],
    renderImpact: [
      "Planner context only — and deliberately NEVER compiled into the engine prompt: emitting it would leak brand names into the render. Only the reference's concrete visual implication travels; the planner is told never to draw a real logo or brand mark.",
    ],
    workedExamples: [
      {
        scenario: "Shark Week reference on a live render.",
        input: 'canonicalReference: "Shark Week"',
        outcome: "The planner knows exactly which phenomenon is meant; the engine prompt contains sharks-as-audience visuals but never the words 'Shark Week'.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, PLANNER_BLOCKS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.explanation",
    label: "Explanation",
    hint: "The plain-language joke mechanism the reference enables — planner context, never compiled.",
    whatItIs: ["A plain-language explanation of how the reference makes the joke work (max 800 chars)."],
    howDerived: ["Written by the classifier; directly editable per the admin workflow."],
    renderImpact: [
      "Read by the planner when interpreting the fact, but never compiled into the engine prompt — an 'explaining the joke' line is meta-instruction the image engine can't use.",
    ],
    workedExamples: [
      {
        scenario: "The magnifying-glass fact.",
        input: 'explanation: "Magnifying glasses need sunlight to burn; doing it at night is the impossibility."',
        outcome: "The planner stages the mechanism-defiance; the sentence itself never reaches the engine.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, PLANNER_BLOCKS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.visualImplication",
    label: "Visual implication",
    hint: "THE load-bearing field: how the reference should change the rendered scene — this is what actually reaches the engine.",
    whatItIs: [
      "How the reference should change the visual interpretation of the scene (max 800 chars). Write it as a CONCRETE visual ('sharks are the audience watching the subject as spectacle'), not analysis — for a material reference this text, as echoed by the planner, is what the render is guaranteed to contain.",
    ],
    howDerived: ["Written by the classifier and refined by admins/research — the single most render-worthy edit in a reference row."],
    renderImpact: [
      'For material references the planner must echo it as visualImplicationUsed and bake it into keyVisualElements + the prompt. If the prose still omitted it, the compiler gap-fills it into "Ensure these elements are clearly visible: …" — so the implication reaches the engine while brand names never do.',
    ],
    workedExamples: [
      {
        scenario: "Shark Week reference.",
        input: 'visualImplication: "sharks are the audience watching the subject as spectacle"',
        outcome: "Sharks-on-couches-watching-TV staging is forced into the plan and guaranteed visible in the compiled prompt.",
      },
      {
        scenario: "A vague implication.",
        input: 'visualImplication: "make it feel like the TV event"',
        outcome: "Weak — nothing concrete to gap-fill. Rewrite it as a visible thing the scene must contain.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, PLANNER_BLOCKS, VALIDATOR, COMPILER_GAP_FILL, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.confidence",
    label: "Confidence",
    hint: "0–1: how confident the AI is that this reference is the joke's actual hook — half of the materiality gate.",
    whatItIs: ["The classifier's 0–1 confidence that the reference is the joke's real hook. Editable — raising or lowering it directly moves the reference across the materiality threshold."],
    howDerived: ["Emitted by the classifier per reference; admins adjust it when they know better."],
    renderImpact: [
      "Materiality gate input: confidence ≥ 0.8 (with requiresAdminReview false) makes the reference material — force-echoed into the plan and guaranteed in the render. Below the bar (unless researchConfidence is high) it is planner context only.",
    ],
    workedExamples: [
      {
        scenario: "A correct reference sitting at 0.7.",
        input: "You raise confidence to 0.9 (review unchecked).",
        outcome: "It crosses the gate: the next plan MUST echo it, and its visual implication is guaranteed in the prompt.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, MATERIALITY_GATE, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.requiresAdminReview",
    label: "Requires admin review",
    hint: "Human sanity-check flag — while set, the reference can't be forced into renders (unless research verified it).",
    whatItIs: [
      "Set true by the classifier when the reference touches a real brand, workplace, or professional context, or is otherwise ambiguous and worth a human check.",
    ],
    howDerived: ["Classifier-set per its rules; you uncheck it once you've confirmed the reference."],
    renderImpact: [
      "It blocks materiality: a flagged reference is never force-echoed regardless of confidence — EXCEPT when researchConfidence is \"high\" (verified research overrides the flag). Unchecking it (with confidence ≥ 0.8) makes the reference material.",
    ],
    workedExamples: [
      {
        scenario: "A Yardi workplace reference, confidence 0.85, flagged for review.",
        input: "You confirm it and uncheck the box.",
        outcome: "The reference becomes material — future plans must honor it.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, MATERIALITY_GATE, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "semanticEntities",
    label: "Semantic Entities / Visual Referents",
    hint: "Capitalization-aware term disambiguations the planner must treat as the LOCKED meaning of the fact's words.",
    whatItIs: [
      "The list of surface terms whose interpretation materially matters for the image — 'Earth' the planet vs 'earth' the soil being the flagship case. Casing is preserved verbatim (never normalized before interpretation; the classifier reads factTextExact), and only terms whose reading changes the image are listed — never every noun, and NEVER the fact's subject.",
      "Subject-name defense: the subject (the canonical placeholder 'Alex') is categorically not a semantic entity — the classifier is forbidden from listing it, and a deterministic strip removes it from older enrichments defensively, so it is never force-echoed or baked in. The subject's identity is owned by the personalization/rendering layer.",
    ],
    howDerived: [
      "The classifier applies the capitalization examples: earth/Earth (soil vs planet), apple/Apple (fruit vs company), sun/Sun (sunlight vs the named body or a personification), law/Law (legal rules vs a title/institution). Capitalization is a strong signal but never the sole basis; sentence-initial capitalization yields capitalizationSignal=sentence_initial_ambiguous + requiresAdminReview=true with the referent inferred from context.",
    ],
    renderImpact: [
      'Entities are injected into the planner\'s SEMANTIC ENTITY INTERPRETATION block, labeled "hard visual context — DO NOT override; treat as the locked meaning of the surface term in this fact".',
      "FORCE-ECHO (validator rule 14): every entity with materiallyAffectsVisualPrompt=true MUST be echoed in visualPlan.semanticEntitiesUsed (surfaceText verbatim, non-empty visualReferentUsed + effectOnVisualPlan). A miss triggers one corrective retry.",
      'The engine never sees an "Interpret X means Y" meta line — the planner resolves the ambiguity into the concrete scene, and the compiler gap-fills any omitted visualReferentUsed into "Ensure these elements are clearly visible: …" so the resolved referent (e.g. "the planet Earth seen from orbit") is guaranteed visible.',
      "Entities never change the archetype/subtype — they are render context, not taxonomy. The whole collection is in the render-input hash, so edits flip render-scenario tiles stale.",
      REF_PIPELINE_NOTE,
    ],
    workedExamples: [
      {
        scenario: '"{NAME} bench-presses the Earth."',
        input: 'surfaceText "Earth", entityKind celestial_body, visualReferent "the planet Earth", materiallyAffects ✓',
        outcome: "The plan must echo it; the render is guaranteed to show the planet, not a pile of soil.",
      },
      {
        scenario: '"{NAME} moved the earth with one hand."',
        input: 'surfaceText "earth", entityKind common_noun, capitalizationSignal lowercase_common_noun, visualReferent "ground, dirt, soil, or terrain"',
        outcome: "The mundane reading is locked — no planet appears.",
      },
      {
        scenario: 'An old enrichment stored "Alex" as an entity.',
        input: "(nothing to do)",
        outcome: "The defensive strip removes it before planning — the subject is never a semantic entity, so it can't be force-echoed or baked in.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, PLANNER_BLOCKS, VALIDATOR, COMPILER_GAP_FILL, SUBJECT_STRIP, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.surfaceText",
    label: "Surface text",
    labelSuffix: "(verbatim case)",
    hint: "The term exactly as it appears in the fact — casing preserved; also the echo-match key.",
    whatItIs: [
      "The term verbatim from the fact, casing intact (max 120 chars) — 'Earth' and 'earth' are different surface texts, and that difference is the point. Do not normalize it; normalizedText holds the lowercase form.",
    ],
    howDerived: ["Quoted by the classifier from factTextExact."],
    renderImpact: [
      "For material entities, the plan's semanticEntitiesUsed must contain this surfaceText (case-insensitive match) or the corrective retry fires. Entities whose surfaceText is a raw template token (e.g. literally \"{NAME}\") are filtered from the required echo list — the planner sees the rendered fact and can't echo a token.",
    ],
    workedExamples: [
      {
        scenario: "The Earth bench-press fact.",
        input: 'surfaceText: "Earth"',
        outcome: 'The echo entry must carry "Earth"; the preserved capital is what justified the celestial reading.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, VALIDATOR, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.normalizedText",
    label: "Normalized text",
    hint: "The lowercase comparable form of the surface text.",
    whatItIs: ["The lowercase form used for comparisons (max 120 chars) — 'earth' for both 'Earth' and 'EARTH'."],
    howDerived: ["Emitted by the classifier alongside the surface text."],
    renderImpact: ["Bookkeeping only — the planner block and the echo-match key both use surfaceText; this field exists as the case-insensitive comparable form."],
    workedExamples: [
      {
        scenario: 'surfaceText "Earth".',
        input: 'normalizedText: "earth"',
        outcome: "The pair records both the meaningful casing and the comparable form.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.entityKind",
    label: "Entity kind",
    hint: "WHAT the term refers to in this fact — planet, brand, personified concept, plain object…",
    whatItIs: [
      "An eleven-way classification of the referent's kind (see the per-value docs). It is render context, not taxonomy — resolving 'Earth' to the planet never changes the archetype/subtype.",
    ],
    howDerived: ["Chosen by the classifier per its capitalization/context rules; 'ambiguous' pairs with requiresAdminReview."],
    renderImpact: ["Shown in the planner's locked-interpretation block; the concrete steering comes from visualReferent, with the kind labeling why the reading holds."],
    values: valuesFrom(SEMANTIC_ENTITY_KIND_VALUES, SEMANTIC_ENTITY_KIND_DOCS),
    workedExamples: [
      {
        scenario: '"Apple" capitalized mid-sentence in a tech fact.',
        input: "entityKind: brand_or_cultural_reference",
        outcome: "The company reading is locked — with the standard never-draw-a-real-logo rule downstream.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.capitalizationSignal",
    label: "Capitalization signal",
    hint: "What the term's casing contributed to this interpretation — sentence-initial ambiguity is the classic review trigger.",
    whatItIs: [
      "A six-way record of what signal the surface casing carried (see the per-value docs). Sentence-initial ambiguity is the common reason an otherwise-confident entry needs admin review.",
    ],
    howDerived: [
      "The classifier uses capitalization as a strong signal but never alone; when a word is capitalized only because it begins the sentence, it sets sentence_initial_ambiguous + requiresAdminReview=true and infers the referent from context.",
    ],
    renderImpact: ["Documents the reasoning shown to the planner; the scene itself follows visualReferent. Its main operational effect is flagging the sentence-initial case for your review."],
    values: valuesFrom(CAPITALIZATION_SIGNAL_VALUES, CAPITALIZATION_SIGNAL_DOCS),
    workedExamples: [
      {
        scenario: '"Earth trembled when {NAME} stepped."',
        input: "capitalizationSignal: sentence_initial_ambiguous (requiresAdminReview auto-true)",
        outcome: "You decide planet vs ground; the AI's context-based guess stands until you do.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.visualReferent",
    label: "Visual referent",
    hint: "The concrete interpretation that actually steers the scene — for material entities, guaranteed to reach the engine.",
    whatItIs: [
      "The concrete resolved interpretation (max 400 chars) — e.g. 'the planet Earth' or 'ground, dirt, soil, or terrain beneath the subject'. Write it as a visible thing, not an essay: it is the payload the rest of the pipeline delivers.",
    ],
    howDerived: ["Resolved by the classifier from casing + context; the most render-worthy edit in an entity row."],
    renderImpact: [
      'The planner treats it as the locked meaning and stages the scene accordingly, echoing the resolved form as visualReferentUsed. The compiler gap-fills any omitted referent into "Ensure these elements are clearly visible: …" — the referent reaches the engine as a concrete element, never as an "interpret X as Y" meta line.',
    ],
    workedExamples: [
      {
        scenario: "The Earth bench-press fact.",
        input: 'visualReferent: "the planet Earth"',
        outcome: 'If the prose somehow omitted the planet, the compiled prompt still gains "Ensure these elements are clearly visible: the planet Earth…".',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, PLANNER_BLOCKS, COMPILER_GAP_FILL, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.notes",
    label: "Notes",
    hint: "The AI's reasoning for this interpretation — planner-visible context.",
    whatItIs: ["Free-text reasoning behind the interpretation (max 800 chars; empty when there's nothing to say)."],
    howDerived: ["Written by the classifier; editable when you want to leave interpretation context for the planner and other admins."],
    renderImpact: ["Included in the planner's entity block when non-empty (as context), but never compiled into the engine prompt."],
    workedExamples: [
      {
        scenario: "A sentence-initial 'Sun'.",
        input: 'notes: "Sentence-initial; context (orbits, gravity) supports the celestial reading."',
        outcome: "You (and the planner) see why the celestial referent was chosen.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, PLANNER_BLOCKS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.materiallyAffects",
    label: "Materially affects visual prompt",
    hint: "The entity's materiality switch — checked entities are FORCED into the plan (validator rule 14).",
    whatItIs: [
      "True when changing this interpretation would materially change the rendered image. This checkbox is the entity-side materiality gate (entities have no confidence threshold — this flag alone decides).",
    ],
    howDerived: ["Set by the classifier per its 'materially changes the rendered image' rule; toggle it to control enforcement."],
    renderImpact: [
      "Checked: the plan MUST echo the entity in semanticEntitiesUsed with a concrete visualReferentUsed + effectOnVisualPlan (one corrective retry on a miss), and the referent is guaranteed to reach the engine via the gap-fill. Unchecked: the entity remains locked planner context but is never forced.",
    ],
    workedExamples: [
      {
        scenario: "The planet reading is essential to the joke.",
        input: "materiallyAffectsVisualPrompt: true",
        outcome: "Every future plan must account for the planet Earth or fail validation and retry.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, VALIDATOR, COMPILER_GAP_FILL, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.requiresReview",
    label: "Requires admin review",
    hint: "Human sanity-check flag for this interpretation — auto-set for sentence-initial ambiguity and brand/ambiguous kinds.",
    whatItIs: [
      "True when a human should confirm the interpretation: sentence-initial ambiguity, brand/cultural references, an ambiguous kind, or any case worth a sanity check.",
    ],
    howDerived: ["Classifier-set per its rules (sentence-initial capitalization always sets it); uncheck once you've confirmed the reading."],
    renderImpact: [
      "Unlike the cultural-reference flag, it does NOT gate materiality — a flagged entity with materiallyAffectsVisualPrompt=true is still force-echoed. It is a review signal for you, carried into the planner block as context.",
    ],
    workedExamples: [
      {
        scenario: "Sentence-initial 'Earth' resolved to the planet.",
        input: "requiresAdminReview: true (auto)",
        outcome: "You confirm or correct the referent; the enforcement behavior is unchanged either way.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.confidence",
    label: "Confidence",
    hint: "0–1: the AI's confidence in this interpretation — informational for entities (no threshold gates on it).",
    whatItIs: [
      "The classifier's 0–1 confidence in the interpretation. Unlike cultural references (where 0.8 is half the materiality gate), no entity-side threshold branches on it — materiality is the checkbox alone.",
    ],
    howDerived: ["Emitted by the classifier per entry."],
    renderImpact: ["Shown to the planner in the entity block and to you in the row; use a low value as your cue to review, but it does not change enforcement."],
    workedExamples: [
      {
        scenario: "A coin-flip interpretation.",
        input: "confidence: 0.55",
        outcome: "Your cue to settle the reading yourself — the pipeline treats the entity the same either way.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, PLANNER_BLOCKS, STALE_HASH],
    authoredStatus: "code-derived",
  },
];
