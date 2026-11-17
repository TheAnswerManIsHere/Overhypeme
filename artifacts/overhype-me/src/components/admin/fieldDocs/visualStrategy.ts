/**
 * Field docs — "Visual Strategy Override" panel + the enum value-docs
 * (subject realization, supporting-text mode, violence mode, violence
 * intensity).
 *
 * Pure data. Since pictures are drawn straight from the approved gag (plan
 * docs/plans/PLAN_GAG_DIRECT_RENDER.md) only two fields here still reach a
 * prompt: the gag's scene (coreSceneOverride) and its bubbles, both verbatim
 * (compileDirect in compilers/nanoBanana2.ts). Everything else on the old
 * "More art direction" panel is retired: no longer accepted on save, never
 * read by the compiler. Those docs and their enum value-docs are kept so the
 * admin reference still explains what a stored value meant.
 */

import {
  SUBJECT_REALIZATION_MODE_VALUES,
  SUPPORTING_TEXT_MODE_VALUES,
  VIOLENCE_MODE_VALUES,
  VIOLENCE_INTENSITY_VALUES,
  type SubjectRealizationMode,
  type SupportingTextMode,
  type ViolenceMode,
  type ViolenceIntensity,
} from "@workspace/api-zod";
import { valuesFrom, type FieldDoc, type ValueDoc, type FieldDocSourceRef } from "./types";

// Shared source refs used across this panel.
const OVERRIDE_SCHEMA: FieldDocSourceRef = {
  path: "lib/api-zod/src/visualStrategyOverride.ts",
  symbol: "visualPromptStrategyOverrideSchema",
  note: "The gag content's schema: field shapes, list caps and token canonicalization/validation on save.",
};
const RETIRED_FIELDS: FieldDocSourceRef = {
  path: "lib/api-zod/src/visualStrategyOverride.ts",
  symbol: "retiredArtDirectionFields",
  note: "Names the retired \"More art direction\" fields: a save carrying a value in any of them is refused, and stored values are never read.",
};
const COMPILER: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts",
  symbol: "compileDirect",
  note: "The one compile entry point: a picture's prompt is the gag's scene, its bubbles and its cast plus fixed wording that is the same for every fact.",
};
const STALE_HASH: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factRenderScenarios.ts",
  symbol: "renderAffectingEnrichment",
  note: "The render-input hash projection: it hashes only the gag's scene, bubbles and cast entries, so editing either flips render-scenario tiles stale.",
};
const VIOLENCE: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/violenceRule.ts",
  symbol: "VIOLENCE_RULE",
  note: "The one fixed violence sentence every picture's prompt carries; no setting changes it.",
};

const RETIRED_IMPACT =
  "Retired: no longer accepted on save and never read. Pictures are drawn only from the approved gag's scene, bubbles and cast, so this value changes nothing in the prompt. (Removed when pictures started being drawn straight from the gag; plan docs/plans/PLAN_GAG_DIRECT_RENDER.md.)";
const RETIRED_EXAMPLE = "Retired: say it in the gag's scene text instead.";

// ─── Subject realization value-docs ──────────────────────────────────────────
//
// RETIRED: the subject-realization control left the screen and the pipeline
// when pictures started being drawn straight from the gag. The meanings are
// kept to explain a stored value; none of them changes a prompt any more. Only
// `use_ai_plan` had upstream prose (a code comment); the other seven were
// authored from the mode names, so they carry
// authoredStatus: "authored-needs-david-review".

