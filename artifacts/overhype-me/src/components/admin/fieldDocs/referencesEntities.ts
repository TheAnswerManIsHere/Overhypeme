/**
 * Field docs — "Cultural / Inside References" + "Semantic Entities / Visual
 * Referents" sections (18 fields) + the enum value-docs (reference type,
 * entity kind, capitalization signal).
 *
 * Pure data. Meanings are extracted from the classifier system prompt
 * (FACT_ENRICHMENT_SYSTEM_DEFAULT) and the schemas in taxonomy.ts — see
 * sourceRefs on each record. Enum values without upstream prose are authored
 * and flagged `authored-needs-david-review`.
 *
 * WHAT THESE FIELDS DO NOW: pictures are drawn straight from the approved gag
 * (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md), so no reference or entity
 * reaches a picture prompt. The gag writer reads them: each cultural
 * reference (sourcePhrase, canonicalReference, explanation, visualImplication;
 * tentative unless material) and each entity flagged materiallyAffectsVisualPrompt
 * (surfaceText means visualReferent) appears in its message, and they are part
 * of its freshness check. The render-time planner, its echo-back validation and
 * the compiler's gap-fill were removed. The fact's `characters` list is read
 * only by cast extraction, as naming hints.
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
const WRITER_MESSAGE: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/visualConcepts/generator.ts",
  symbol: "buildVisualConceptsUserMessage",
  note: "Where references and material entities reach anything: the WHAT THE REFERENCES MEAN block of the gag writer's message. No picture prompt reads them.",
};
const MATERIALITY_GATE: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/visualConcepts/generator.ts",
  symbol: "isMaterialCulturalReference",
  note: 'A reference is material when researchConfidence === "high", OR confidence >= 0.8 and it is not flagged for admin review; a non-material one is shown to the gag writer as "(tentative)".',
};
const WRITER_HASH: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/visualConcepts/inputHash.ts",
  symbol: "writerAffectingEnrichment",
  note: "The gag writer's freshness projection: it includes culturalReferences and semanticEntities wholesale, so editing a row marks stored gag ideas out of date. It is not a render hash.",
};
const CAST_EXTRACTION: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/gags/castExtraction.ts",
  symbol: "buildCastUserMessage",
  note: "Where the fact's character labels are used: as naming hints for the cast read from a gag's scene.",
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
      "The gag writer is shown the reference and its visual implication under WHAT THE REFERENCES MEAN, so its ideas can use it. The type itself is not shown, and nothing reaches the picture except through the approved gag.",
    example: '"Sharks have a {NAME} Week" → cultural_reference, canonical "Shark Week" — sharks become the audience watching the subject as spectacle.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  brand_reference: {
    meaning: "The joke depends on a real brand or company (\"Victoria's Secret\", \"Apple\") — typically also flagged requiresAdminReview.",
    renderImpact:
      "The gag writer is shown the brand and its visual implication. The picture prompt never receives the brand: it is drawn only from the approved gag, and every prompt excludes logos and brand marks.",
    example: 'A "{NAME}\'s secret" wordplay on Victoria\'s Secret → the scene gets the runway-glamour implication, no logo.',
    sourceRefs: [CLASSIFIER_PROMPT, WRITER_MESSAGE],
    authoredStatus: "code-derived",
  },
  workplace_context: {
    meaning: "The joke needs knowledge of a specific workplace or company context the audience shares.",
    renderImpact: "Gag writer context: its ideas can be staged inside the implied workplace world; usually requiresAdminReview (real workplace), which makes the reference tentative for the writer.",
    example: '"{NAME} doesn\'t prepare for demos, demos prepare for {NAME}. #Yardi" → the Yardi/SaaS-presales demo context.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  professional_domain_context: {
    meaning: "The joke needs domain-professional knowledge (how presales demos, courtrooms, or trading floors work) rather than a specific employer.",
    renderImpact: "Gag writer context: its ideas can borrow the domain's recognizable staging (demo screens, gavels, tickers) so the joke reads.",
    example: "The same Yardi demo fact classified for its presales-demo domain rather than the employer per se.",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  idiom_or_phrase: {
    meaning: "The joke reuses a familiar phrase, idiom, or saying whose recognition is the hook.",
    renderImpact: "Gag writer context: the visual implication usually literalizes the idiom; there may be no canonicalReference (empty is allowed).",
    example: '"{NAME}\'s handshake seals deals" riffing on "seal the deal" → a literal wax seal in the scene.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  wordplay: {
    meaning: "The joke's hook is a pun or double meaning in the words themselves.",
    renderImpact: "Gag writer context: a good gag typically needs BOTH meanings visible for the pun to land — the visual implication should say how.",
    example: 'A "{NAME} raised the bar" fact → a literal bar being physically raised in a gym.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  mechanism_knowledge: {
    meaning: "The joke depends on knowing how something normally works, so the impossibility registers.",
    renderImpact: "Gag writer context: a good gag shows the mechanism being defied clearly enough that a viewer who knows it gets the joke.",
    example: '"{NAME} can set an ant on fire with a magnifying glass. At night." → magnifying glasses focus SUNlight; nighttime breaks the mechanism.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  inside_reference: {
    meaning: "The joke references something only a specific in-group (a friend circle, a team, a community) will recognize.",
    renderImpact: "Gag writer context: often low-confidence and requiresAdminReview — the AI can't verify an inside joke, so the writer is told it is tentative and a human should confirm the implication.",
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
    renderImpact: "The visual referent pins WHICH specific thing is meant; the gag writer is told it as the meaning of the term (when the entity materially affects the picture).",
    example: '"Everest" in a climbing fact → the specific mountain, not a generic peak.',
    authoredStatus: "authored-needs-david-review",
  },
  common_noun: {
    meaning: "A lowercase common noun whose everyday meaning is the right reading — recorded when it could be confused with a capitalized referent.",
    renderImpact: "Locks the mundane interpretation so the gag writer doesn't upgrade it to the named entity.",
    example: '"earth" → dirt, soil, ground, or terrain — NOT the planet.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  named_entity: {
    meaning: "A specific named person, character, work, or event (other than the fact's subject — the subject is never listed).",
    renderImpact: "The gag writer is told the specific entity via the visual referent, so its ideas can use its recognizable characteristics.",
    example: '"Godzilla" in a size fact → the famous kaiju silhouette, per its visualReferent.',
    authoredStatus: "authored-needs-david-review",
  },
  brand_or_cultural_reference: {
    meaning: "The term is a brand or cultural reference ('Apple' the company, not the fruit) — usually paired with a culturalReferences entry.",
    renderImpact: "Locks the brand/cultural reading for the gag writer; as always, no real logo or brand mark is ever drawn.",
    example: '"Apple" capitalized mid-sentence → the technology company, rendered as sleek-device context, never the logo.',
    sourceRefs: [CLASSIFIER_PROMPT, WRITER_MESSAGE],
    authoredStatus: "code-derived",
  },
  abstract_concept: {
    meaning: "An abstraction (infinity, probability, time) that has no direct physical form.",
    renderImpact: "The visual referent translates the abstraction into something showable for the gag writer; expect symbolic gag ideas.",
    example: '"infinity" in a counting fact → an endless receding number-scape as the referent.',
    authoredStatus: "authored-needs-david-review",
  },
  personified_concept: {
    meaning: "A concept treated as a character in this fact — capitalization often signals it ('Law', 'Death', 'Gravity').",
    renderImpact: "The gag writer is told the concept is a figure per the visual referent, rather than its abstract meaning.",
    example: '"Law" capitalized as an actor in the sentence → a personified authority figure, per the classifier\'s Law/law example.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  physical_object: {
    meaning: "A concrete object whose specific reading matters to the joke (which kind of 'bar', which 'mouse').",
    renderImpact: "Pins the object's interpretation so the gag writer's ideas show the right thing.",
    example: '"mouse" in a tech fact → the computer peripheral, not the animal.',
    authoredStatus: "authored-needs-david-review",
  },
  place: {
    meaning: "A location whose identity matters — a named place or a specific kind of setting.",
    renderImpact: "The gag writer is told the pinned location via the visual referent.",
    example: '"Paris" → the city with recognizable landmarks, not the mythological figure.',
    authoredStatus: "authored-needs-david-review",
  },
  celestial_body: {
    meaning: "A named astronomical object — the classifier's flagship capitalization case.",
    renderImpact: "Locks the astronomical reading for the gag writer (e.g. 'the planet Earth seen from orbit').",
    example: '"Earth" → the planet Earth; "Sun" → the named celestial body (or a personified entity, depending on context).',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  institution_or_system: {
    meaning: "An institution or a system of rules ('the Law' as the legal system, 'the Church', 'the Market').",
    renderImpact: "The gag writer is told the institution's identity via the visual referent, so its ideas can use the recognizable trappings (courtrooms, trading floors).",
    example: '"law" lowercase → legal rules generally; "Law" may indicate a title or an institution, per the classifier examples.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  ambiguous: {
    meaning: "The AI could not confidently resolve the referent — the interpretation is a guess that a human should settle.",
    renderImpact: "The classifier sets requiresAdminReview for ambiguous kinds; the gag writer is shown the referent marked (tentative) until you correct it.",
    example: "A sentence-initial capitalized term with two plausible readings — the AI picks one and flags the row for review.",
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
} satisfies Record<SemanticEntityKind, ValueDoc>;

// ─── Capitalization-signal value-docs ────────────────────────────────────────

export const CAPITALIZATION_SIGNAL_DOCS = {
  capitalized_named_entity: {
    meaning: "The term is capitalized mid-sentence, signaling a named entity ('Earth', 'Apple', 'Shark Week').",
    renderImpact: "Recorded only (not shown to the gag writer): it supports the named-entity reading of the visual referent — capitalization is a strong signal, never the sole basis.",
    example: '"…lifted Earth…" → capitalized mid-sentence → the planet.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  lowercase_common_noun: {
    meaning: "The term is lowercase, signaling the everyday common-noun reading.",
    renderImpact: "Recorded only (not shown to the gag writer): it supports the mundane referent (soil, fruit, sunlight) over the named entity.",
    example: '"…moved the earth beneath them…" → lowercase → soil/ground.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  sentence_initial_ambiguous: {
    meaning: "The term is capitalized only because it starts the sentence — casing carries NO signal, so the referent was inferred from context alone.",
    renderImpact: "The classifier's rule: set this signal, set requiresAdminReview to true (so the gag writer sees the referent as tentative), and infer the referent from context. Your review decides whether the inference was right.",
    example: '"Earth trembled when {NAME} stepped." → sentence-initial: planet or ground? Flagged for a human call.',
    sourceRefs: [CLASSIFIER_PROMPT],
    authoredStatus: "code-derived",
  },
  all_caps_presentation_ignored: {
    meaning: "The term appears in ALL CAPS for emphasis/styling — the shouting is presentation, not a semantic signal, and was ignored.",
    renderImpact: "The referent was resolved as if the term were normally cased; the caps carry no interpretation weight. Recorded only.",
    example: '"{NAME} BENCH-PRESSED THE EARTH" → styling caps ignored; context decides planet vs ground.',
    authoredStatus: "authored-needs-david-review",
  },
  mixed_case_brand_or_title: {
    meaning: "The term's distinctive mixed casing marks a brand or title (iPhone, YouTube, eBay).",
    renderImpact: "Recorded only (not shown to the gag writer): it supports the brand/title reading of the referent; no real logo is ever drawn.",
    example: '"iPhone" → the branded device category, casing itself being the tell.',
    authoredStatus: "authored-needs-david-review",
  },
  not_relevant: {
    meaning: "Capitalization played no role in this interpretation — the entry exists for a non-casing reason (pure ambiguity, cultural reference).",
    renderImpact: "The visual referent stands on context alone; the casing axis is simply not part of the reasoning. Recorded only.",
    example: "An entity recorded because its wordplay reading matters, where either casing would read the same.",
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<CapitalizationSignal, ValueDoc>;

// ─── Shared render-impact prose (both collections ride the same pipeline) ────

const REF_PIPELINE_NOTE =
  "Pipeline: the classifier detects → the gag writer is told the meanings when it drafts gag ideas → a moderator approves a gag → the picture is drawn from that gag alone (no classification field reaches the picture prompt).";

// ─── Field docs ──────────────────────────────────────────────────────────────

export const REFERENCES_ENTITIES_FIELD_DOCS: FieldDoc[] = [
  {
    key: "culturalReferences",
    label: "Cultural / Inside References",
    hint: "Outside-context dependencies the joke relies on — told to the gag writer as WHAT THE REFERENCES MEAN, with a materiality gate deciding which it states as settled.",
    whatItIs: [
      "The list of outside-context dependencies detected during enrichment: knowledge the joke relies on that isn't obvious from the literal words — a brand, a workplace/professional context, an idiom, wordplay, mechanism knowledge, or an inside reference. A fact with no such dependency has an empty list (there is deliberately no 'none' type).",
      "Each row is fully editable, and the per-row 'Research Reference' tool can verify a reference and stamp research metadata (researchConfidence, sources, notes, ambiguity warnings) that both the admin and the gag writer's materiality check see.",
      "References inform the gag writer how the joke works; they never change the archetype/subtype — the taxonomy classifies the mechanism, references flesh out the meaning. They do not reach the picture prompt directly.",
    ],
    howDerived: [
      "The classifier emits them under its cultural-reference rules, with the canonical worked examples: \"Sharks have a {NAME} Week\" → cultural_reference 'Shark Week' (visual implication: sharks are the audience watching the subject as spectacle); the Yardi demo fact → workplace/professional_domain_context; the magnifying-glass-at-night fact → mechanism_knowledge.",
    ],
    renderImpact: [
      "Every reference is listed in the gag writer's message under WHAT THE REFERENCES MEAN as `\"sourcePhrase\" refers to canonicalReference: explanation Visually: visualImplication`. The MATERIALITY GATE (isMaterialCulturalReference): a reference is material when researchConfidence is \"high\", OR confidence ≥ 0.8 AND it is not flagged for admin review. A non-material reference is still listed, marked \"(tentative)\" — it may be wrong.",
      "Nothing is forced into a picture. The render-time planner that force-echoed material references into the visual plan, and the compiler gap-fill that guaranteed their visual implication reached the prompt, were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md). The moderator-approved gag decides what is drawn.",
      "Reference text never goes into a picture prompt: the prompt is built only from the approved gag, plus fixed wording that excludes logos and brand marks. Only the gag writer reads these rows.",
      "The whole collection is in the gag writer's freshness check, so editing any row marks the stored gag ideas out of date. It is not in the render-input hash and never marks a render out of date.",
      REF_PIPELINE_NOTE,
    ],
    workedExamples: [
      {
        scenario: '"Sharks have a {NAME} Week." — confidence 0.9, not flagged.',
        input: 'cultural_reference, canonical "Shark Week", visualImplication "sharks are the audience watching the subject as spectacle"',
        outcome: "Material → the gag writer states it as settled, so its ideas can use sharks-as-audience; the words 'Shark Week'/'Discovery Channel' reach a picture only if the approved gag's scene contains them.",
      },
      {
        scenario: '"{NAME} can set an ant on fire with a magnifying glass. At night." — mechanism_knowledge.',
        input: 'visualImplication: "a magnifying glass focusing a beam under a starry night sky — the impossible part"',
        outcome: "The gag writer is told the night-beam visual, so its ideas can make the mechanism-defiance read.",
      },
      {
        scenario: "A brand reference at confidence 0.6 with requiresAdminReview=true.",
        input: "(unchanged, unresearched)",
        outcome: "NOT material: the gag writer still sees it, marked (tentative). Running Research Reference to high confidence makes it material.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_MESSAGE, MATERIALITY_GATE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.sourcePhrase",
    label: "Source phrase",
    hint: "The literal phrase in the fact that triggers the reference.",
    whatItIs: [
      "The verbatim word/phrase in the fact text that carries the reference (max 300 chars). It is the quoted phrase at the start of the reference's line in the gag writer's message.",
    ],
    howDerived: ["The classifier quotes it from the fact; editable for manual-fill workflows."],
    renderImpact: ["Shown to the gag writer as the quoted phrase its reference line starts with."],
    workedExamples: [
      {
        scenario: '"Sharks have a {NAME} Week."',
        input: 'sourcePhrase: "{NAME} Week"',
        outcome: "The gag writer's line reads: \"{NAME} Week\" refers to … — so it knows which words carry the reference.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_HASH],
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
    renderImpact: ["Not shown to the gag writer and not read by the picture — it labels the dependency for admins. The materiality gate doesn't branch on type, though brand/workplace types usually arrive with requiresAdminReview=true (which does affect materiality)."],
    values: valuesFrom(REFERENCE_TYPE_VALUES, REFERENCE_TYPE_DOCS),
    workedExamples: [
      {
        scenario: "The Yardi demo fact.",
        input: "referenceType: professional_domain_context",
        outcome: "Recorded as a label only; the gag writer sees the reference's explanation and visual implication, not the type.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.canonicalReference",
    label: "Canonical reference",
    hint: "The reference's canonical name — read by the gag writer; never part of a picture prompt.",
    whatItIs: [
      "May be empty when no single canonical name exists (common for idioms). It appears in the gag writer's reference line as what the phrase refers to.",
    ],
    howDerived: ["Named by the classifier; the Research Reference tool corrects/confirms it."],
    renderImpact: [
      "Read by the gag writer (\"… refers to canonicalReference …\"), and deliberately never part of a picture prompt, which is built only from the approved gag. Brand names reach a picture only if the gag's scene says them, and logos and brand marks are always excluded.",
    ],
    workedExamples: [
      {
        scenario: "Shark Week reference on a live render.",
        input: 'canonicalReference: "Shark Week"',
        outcome: "The gag writer knows exactly which phenomenon is meant; the picture prompt contains sharks-as-audience visuals only if the approved gag's scene does.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_MESSAGE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.explanation",
    label: "Explanation",
    hint: "The plain-language joke mechanism the reference enables — read by the gag writer, never part of a picture prompt.",
    whatItIs: ["A plain-language explanation of how the reference makes the joke work (max 800 chars)."],
    howDerived: ["Written by the classifier; directly editable per the admin workflow."],
    renderImpact: [
      "Read by the gag writer (it follows the reference in the writer's message), but never part of a picture prompt — an 'explaining the joke' line is meta-instruction the image engine can't use.",
    ],
    workedExamples: [
      {
        scenario: "The magnifying-glass fact.",
        input: 'explanation: "Magnifying glasses need sunlight to burn; doing it at night is the impossibility."',
        outcome: "The gag writer sees why the mechanism-defiance is funny; the sentence itself never reaches the picture prompt.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_MESSAGE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.visualImplication",
    label: "Visual implication",
    hint: "THE load-bearing field: how the reference should change the scene — shown to the gag writer after \"Visually:\".",
    whatItIs: [
      "the gag writer reads it as the visual consequence of the reference. It reaches a picture only if the approved gag's scene carries it.",
    ],
    howDerived: ["Written by the classifier and refined by admins/research — the single most render-worthy edit in a reference row."],
    renderImpact: [
      "Shown to the gag writer after \"Visually:\" in its reference line. It is not put into any picture prompt and nothing gap-fills it: the render-time planner and the compiler's gap-fill were removed when pictures started being drawn straight from the gag.",
    ],
    workedExamples: [
      {
        scenario: "Shark Week reference.",
        input: 'visualImplication: "sharks are the audience watching the subject as spectacle"',
        outcome: "The gag writer's ideas can stage sharks on couches watching TV; whether the picture shows it depends on the approved gag.",
      },
      {
        scenario: "A vague implication.",
        input: 'visualImplication: "make it feel like the TV event"',
        outcome: "Weak — nothing concrete for the gag writer to stage. Rewrite it as a visible thing a gag can contain.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_MESSAGE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.confidence",
    label: "Confidence",
    hint: "0–1: how confident the AI is that this reference is the joke's actual hook — half of the materiality gate.",
    whatItIs: ["The classifier's 0–1 confidence that the reference is the joke's real hook. Editable — raising or lowering it directly moves the reference across the materiality threshold."],
    howDerived: ["Emitted by the classifier per reference; admins adjust it when they know better."],
    renderImpact: [
      "Materiality gate input: confidence ≥ 0.8 (with requiresAdminReview false) makes the reference material — the gag writer states it as settled. Below the bar (unless researchConfidence is high) it is listed as (tentative).",
    ],
    workedExamples: [
      {
        scenario: "A correct reference sitting at 0.7.",
        input: "You raise confidence to 0.9 (review unchecked).",
        outcome: "It crosses the gate: the gag writer now states it as settled instead of marking it tentative.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, MATERIALITY_GATE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ref.requiresAdminReview",
    label: "Requires admin review",
    hint: "Human sanity-check flag — while set, the gag writer is told the reference is tentative (unless research verified it).",
    whatItIs: [
      "Set true by the classifier when the reference touches a real brand, workplace, or professional context, or is otherwise ambiguous and worth a human check.",
    ],
    howDerived: ["Classifier-set per its rules; you uncheck it once you've confirmed the reference."],
    renderImpact: [
      "It blocks materiality: a flagged reference is listed as (tentative) regardless of confidence — EXCEPT when researchConfidence is \"high\" (verified research overrides the flag). Unchecking it (with confidence ≥ 0.8) makes the reference material.",
    ],
    workedExamples: [
      {
        scenario: "A Yardi workplace reference, confidence 0.85, flagged for review.",
        input: "You confirm it and uncheck the box.",
        outcome: "The reference becomes material — the gag writer states it as settled.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, MATERIALITY_GATE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "semanticEntities",
    label: "Semantic Entities / Visual Referents",
    hint: "Capitalization-aware term disambiguations the gag writer is told as the meaning of the fact's words.",
    whatItIs: [
      "The list of surface terms whose interpretation materially matters for the image — 'Earth' the planet vs 'earth' the soil being the flagship case. Casing is preserved verbatim (never normalized before interpretation; the classifier reads factTextExact), and only terms whose reading changes the image are listed — never every noun, and NEVER the fact's subject.",
      "Subject-name defense: the subject (the canonical placeholder 'Alex') is categorically not a semantic entity — the classifier is forbidden from listing it, and a deterministic strip removes it from older enrichments defensively, so it is never told to the gag writer as a referent. The subject's identity is owned by the personalization/rendering layer.",
    ],
    howDerived: [
      "The classifier applies the capitalization examples: earth/Earth (soil vs planet), apple/Apple (fruit vs company), sun/Sun (sunlight vs the named body or a personification), law/Law (legal rules vs a title/institution). Capitalization is a strong signal but never the sole basis; sentence-initial capitalization yields capitalizationSignal=sentence_initial_ambiguous + requiresAdminReview=true with the referent inferred from context.",
    ],
    renderImpact: [
      "Entities flagged materiallyAffectsVisualPrompt are listed in the gag writer's message under WHAT THE REFERENCES MEAN as `\"surfaceText\" means visualReferent`, marked \"(tentative)\" when requiresAdminReview is set. They do not reach the picture prompt.",
      "Nothing is forced into a picture: the render-time planner's echo-back validation and the compiler's gap-fill were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
      "The engine never sees an \"Interpret X means Y\" meta line either: it gets only the approved gag's scene, so the resolved referent is drawn only if the gag's scene says it.",
      "Entities never change the archetype/subtype — they are writer context, not taxonomy. The whole collection is in the gag writer's freshness check, so edits mark stored gag ideas out of date; it is not in the render-input hash and never marks a render out of date.",
      REF_PIPELINE_NOTE,
    ],
    workedExamples: [
      {
        scenario: '"{NAME} bench-presses the Earth."',
        input: 'surfaceText "Earth", entityKind celestial_body, visualReferent "the planet Earth", materiallyAffects ✓',
        outcome: "The gag writer is told the referent is the planet, so its ideas use the planet, not a pile of soil.",
      },
      {
        scenario: '"{NAME} moved the earth with one hand."',
        input: 'surfaceText "earth", entityKind common_noun, capitalizationSignal lowercase_common_noun, visualReferent "ground, dirt, soil, or terrain"',
        outcome: "The mundane reading is locked for the gag writer — its ideas use soil, not the planet.",
      },
      {
        scenario: 'An old enrichment stored "Alex" as an entity.',
        input: "(nothing to do)",
        outcome: "The defensive strip removes it before the gag writer sees it — the subject is never a semantic entity.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_MESSAGE, SUBJECT_STRIP, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "characters",
    label: "Characters",
    hint: "Every person or animal the fact names besides the subject — a naming hint for the cast read from a gag's scene.",
    whatItIs: [
      "The fact's cast, minus the subject: for \"When Alex was born, he drove his mom home from the hospital\" it is one character, label \"mom\", a person, a relation of the subject. The subject is never listed — it is always available as \"Alex (the subject)\".",
      "The subject is never listed. A label follows the bubble-speaker rules (plain text, no personalization token, never the word \"subject\", and unique within the list) so it can be matched to a bubble's speaker.",
      "\"Relation of the subject\" decides how the character is named: \"Alex's mom\" when ticked, \"the referee\" when not.",
    ],
    howDerived: [
      "A dedicated, versioned call made right after classification (its own prompt and response schema, so the main classification is untouched) reads the fact as rendered with the stand-in name and lists every person or animal it names besides the subject. The stand-in name is stripped if returned.",
      "A successful call stamps an extraction marker, even for an empty list. A failed call leaves no marker on a fact that has never had a list — Taxonomy Health counts it as missing and \"Fill character lists\" retries it — and keeps the previous list on a fact that already had one.",
      "A moderator correction replaces the whole list and survives re-enrichment, refreshes and both bulk re-enrich jobs; only the field's own reset clears it.",
    ],
    renderImpact: [
      "Read only by cast extraction: when a gag is saved, the AI step that reads the gag's scene for who else is in it is given these labels as naming hints (never as characters to add). The gag writer's message and the picture prompt do not receive the list.",
      "It never forces a character into a gag. Who appears is the gag's choice; the gag's cast, read from its scene and bubbles, is what the speaker dropdown offers and what the compiler binds speakers to.",
      "Not in the render-input hash or the gag writer's freshness check, so editing the list never marks a render or a stored gag idea out of date.",
    ],
    workedExamples: [
      {
        scenario: '"When {NAME} was born, {SUBJ} drove {POSS} mom home from the hospital."',
        input: 'label "mom", kind person, relation of the subject ✓',
        outcome: "Cast extraction names the character \"mom\" when it reads the scene, so the speaker dropdown offers \"mom\" from the gag's cast.",
      },
      {
        scenario: "The AI missed a character, or named one awkwardly.",
        input: 'Add or rename the row (e.g. "mother" → "mom")',
        outcome: "Saved as a correction that re-enrichment keeps. Cast extraction uses the corrected label as its naming hint the next time a gag is saved.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, CAST_EXTRACTION],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.surfaceText",
    label: "Surface text",
    labelSuffix: "(verbatim case)",
    hint: "The term exactly as it appears in the fact — casing preserved.",
    whatItIs: [
      "The term verbatim from the fact, casing intact (max 120 chars) — 'Earth' and 'earth' are different surface texts, and that difference is the point. Do not normalize it; normalizedText holds the lowercase form.",
    ],
    howDerived: ["Quoted by the classifier from factTextExact."],
    renderImpact: [
      "Shown to the gag writer as the quoted term at the start of the entity's line (`\"surfaceText\" means …`), only for entities flagged materiallyAffectsVisualPrompt. Entities whose surfaceText is a raw template token (e.g. literally \"{NAME}\") are dropped by the subject-name strip before the writer sees them.",
    ],
    workedExamples: [
      {
        scenario: "The Earth bench-press fact.",
        input: 'surfaceText: "Earth"',
        outcome: "The gag writer's line starts with \"Earth\"; the preserved capital is what justified the celestial reading.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.normalizedText",
    label: "Normalized text",
    hint: "The lowercase comparable form of the surface text.",
    whatItIs: ["The lowercase form used for comparisons (max 120 chars) — 'earth' for both 'Earth' and 'EARTH'."],
    howDerived: ["Emitted by the classifier alongside the surface text."],
    renderImpact: ["Bookkeeping only — the gag writer's message uses surfaceText; this field exists as the case-insensitive comparable form."],
    workedExamples: [
      {
        scenario: 'surfaceText "Earth".',
        input: 'normalizedText: "earth"',
        outcome: "The pair records both the meaningful casing and the comparable form.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_HASH],
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
    renderImpact: ["Recorded only: not shown to the gag writer. The concrete steering comes from visualReferent; the kind labels why the reading holds."],
    values: valuesFrom(SEMANTIC_ENTITY_KIND_VALUES, SEMANTIC_ENTITY_KIND_DOCS),
    workedExamples: [
      {
        scenario: '"Apple" capitalized mid-sentence in a tech fact.',
        input: "entityKind: brand_or_cultural_reference",
        outcome: "The company reading is locked — with the standard never-draw-a-real-logo rule downstream.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_HASH],
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
    renderImpact: ["Recorded only: not shown to the gag writer; the meaning follows visualReferent. Its main operational effect is flagging the sentence-initial case for your review."],
    values: valuesFrom(CAPITALIZATION_SIGNAL_VALUES, CAPITALIZATION_SIGNAL_DOCS),
    workedExamples: [
      {
        scenario: '"Earth trembled when {NAME} stepped."',
        input: "capitalizationSignal: sentence_initial_ambiguous (requiresAdminReview auto-true)",
        outcome: "You decide planet vs ground; the AI's context-based guess stands until you do.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.visualReferent",
    label: "Visual referent",
    hint: "The concrete interpretation — the part of an entity the gag writer is actually told (after \"means\"), for entities flagged as materially affecting the picture.",
    whatItIs: [
      "The concrete resolved interpretation (max 400 chars) — e.g. 'the planet Earth' or 'ground, dirt, soil, or terrain beneath the subject'. Write it as a visible thing, not an essay: it is the payload the rest of the pipeline delivers.",
    ],
    howDerived: ["Resolved by the classifier from casing + context; the most render-worthy edit in an entity row."],
    renderImpact: [
      "Shown to the gag writer as `\"surfaceText\" means visualReferent` for entities flagged materiallyAffectsVisualPrompt, so its ideas use the resolved meaning. It is not put into any picture prompt and nothing gap-fills it: the render-time planner and the compiler's gap-fill were removed when pictures started being drawn straight from the gag.",
    ],
    workedExamples: [
      {
        scenario: "The Earth bench-press fact.",
        input: 'visualReferent: "the planet Earth"',
        outcome: "The gag writer is told \"Earth\" means the planet, so its ideas show the planet; the picture shows it only if the approved gag's scene does.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_MESSAGE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.notes",
    label: "Notes",
    hint: "The AI's reasoning for this interpretation — context for admins; not shown to the gag writer.",
    whatItIs: ["Free-text reasoning behind the interpretation (max 800 chars; empty when there's nothing to say)."],
    howDerived: ["Written by the classifier; editable when you want to leave interpretation context for other admins."],
    renderImpact: ["Recorded only: not shown to the gag writer and never part of a picture prompt."],
    workedExamples: [
      {
        scenario: "A sentence-initial 'Sun'.",
        input: 'notes: "Sentence-initial; context (orbits, gravity) supports the celestial reading."',
        outcome: "You see why the celestial referent was chosen.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_MESSAGE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "ent.materiallyAffects",
    label: "Materially affects visual prompt",
    hint: "The entity's materiality switch — only checked entities are told to the gag writer.",
    whatItIs: [
      "True when changing this interpretation would materially change the rendered image. This checkbox is the entity-side materiality gate (entities have no confidence threshold — this flag alone decides).",
    ],
    howDerived: ["Set by the classifier per its 'materially changes the rendered image' rule; toggle it to control whether the gag writer is told the entity."],
    renderImpact: [
      "Checked: the entity is listed in the gag writer's WHAT THE REFERENCES MEAN block (`\"surfaceText\" means visualReferent`). Unchecked: the writer is not told about it. Nothing is forced into a picture: the echo validation and gap-fill were removed when pictures started being drawn straight from the gag.",
    ],
    workedExamples: [
      {
        scenario: "The planet reading is essential to the joke.",
        input: "materiallyAffectsVisualPrompt: true",
        outcome: "The gag writer is told what \"Earth\" means; an unchecked entity would not be mentioned to it at all.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_HASH],
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
      "Unlike the cultural-reference flag, it does NOT decide whether the entity is listed: a flagged entity with materiallyAffectsVisualPrompt=true is still told to the gag writer, marked \"(tentative)\".",
    ],
    workedExamples: [
      {
        scenario: "Sentence-initial 'Earth' resolved to the planet.",
        input: "requiresAdminReview: true (auto)",
        outcome: "You confirm or correct the referent; the gag writer stops seeing it as tentative once the flag is cleared.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [CLASSIFIER_PROMPT, TAXONOMY_SCHEMAS, WRITER_HASH],
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
    renderImpact: ["Recorded only: not shown to the gag writer. Use a low value as your cue to review; it changes nothing downstream."],
    workedExamples: [
      {
        scenario: "A coin-flip interpretation.",
        input: "confidence: 0.55",
        outcome: "Your cue to settle the reading yourself — nothing downstream treats the entity differently either way.",
      },
    ],
    effect: "advisory-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [TAXONOMY_SCHEMAS, WRITER_MESSAGE, WRITER_HASH],
    authoredStatus: "code-derived",
  },
];