export const SUBJECT_REALIZATION_DOCS = {
  use_ai_plan: {
    meaning:
      "The old default — leave the subject's realization to the AI plan. There is no AI plan any more, so this is simply the state of every gag.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  normal_human: {
    meaning: "Pin the subject as an ordinary human at their normal age and form — no transformation, object-ification, or symbolism.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  age_transformed_human: {
    meaning: "The subject rendered as the SAME recognizable person at a different life stage (baby, child, elderly).",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  adult_head_on_transformed_body: {
    meaning: "The deliberately absurd composite: the subject's recognizable adult head/face kept on a transformed (e.g. baby) body.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  subject_as_object: {
    meaning: "The subject realized as a THING — a statue, a mountain, a constellation, a product — rather than a figure in the scene.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  nonhuman_transformation: {
    meaning: "The subject transformed into a non-human being — an animal, a mythical creature, a force of nature.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  symbolic_or_implied: {
    meaning: "The subject is not literally shown — their presence is implied by evidence, symbols, or the scene's reaction to them.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  custom: {
    meaning: "None of the named modes fit — the description carries the entire realization spec.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<SubjectRealizationMode, ValueDoc>;

// ─── Supporting-text mode value-docs ─────────────────────────────────────────

export const SUPPORTING_TEXT_MODE_DOCS = {
  allow: {
    meaning: "In-world readable text (signs, TV titles, scoreboards, documents) is permitted but not requested.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  forbid: {
    meaning: "In-world readable text should be avoided in this scene.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  require: {
    meaning: "The joke NEEDS readable in-world text (a title card, a scoreboard, a headline) — make the engine show it.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
} satisfies Record<SupportingTextMode, ValueDoc>;

// ─── Violence mode value-docs ────────────────────────────────────────────────

export const VIOLENCE_MODE_DOCS = {
  allow: {
    meaning: "The old default — depict the violence/consequences the fact requires, without gratuitous gore. Every picture now carries one fixed sentence saying much the same.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  soften: {
    meaning: "Deliberately reduce explicit violent consequences while keeping the action.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  suppress: {
    meaning: "Deliberately avoid depicting violence at all — consequences become symbolic/environmental.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
} satisfies Record<ViolenceMode, ValueDoc>;

// ─── Violence intensity value-docs ───────────────────────────────────────────
//
// RETIRED with the violence policy override: every picture now carries the one
// fixed VIOLENCE_RULE sentence and nothing reads an intensity. The upstream
// prose covers "strong" (the old default) and "graphic" (future-only); the
// lower rungs were authored from the value names.

export const VIOLENCE_INTENSITY_DOCS = {
  nonviolent: {
    meaning: "No violent content at all — the scene should carry zero violence even under an allow mode.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  mild: {
    meaning: "Cartoon-level, consequence-light action — impacts and tumbles without injury.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  moderate: {
    meaning: "Real action-movie consequences implied — destruction and danger, but no explicit casualties.",
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    authoredStatus: "authored-needs-david-review",
  },
  strong: {
    meaning:
      'The old default. Per the code comment: the default was "strong" (visible death, bodies, explosions, weapons, action aftermath, without gratuitous gore).',
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [
      {
        path: "lib/api-zod/src/renderPolicyEnums.ts",
        symbol: "VIOLENCE_INTENSITY_VALUES",
        note: "The authoritative comment defining strong as the platform default and graphic as future-compatible only.",
      },
    ],
    authoredStatus: "code-derived",
  },
  graphic: {
    meaning:
      'Per the code comment: "graphic" is FUTURE-COMPATIBLE only (a future adult/NSFW mode may use it). It is never selected or encouraged by default.',
    renderImpact: RETIRED_IMPACT,
    example: RETIRED_EXAMPLE,
    sourceRefs: [
      {
        path: "lib/api-zod/src/renderPolicyEnums.ts",
        symbol: "VIOLENCE_INTENSITY_VALUES",
        note: "The authoritative comment defining strong as the platform default and graphic as future-compatible only.",
      },
      VIOLENCE,
    ],
    authoredStatus: "code-derived",
  },
} satisfies Record<ViolenceIntensity, ValueDoc>;

// ─── Field docs ──────────────────────────────────────────────────────────────

export const VISUAL_STRATEGY_FIELD_DOCS: FieldDoc[] = [
  {
    key: "vso.panel",
    label: "Visual Strategy Override",
    hint: "The gag's content: its scene and its speech/thought bubbles are what a picture is drawn from. The old \"More art direction\" controls are retired.",
    whatItIs: [
      "The per-gag content object a moderator edits: the scene (Visual Concept) and the speech/thought bubbles. It is stored with the gag, and a picture's prompt is built only from it (plus the gag's cast, read from the scene by an AI step when the gag is saved) and fixed wording that is the same for every fact.",
      "Write plain English — don't hand-type tokens. Each rendered-text field just needs the subject's name written naturally (\"David laughs\", not \"{NAME} laughs\"); on Save the system auto-tokenizes every changed field through the same tokenizer fact submission uses, and shows you the tokenized result right there so you can verify it and correct it before it persists. Chips ({NAME}, {NAME_POSSESSIVE}, {SUBJ}, and the other pronoun tokens) remain in the toolbar as an expert escape hatch, but authoring no longer requires them. Name ONLY the main subject in your prose; refer to every other character by role (\"the mother\", \"a bystander\") — the tokenizer only replaces the subject's name and pronouns, so a second named character would be left literal.",
      "The eleven \"More art direction\" fields (moderator intent, subject depiction, required/forbidden details, role assignments, composition guidance, extra prompt details, do-not-render additions, the supporting-text and violence overrides, notes for the moderator) are retired: no longer accepted on save and never read. Any live value was folded into the gag's scene text first.",
    ],
    howDerived: [
      "Authored by moderators, or picked from the gag writer's candidate ideas (the AI never writes it straight into a picture). The save path stamps server-owned provenance (updatedBy/updatedAt).",
    ],
    renderImpact: [
      "The scene is the CORE SCENE section of the prompt, verbatim; the bubbles become the SPEECH & THOUGHT BUBBLES section, with speaker bindings written from the gag's cast. Everything else in the prompt is fixed wording: identity, a filler line for details the scene leaves unstated, style, and one fixed violence sentence.",
      "Nothing about the fact's AI classification (archetype, modifiers, literalness, references, characters) is added to the picture. There is no render-time AI planner and no other modifier- or classification-driven compiler wording; both were removed when pictures started being drawn straight from the gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
      "Editing the scene or a bubble flips render-scenario tiles stale; the render-input hash covers only the gag's scene, bubbles and cast entries.",
    ],
    workedExamples: [
      {
        scenario: "A render keeps missing a detail the gag depends on.",
        input: "Add the detail to the Visual Concept (scene) text.",
        outcome: "The scene reaches the prompt verbatim, so the detail is drawn; there is no separate required-details field to fill any more.",
      },
      {
        scenario: "You write a scene naming the subject in plain English.",
        input: 'Visual Concept: "David\'s face on the statue"',
        outcome: 'Click Save — the system tokenizes it to "{NAME_POSSESSIVE} face on the statue" and shows you the result. Tokens resolve per render; a plain name persisted as-is would leak into every other user\'s render, which is exactly what auto-tokenize prevents.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
,
  {
    key: "vso.coreSceneOverride",
    label: "Visual Concept (Core Scene)",
    hint: "Describe the picture in plain English, naming only the subject — on Save the system tokenizes it and shows you the result.",
    whatItIs: [
      "The moderator-authored scene: 2–4 plain-language sentences describing exactly what the image shows (subject, action, setting, objects, composition). It is the whole of what the picture shows: the compiler emits it as the CORE SCENE section at required priority, never compressed under the char budget, and nothing about the fact's classification is added to it.",
      "Write it in plain English, naming the subject naturally (\"David leans against the bar\"). On Save the system tokenizes it (the same tokenizer fact submission uses) and shows the tokenized result in the field so you can verify it before it persists — the field is still editable afterward. Name ONLY the main subject; refer to any other character by role (\"the bartender\", \"a passerby\"), never by name, since the tokenizer won't recognize a second name as personalizable. Capped at 1500 characters: it is a scene brief, not a full prompt.",
      "Also surfaced as the prominent 'Visual concept — describe the picture' card in moderation visual review; both surfaces edit this same field.",
    ],
    howDerived: [
      "Authored by moderators, or picked from the gag writer's candidate ideas. Preserved verbatim across re-classification.",
    ],
    renderImpact: [
      "Is the CORE SCENE section, verbatim (required, non-compressible, marked MODERATOR in the prompt breakdown). The prompt's other sections are fixed wording, including a line telling the engine to choose plausible details for whatever the scene leaves unstated.",
      "The compiler still owns identity/reference/text-policy language: engine instructions written here ('preserve the face', 'no readable text') are rendered as written but raise a warning in the prompt diagnostics, since they duplicate wording the compiler already supplies. A scene is required: the picture cannot be drawn without one.",
    ],
    workedExamples: [
      {
        scenario: "The AI keeps missing the scale gag in a participation-trophy fact.",
        input: 'Visual concept: "David triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory."',
        outcome: 'Click Save — the field shows "{NAME} triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory." CORE SCENE is exactly that sentence (token-resolved per render), the engine fills in unstated detail around it, and it survives the char budget uncompressed.',
      },
      {
        scenario: "You write engine instructions instead of a scene.",
        input: 'Visual concept: "Preserve the uploaded face and do not show readable text."',
        outcome: "Both clauses are compiler-owned wording; the diagnostics warn about them. Rewrite as visible scene description.",
      },
      {
        scenario: 'Your prose names a second character ("David and Alex raced go-karts").',
        input: 'Visual concept: "David and Alex raced go-karts around the office."',
        outcome: 'Tokenizes to "{NAME} and Alex raced go-karts around the office." — only David becomes {NAME}; Alex stays a literal name in the compiled prompt. Rewrite as "David raced a coworker around go-karts in the office" to avoid a hardcoded second name.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
,
  {
    key: "vso.bubbles",
    label: "Speech & Thought Bubbles",
    hint: "Make a character in the scene speak or think an exact line — a balloon rendered into the image with the text lettered verbatim. Pick who says it from the dropdown — the subject or a character from this gag's cast; shorter text renders more reliably.",
    whatItIs: [
      "A list (max 4; 1–2 works best) of bubbles: a type (Speech = tailed balloon; Thought = cloud with a trail of circles), WHO it belongs to (picked from a dropdown of the subject, the characters in this gag's cast, which an AI step reads from the scene when the gag is saved, shown read-only; the bubble stores the plain label, e.g. \"mom\", and a speaker saved earlier that is on none of those lists is kept as it is), and the exact text to letter (max 80 characters, soft warning at 60 — legibility drops with length). Text is token-capable ({NAME} etc.) and is whitespace-normalized on Save; what you see saved is exactly what the engine is asked to letter.",
    ],
    howDerived: [
      "Moderator-authored, or proposed by the gag writer when the fact contains a literal quote — picking an idea fills these rows (draft-only; Save still applies).",
    ],
    renderImpact: [
      "Each bubble compiles to one deterministic directive in the required SPEECH & THOUGHT BUBBLES section (stored order preserved, never de-duplicated or compressed). Bubbles always render; overlay/caption text stays excluded as ever.",
      "Bubbles have their own prompt-budget pool: if the combined directives exceed it, Save fails with a bubble-specific error — shorten the text or remove a bubble. Nothing is silently dropped.",
      "For a speaker other than the subject, the compiler opens the section with a short line tying the label to who they are in the picture, written from the gag's stored cast (\"mom: the woman in the passenger seat.\") — so the balloon has someone to point at even when the scene describes her without naming her.",
      "A speaker with no cast entry renders its directive anyway, but the model may add, ignore, or misattribute that character — the preview shows a warning; confirm the render.",
    ],
    workedExamples: [
      {
        scenario: '"When David left for college, he told his dad, \'You\'re the man of the house now.\'"',
        input: 'Speech bubble — entity "subject", text "You\'re the man of the house now."',
        outcome: "The render shows a clean comic-style balloon whose tail points to David, lettered with exactly that line — in every render mode and style.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.moderatorIntent",
    label: "Moderator Intent",
    labelSuffix: "(admin-only, not rendered)",
    hint: "Retired. A note for humans about why you overrode; it never reached a prompt.",
    whatItIs: [
      "Retired. A note for humans about why you overrode; it never reached a prompt. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.subjectRealization",
    label: "Subject Depiction Mode",
    hint: "Retired. It used to pin how the subject was physically realized (human, transformed, object, symbolic).",
    whatItIs: [
      "Retired. It used to pin how the subject was physically realized (human, transformed, object, symbolic). It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    values: valuesFrom(SUBJECT_REALIZATION_MODE_VALUES, SUBJECT_REALIZATION_DOCS),
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.subjectRealizationDescription",
    label: "Subject Depiction Description",
    hint: "Retired. It used to be the text of the SUBJECT REALIZATION prompt section.",
    whatItIs: [
      "Retired. It used to be the text of the SUBJECT REALIZATION prompt section. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.requiredVisualDetails",
    label: "Required Visual Details",
    hint: "Retired. It used to list details every render had to show.",
    whatItIs: [
      "Retired. It used to list details every render had to show. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.forbiddenVisualDetails",
    label: "Forbidden Visual Details",
    hint: "Retired. It used to list details every render had to avoid.",
    whatItIs: [
      "Retired. It used to list details every render had to avoid. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.roleBindings",
    label: "Scene Role Assignments",
    hint: "Retired. It used to say who was who among the secondary characters; the gag's cast now does this job, read from the scene when the gag is saved.",
    whatItIs: [
      "Retired. It used to say who was who among the secondary characters; the gag's cast now does this job, read from the scene when the gag is saved. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.compositionGuidance",
    label: "Composition Guidance",
    hint: "Retired. It used to add framing and camera advice to the COMPOSITION section.",
    whatItIs: [
      "Retired. It used to add framing and camera advice to the COMPOSITION section. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.styleAgnosticPromptAdditions",
    label: "Extra Prompt Details (any style)",
    hint: "Retired. It used to add extra detail lines to the prompt.",
    whatItIs: [
      "Retired. It used to add extra detail lines to the prompt. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.negativePromptAdditions",
    label: "Do-Not-Render Additions",
    hint: "Retired. It used to add 'do not draw' lines to the strict constraints.",
    whatItIs: [
      "Retired. It used to add 'do not draw' lines to the strict constraints. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.supportingTextPolicy",
    label: "Override supporting-text policy",
    hint: "Retired. It used to override the policy for readable in-scene text; the prompt now carries fixed text rules for every picture.",
    whatItIs: [
      "Retired. It used to override the policy for readable in-scene text; the prompt now carries fixed text rules for every picture. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    values: valuesFrom(SUPPORTING_TEXT_MODE_VALUES, SUPPORTING_TEXT_MODE_DOCS),
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.violencePolicy",
    label: "Override violence policy",
    hint: "Retired. It used to soften or suppress violence per fact; every picture now carries the one fixed violence sentence.",
    whatItIs: [
      "Retired. It used to soften or suppress violence per fact; every picture now carries the one fixed violence sentence. It was one of the eleven \"More art direction\" controls that left the moderation screen and the pipeline when pictures started being drawn straight from the approved gag (plan docs/plans/PLAN_GAG_DIRECT_RENDER.md).",
    ],
    howDerived: [
      "No longer accepted on save: a save carrying a value here is refused. Stored content keeps parsing, and any live value was folded into the gag's scene text first. Nothing reads it.",
    ],
    renderImpact: [
      "None. A picture's prompt is built only from the approved gag's scene, its bubbles and its cast, plus fixed wording that is the same for every fact. This field is never read, and editing it never marks a render out of date.",
    ],
    values: [
      ...valuesFrom(VIOLENCE_MODE_VALUES, VIOLENCE_MODE_DOCS),
      ...valuesFrom(VIOLENCE_INTENSITY_VALUES, VIOLENCE_INTENSITY_DOCS),
    ],
    workedExamples: [
      {
        scenario: "You want what this field used to do for one gag.",
        input: "Say it in the gag's scene text.",
        outcome: "The scene reaches the prompt verbatim, so a detail written there is drawn; this retired field would have been ignored.",
      },
    ],
    effect: "human-only",
    staleBehavior: "does-not-mark-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, RETIRED_FIELDS, VIOLENCE],
    authoredStatus: "code-derived",
  },
];
