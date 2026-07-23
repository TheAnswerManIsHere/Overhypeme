/**
 * Field docs — "Visual Strategy Override" panel (12 fields) + the enum
 * value-docs (subject realization, supporting-text mode, violence mode,
 * violence intensity).
 *
 * Pure data. Behavior is extracted from the override schema
 * (visualStrategyOverride.ts) and the traced Nano Banana 2 compiler
 * (compilers/nanoBanana2.ts) — see sourceRefs on each record. The 8
 * subject-realization modes have no upstream prose (only `use_ai_plan`
 * carries a code comment), so those meanings are authored and flagged
 * `authored-needs-david-review`.
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
  note: "The override's schema: field shapes, list caps, token canonicalization/validation on save, and the admin-only fields excluded from rendering.",
};
const COMPILER: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts",
  symbol: "compile",
  note: "The deterministic Nano Banana 2 compiler — where each override sub-field is merged into a labeled prompt section.",
};
const STALE_HASH: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/factRenderScenarios.ts",
  symbol: "renderAffectingEnrichment",
  note: "The render-input hash projection — it includes visualPromptStrategyOverride WHOLESALE, so editing any part of the override flips render-scenario tiles stale.",
};
const PLANNER_RENDER_POLICY: FieldDocSourceRef = {
  path: "artifacts/api-server/src/lib/imagePrompt/generator.ts",
  symbol: "buildImagePromptUserMessage",
  note: "The planner-side RENDER POLICY block — 'the ONLY layer that may suppress; do not self-censor beyond it'.",
};

// ─── Subject realization value-docs ──────────────────────────────────────────
//
// Only `use_ai_plan` has upstream prose (a code comment). The other seven are
// authored from the mode names + the compiler's behavior (the mode itself is
// never emitted — only the description text is compiled), so they carry
// authoredStatus: "authored-needs-david-review".

export const SUBJECT_REALIZATION_DOCS = {
  use_ai_plan: {
    meaning:
      "The default — keep the AI plan's subject realization untouched. The rest of the override (details, roles, policies) still applies.",
    renderImpact:
      "No SUBJECT REALIZATION section is emitted at all; the AI's own subject treatment (plus the compiler's SUBJECT BINDING) stands.",
    example: "The AI already renders the subject correctly; you only need to forbid one stray detail — leave this on use_ai_plan.",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER],
    authoredStatus: "code-derived",
  },
  normal_human: {
    meaning: "Pin the subject as an ordinary human at their normal age and form — no transformation, object-ification, or symbolism.",
    renderImpact:
      "Your description (e.g. \"{NAME} as a normal adult human, unchanged\") is compiled verbatim into the required SUBJECT REALIZATION section, overriding an AI plan that kept transforming the subject.",
    example: "The AI keeps turning the subject into a giant for a strength fact — pin normal_human with \"{NAME} at normal human scale\".",
    authoredStatus: "authored-needs-david-review",
  },
  age_transformed_human: {
    meaning: "The subject rendered as the SAME recognizable person at a different life stage (baby, child, elderly).",
    renderImpact:
      "Your description states the target life stage; it ADDS to (never replaces) the compiler's own SUBJECT BINDING / anti-split guards, which already fuse identity with the transformed age.",
    example: '"{NAME} de-aged into a toddler, same recognizable face" for a "{NAME} as a baby…" fact.',
    authoredStatus: "authored-needs-david-review",
  },
  adult_head_on_transformed_body: {
    meaning: "The deliberately absurd composite: the subject's recognizable adult head/face kept on a transformed (e.g. baby) body.",
    renderImpact:
      "Your description spells out the composite so the engine doesn't 'fix' it into either a full adult or a full baby. Pair with forbiddenVisualDetails to block a realistic full de-age if the AI keeps producing one.",
    example: '"{NAME}\'s adult head, unchanged, on a newborn-sized swaddled body" — the classic meme-composite realization.',
    authoredStatus: "authored-needs-david-review",
  },
  subject_as_object: {
    meaning: "The subject realized as a THING — a statue, a mountain, a constellation, a product — rather than a figure in the scene.",
    renderImpact:
      "Your description defines the object and how it still reads as the subject (engraving, silhouette, likeness). Compiled into the required SUBJECT REALIZATION section.",
    example: '"{NAME} rendered as a colossal marble statue in the town square, face clearly recognizable" for a legacy/monument fact.',
    authoredStatus: "authored-needs-david-review",
  },
  nonhuman_transformation: {
    meaning: "The subject transformed into a non-human being — an animal, a mythical creature, a force of nature.",
    renderImpact:
      "Your description states the creature and which identity cues survive the transformation; it is compiled into the required SUBJECT REALIZATION section.",
    example: '"{NAME} as a lion with {NAME_POSSESSIVE} distinctive hair color in the mane" for an apex-predator fact.',
    authoredStatus: "authored-needs-david-review",
  },
  symbolic_or_implied: {
    meaning: "The subject is not literally shown — their presence is implied by evidence, symbols, or the scene's reaction to them.",
    renderImpact:
      "Your description defines the implication (empty throne, awed crowd looking off-frame, aftermath). Compiled into the required SUBJECT REALIZATION section.",
    example: '"{NAME} is off-frame; show only the crowd shielding their eyes from a blinding glow at the doorway" for an ineffable-presence fact.',
    authoredStatus: "authored-needs-david-review",
  },
  custom: {
    meaning: "None of the named modes fit — the description carries the entire realization spec.",
    renderImpact:
      "Exactly like the other non-default modes: only the description text is compiled (the mode name itself never reaches the engine), so write the description as a complete, self-contained instruction.",
    example: "A half-photo/half-blueprint split-render of the subject that no named mode covers — describe it fully under custom.",
    authoredStatus: "authored-needs-david-review",
  },
} satisfies Record<SubjectRealizationMode, ValueDoc>;

// ─── Supporting-text mode value-docs ─────────────────────────────────────────

export const SUPPORTING_TEXT_MODE_DOCS = {
  allow: {
    meaning: "In-world readable text (signs, TV titles, scoreboards, documents) is permitted but not requested.",
    renderImpact:
      "The compiler adds no in-world-text directive of its own unless the planner picked explicit supportingTextElements or your guidance is set — unnecessary text is not encouraged. Two lines are always emitted regardless: the narrow overlay-text exclusion (no captions/watermarks/logos baked in) and an always-on incidental-text guard that steers background signage non-readable while YIELDING to any intentional in-scene text.",
    example: 'allow + guidance \'a TV title reading "{NAME} Week"\' → the guidance line is emitted so the title card appears; the incidental-text guard yields to it.',
    sourceRefs: [COMPILER],
    authoredStatus: "code-derived",
  },
  forbid: {
    meaning: "In-world readable text should be avoided in this scene.",
    renderImpact:
      'Emits the literal line: "Avoid readable in-scene text unless required by a higher-priority instruction." into STRICT CONSTRAINTS (alongside the always-on incidental-text guard). This is the way to fully suppress in-scene text — it replaces the retired no_readable_text modifier. Exception: if the planner selected concrete supportingTextElements, those still render (the planner\'s scene content is the strongest signal).',
    example: "A scene should have NO readable text at all → forbid emits the avoid line and cleans the scene of readable text.",
    sourceRefs: [COMPILER],
    authoredStatus: "code-derived",
  },
  require: {
    meaning: "The joke NEEDS readable in-world text (a title card, a scoreboard, a headline) — make the engine show it.",
    renderImpact:
      'Emits: "SUPPORTING TEXT: Readable in-scene text is required in this scene. Show it clearly: {your guidance}." (or the guidance-less variant). The editor warns when require is set without guidance — the engine can\'t require unspecified text.',
    example: '"Sharks have a {NAME} Week" → require + guidance \'a TV title card reading "{NAME} Week"\'.',
    sourceRefs: [COMPILER],
    authoredStatus: "code-derived",
  },
} satisfies Record<SupportingTextMode, ValueDoc>;

// ─── Violence mode value-docs ────────────────────────────────────────────────

export const VIOLENCE_MODE_DOCS = {
  allow: {
    meaning: "The platform default — depict the violence/consequences the fact requires, without gratuitous gore.",
    renderImpact:
      'When the fact is violence-relevant (violence modifiers or violent lexicon), the compiler emits the permission line: "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." Your guidance text, if set, replaces that line. The planner separately receives violence=ALLOW with the intensity and "Do NOT add your own sanitizing or content-suppression language."',
    example: '"{NAME} threw a grenade and killed 50 people…" → the aftermath (bodies included) is depicted, not sanitized away.',
    sourceRefs: [COMPILER, PLANNER_RENDER_POLICY],
    authoredStatus: "code-derived",
  },
  soften: {
    meaning: "Deliberately reduce explicit violent consequences while keeping the action.",
    renderImpact:
      'Emits the literal line: "Soften violent consequences; avoid graphic injury and visible death unless explicitly required by a higher-priority instruction." The planner receives violence=SOFTEN with matching language.',
    example: "An action fact whose test renders came out too grisly for the meme tone → soften keeps the explosion, loses the gore.",
    sourceRefs: [COMPILER, PLANNER_RENDER_POLICY],
    authoredStatus: "code-derived",
  },
  suppress: {
    meaning: "Deliberately avoid depicting violence at all — consequences become symbolic/environmental.",
    renderImpact:
      'Emits the literal line: "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage." This moderator override is the ONLY thing that suppresses violent depiction — the retired auto-softening modifiers no longer exist.',
    example: "A combat fact rendered for a context where no injury should be visible → suppress swaps casualties for cratered ground and dust.",
    sourceRefs: [COMPILER, PLANNER_RENDER_POLICY],
    authoredStatus: "code-derived",
  },
} satisfies Record<ViolenceMode, ValueDoc>;

// ─── Violence intensity value-docs ───────────────────────────────────────────
//
// Intensity is planner-side context under "allow" (violence=ALLOW ({intensity})).
// The compiler's own directive lines do not branch on it and never emit
// "graphic"-flavored language. The upstream prose covers "strong" (platform
// default) and "graphic" (future-only); the lower rungs are authored from the
// value names.

export const VIOLENCE_INTENSITY_DOCS = {
  nonviolent: {
    meaning: "No violent content at all — the scene should carry zero violence even under an allow mode.",
    renderImpact:
      "Planner context only: the intensity is echoed in the planner's violence=ALLOW line to calibrate how much consequence the scene stages. For a hard guarantee of no violence, use mode=suppress instead — intensity alone emits no compiler directive.",
    example: "A gentle fact that trips the violence lexicon incidentally — nonviolent tells the planner to keep the scene entirely peaceful.",
    authoredStatus: "authored-needs-david-review",
  },
  mild: {
    meaning: "Cartoon-level, consequence-light action — impacts and tumbles without injury.",
    renderImpact: "Planner context only (echoed in the violence=ALLOW line); no deterministic compiler directive branches on it.",
    example: "A slapstick fact → mild keeps the punch visible but nobody visibly hurt.",
    authoredStatus: "authored-needs-david-review",
  },
  moderate: {
    meaning: "Real action-movie consequences implied — destruction and danger, but no explicit casualties.",
    renderImpact: "Planner context only (echoed in the violence=ALLOW line); no deterministic compiler directive branches on it.",
    example: "A building-toppling fact → moderate shows wreckage and fleeing crowds, not bodies.",
    authoredStatus: "authored-needs-david-review",
  },
  strong: {
    meaning:
      'The platform default. Per the code comment: the platform default is "strong" (visible death, bodies, explosions, weapons, action aftermath, without gratuitous gore).',
    renderImpact:
      "The default intensity in every render policy and in the override's checkbox scaffold. The planner's default line is violence=ALLOW (strong), which explicitly permits the bodies/casualties the fact calls for.",
    example: '"{NAME} killed 50 people with a grenade throw" → strong depicts the casualties the fact describes, non-gratuitously.',
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
    renderImpact:
      'No current pipeline behavior selects or amplifies it — the compiler never emits "graphic"-flavored language. It exists so a future adult/NSFW mode has a schema slot; do not use it today.',
    example: "None today — selecting it renders like strong; the value is reserved for a future mode.",
    sourceRefs: [
      {
        path: "lib/api-zod/src/renderPolicyEnums.ts",
        symbol: "VIOLENCE_INTENSITY_VALUES",
        note: "The authoritative comment defining strong as the platform default and graphic as future-compatible only.",
      },
      COMPILER,
    ],
    authoredStatus: "code-derived",
  },
} satisfies Record<ViolenceIntensity, ValueDoc>;

// ─── Field docs ──────────────────────────────────────────────────────────────

export const VISUAL_STRATEGY_FIELD_DOCS: FieldDoc[] = [
  {
    key: "vso.panel",
    label: "Visual Strategy Override",
    hint: "Moderator art-direction merged into the compiled prompt's labeled sections — it corrects the AI plan, never replaces it.",
    whatItIs: [
      "A per-fact, style-agnostic override object a human moderator edits to correct or sharpen the AI's visual strategy WITHOUT hand-editing the brittle final engine prompt. It is stored inside the enrichment blob (enrichment.visualPromptStrategyOverride) and merged into the deterministic compiler's labeled sections at render time — so the final prompt still adapts to subject, pronouns, reference image, style, render mode, aspect ratio, and the render policy.",
      "Activation is presence-based — there is no enable toggle. Each populated sub-field merges into its own compiled section on its own; a field left blank simply contributes nothing. An override whose every field is empty compiles identically to having no override at all, so clearing a field is how you 'turn it off'.",
      "Write plain English — don't hand-type tokens. Each rendered-text field just needs the subject's name written naturally (\"David laughs\", not \"{NAME} laughs\"); on Save the system auto-tokenizes every changed field through the same tokenizer fact submission uses, and shows you the tokenized result right there so you can verify it and correct it before it persists. Chips ({NAME}, {NAME_POSSESSIVE}, {SUBJ}, and the other pronoun tokens) remain in the toolbar as an expert escape hatch, but authoring no longer requires them. Name ONLY the main subject in your prose; refer to every other character by role (\"the mother\", \"a bystander\") — the tokenizer only replaces the subject's name and pronouns, so a second named character would be left literal.",
      "The violence policy override here is the ONLY thing that can suppress violent depiction — the auto-sanitizing modifiers were retired, and the planner is told the render policy 'is the ONLY layer that may suppress; do not self-censor beyond it'.",
    ],
    howDerived: [
      "Authored by moderators only — the AI never generates it. The save path stamps server-owned provenance (updatedBy/updatedAt, shown as 'Last edited …' at the panel's foot), and the whole object is preserved verbatim across re-classification, so re-running enrichment never wipes your art direction.",
    ],
    renderImpact: [
      "The Visual Concept (CORE SCENE) LEADS the compiled prompt; every other section is operational or additive. Each sub-field lands in its own compiled section: subject realization → SUBJECT REALIZATION (required); required details → REQUIRED VISUAL DETAILS (required); forbidden/negative entries → 'Do not …' lines in STRICT CONSTRAINTS (required); role bindings → ROLE DETAILS (additive — only what the Concept didn't already state); composition guidance → COMPOSITION; style-agnostic additions → ADDITIONAL DETAILS. Required-priority sections always survive the engine's char budget, so moderator intent is never silently dropped.",
      "The override MERGES into the AI's plan — it never replaces it. Anything you don't specify still comes from the AI plan and the authored archetype strategy.",
      "The whole override object is in the render-input hash, so ANY edit (including admin-only fields) flips render-scenario tiles stale.",
    ],
    workedExamples: [
      {
        scenario: "The AI's plan is 90% right but keeps adding a second adult subject next to the baby version.",
        input: 'Forbidden Visual Details: ["a separate adult version of the subject"].',
        outcome: '"Do not add a separate adult version of the subject." lands in STRICT CONSTRAINTS; everything else in the AI plan is untouched — no toggle to flip, the filled field applies on its own.',
      },
      {
        scenario: "You want to back out a one-off experiment.",
        input: "Clear the fields you added (leave them blank).",
        outcome: "With nothing populated, the override contributes nothing — renders behave as if it never existed. Presence, not a toggle, is what activates each field.",
      },
      {
        scenario: "You write a Required Visual Detail naming the subject in plain English.",
        input: 'Required Visual Details: ["David\'s face on the statue"]',
        outcome: 'Click Save — the system tokenizes it to "{NAME_POSSESSIVE} face on the statue" and shows you the result. Tokens resolve per render; a plain name persisted as-is would leak into every other user\'s render, which is exactly what auto-tokenize prevents.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, PLANNER_RENDER_POLICY, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.coreSceneOverride",
    label: "Visual Concept (Core Scene)",
    hint: "Describe the picture in plain English, naming only the subject — on Save the system tokenizes it and shows you the result.",
    whatItIs: [
      "The moderator-authored scene: 2–4 plain-language sentences describing exactly what the image shows (subject, action, setting, objects, composition). When non-empty, it is AUTHORITATIVE — the planner LLM is directed to realize exactly this scene (not invent its own), and the compiler emits it as the CORE SCENE section at required priority, never compressed under the char budget.",
      "Write it in plain English, naming the subject naturally (\"David leans against the bar\"). On Save the system tokenizes it (the same tokenizer fact submission uses) and shows the tokenized result in the field so you can verify it before it persists — the field is still editable afterward. Name ONLY the main subject; refer to any other character by role (\"the bartender\", \"a passerby\"), never by name, since the tokenizer won't recognize a second name as personalizable. Capped at 1500 characters: it is a scene brief, not a full prompt.",
      "Also surfaced as the prominent 'Visual concept — describe the picture' card in moderation visual review; both surfaces edit this same field. Typing a non-empty concept auto-enables the override.",
    ],
    howDerived: [
      "Authored by moderators only — the AI never writes it. Preserved verbatim across re-classification like the rest of the override.",
    ],
    renderImpact: [
      "Replaces the AI plan's coreScene as the CORE SCENE section (required, non-compressible, marked MODERATOR in the prompt breakdown).",
      "The compiler still owns identity/reference/text-policy language: engine instructions written here ('preserve the face', 'no readable text') are stripped, with a visible warning in the prompt diagnostics. A concept that consists ONLY of such instructions falls back to the AI scene with a loud warning — never a silently empty scene.",
      "The planner LLM also receives it as a hard directive, so subjectDetails/environment/lighting are planned to support THIS scene.",
    ],
    workedExamples: [
      {
        scenario: "The AI keeps missing the scale gag in a participation-trophy fact.",
        input: 'Visual concept: "David triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory."',
        outcome: 'Click Save — the field shows "{NAME} triumphantly holds a participation trophy the size of a grain of rice, photographed like a championship victory." CORE SCENE is exactly that sentence (token-resolved per render), the planner fleshes out supporting detail around it, and it survives the char budget uncompressed.',
      },
      {
        scenario: "You write engine instructions instead of a scene.",
        input: 'Visual concept: "Preserve the uploaded face and do not show readable text."',
        outcome: "Both clauses are compiler-owned and stripped; the diagnostics warn that the concept emptied out and the AI scene was used instead. Rewrite as visible scene description.",
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
  {
    key: "vso.moderatorIntent",
    label: "Moderator Intent",
    labelSuffix: "(admin-only, not rendered)",
    hint: "WHY you overrode — a note for humans; never compiled into any prompt.",
    whatItIs: [
      "Free text explaining the intent behind the override, for yourself and other admins. It is explicitly excluded from the rendered text fields — the compiler never emits it, and it is not a token-insert target (tokens in it are neither needed nor validated).",
    ],
    howDerived: ["Written by moderators; the AI never touches it."],
    renderImpact: [
      "None on the compiled prompt — it never leaves the admin UI.",
      "HONEST CAVEAT: the render-input hash includes the override object WHOLESALE, so editing this field DOES flip render-scenario tiles stale even though no compiled prompt changes because of it. Re-running the flagged scenarios will produce byte-identical prompts.",
    ],
    workedExamples: [
      {
        scenario: "You pinned an unusual subject realization.",
        input: 'Moderator Intent: "AI kept rendering a realistic baby — pinning adult-head composite per David\'s note 6/30."',
        outcome: "The next admin understands the override; the engine prompt is unaffected (but tiles flag stale due to the wholesale hash).",
      },
    ],
    effect: "human-only",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.subjectRealization",
    label: "Subject Depiction Mode",
    hint: "Pin HOW the subject is physically realized in the image — human, transformed, object, symbolic — when the AI keeps getting it wrong.",
    whatItIs: [
      "A mode dropdown that pins the subject's physical realization. The default use_ai_plan keeps the AI's own subject treatment; any other mode requires a description (the editor warns when it's empty) — because only the DESCRIPTION is compiled, never the mode name itself.",
    ],
    howDerived: [
      "Moderator-chosen after reviewing test renders. Pick the mode that names your intent, then write the description as a complete instruction (see the per-value docs).",
    ],
    renderImpact: [
      'When a mode other than use_ai_plan is set with a non-empty description, the description is emitted as the required-priority "SUBJECT REALIZATION" section, placed right after SUBJECT BINDING so it leads the visual prose.',
      "It ADDS to (never replaces) the compiler-owned SUBJECT BINDING / anti-split guards; if your realization conflicts with a default guard (e.g. you WANT a realistic full de-age), express the conflict via Forbidden Visual Details.",
    ],
    values: valuesFrom(SUBJECT_REALIZATION_MODE_VALUES, SUBJECT_REALIZATION_DOCS),
    workedExamples: [
      {
        scenario: '"{NAME} as a baby ran the boardroom" — the AI renders a realistic baby, losing the recognizable face.',
        input: 'mode: adult_head_on_transformed_body, description: "{NAME}\'s recognizable adult head on a baby\'s body in a tiny suit"',
        outcome: 'The prompt gains "SUBJECT REALIZATION: {NAME}\'s recognizable adult head on a baby\'s body in a tiny suit." (token resolved per render) at required priority.',
      },
      {
        scenario: "You set a mode but leave the description blank.",
        input: "mode: subject_as_object, description: \"\"",
        outcome: "Nothing is emitted (the section needs a description) and the editor warns 'Subject realization mode is set but its description is empty.'",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.subjectRealizationDescription",
    label: "Subject Depiction Description",
    hint: "The actual compiled text of the SUBJECT REALIZATION section — write it as a complete instruction.",
    whatItIs: [
      "The token-aware text that IS the SUBJECT REALIZATION section. The mode dropdown categorizes your intent, but this description is the only part the engine ever sees — so it must fully state the realization on its own.",
    ],
    howDerived: ["Moderator-authored. Token chips insert {NAME}/{NAME_POSSESSIVE}/pronoun tokens at the caret; name-token variants are canonicalized on save and unknown tokens rejected."],
    renderImpact: [
      'Emitted verbatim (tokens resolved, terminal punctuation normalized) as the required "SUBJECT REALIZATION" section — required priority means it survives the char budget.',
      "Skipped entirely when the mode is use_ai_plan or the description is blank.",
    ],
    workedExamples: [
      {
        scenario: "Pinning a symbolic realization.",
        input: '"{NAME} is off-frame; the crowd stares upward at a silhouette blotting out the sun"',
        outcome: "That sentence leads the prompt's realization, steering the whole scene composition.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.requiredVisualDetails",
    label: "Required Visual Details",
    hint: "Concrete things that MUST be visible — each entry becomes part of a required prompt section.",
    whatItIs: [
      "A list (max 40 entries) of concrete, visible details the render must include. Token-aware. Write each entry as a noun-y visual ('{NAME}'s recognizable face on a newborn body'), not intent commentary.",
    ],
    howDerived: ["Moderator-authored, typically after a test render omitted something load-bearing for the joke."],
    renderImpact: [
      'Entries are joined into the required-priority "REQUIRED VISUAL DETAILS" section (each entry a clause, "; "-separated), placed right after SUBJECT DETAILS. Required priority means the engine char budget can never drop them.',
      "They also seed the compiler's de-dupe haystack, so later sections don't repeat them.",
    ],
    workedExamples: [
      {
        scenario: "The joke needs the trophy shelf visible but renders keep cropping it.",
        input: 'Required Visual Details: ["a shelf crowded with gold trophies behind {NAME}"]',
        outcome: '"REQUIRED VISUAL DETAILS: a shelf crowded with gold trophies behind {NAME}." (token resolved) — guaranteed to survive budgeting.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.forbiddenVisualDetails",
    label: "Forbidden Visual Details",
    hint: "Things that must NOT appear — each entry becomes a \"Do not …\" line in STRICT CONSTRAINTS.",
    whatItIs: [
      "A list (max 40 entries) of visuals to ban. Each entry is normalized into a negative constraint: an entry not already phrased negatively gets a 'Do not ' prefix (entries starting with Do not/Don't/Avoid/Never/No are kept as-is, never double-prefixed).",
    ],
    howDerived: ["Moderator-authored — the standard fix for a recurring wrong element in test renders, and the sanctioned way to override a default compiler guard you disagree with."],
    renderImpact: [
      "Normalized entries join the required-priority STRICT CONSTRAINTS section (after the compiler's own supporting-text, violence, and anti-split constraints), so they always survive the char budget.",
    ],
    workedExamples: [
      {
        scenario: "Renders keep adding a second adult next to the de-aged subject.",
        input: 'Forbidden Visual Details: ["a separate adult version of the subject"]',
        outcome: '"Do not a separate adult version of the subject." — better: write it verb-first ("show a separate adult version of the subject") so the prefixed line reads "Do not show a separate adult version of the subject."',
      },
      {
        scenario: "An entry already phrased as a negative.",
        input: '["Never show the subject\'s back to camera"]',
        outcome: 'Kept as-is: "Never show the subject\'s back to camera." — no double "Do not" prefix.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.roleBindings",
    label: "Scene Role Assignments",
    hint: "Who is who in the scene — your bindings REPLACE the AI's secondary-character casting. Entity is a label (\"subject\" or a role); Visual Role is plain English that gets tokenized on Save.",
    whatItIs: [
      "A list (max 20) of entity → visual-role pairs. The entity is a plain label — \"subject\" or a relationship/type label (\"mother\", \"crowd/victims\") — never a personalization token: typing the subject's own name auto-normalizes to \"subject\" on Save, and a stray {NAME}/{SUBJ}-style token typed here is rejected as an error (both client-side and as a hard server-side rule) since this field identifies WHO, not prose to render. The visual role is what that entity concretely is/does in the frame, written in plain English — it IS token-capable and gets auto-tokenized on Save just like the Visual Concept.",
    ],
    howDerived: ["Moderator-authored when the AI casts roles wrongly — the classic failure being a secondary character drifting into the subject's central action."],
    renderImpact: [
      "When ANY binding is present, your bindings take precedence over the AI plan's secondaryCharacters wholesale: the 'subject' entity's role becomes the subject's role-in-scene, and every other entity becomes a secondary character.",
      'They are compiled into the ROLE DETAILS section as ADDITIVE clauses — but the Visual Concept (CORE SCENE) now LEADS the prompt and carries the scene, so ROLE DETAILS only surfaces a role the Concept did not already state (redundant ones are dropped). A role that already names the subject is emitted as-is (never doubled to "<Name> is <Name> …"); a bare role gets a "<subject> is <role>" clause. Negatives belong in Forbidden Visual Details, not here.',
      "Rows with an empty entity or role are skipped (the editor warns).",
    ],
    workedExamples: [
      {
        scenario: '"A baby drove David\'s mother home." — renders keep putting the subject behind the wheel.',
        input: 'Role Bindings: "David" (entity) → "the astonished passenger" (visual role), "baby" → "the tiny driver gripping the wheel"',
        outcome: 'Click Save: the entity "David" normalizes to "subject" (it matched the subject\'s name); the visual role tokenizes to "the astonished passenger" (no name in it, nothing changes) and "the tiny driver gripping the wheel" for baby. Result: "ROLE DETAILS: {NAME} is the astonished passenger. baby is the tiny driver gripping the wheel." (emitted only if the Visual Concept did not already cast these roles) — replacing the AI\'s own casting.',
      },
      {
        scenario: "You accidentally type a token directly into the entity field.",
        input: 'entity: "{NAME}"',
        outcome: 'Save blocks with a clear error on that row (red-bordered) — entity is a label like "subject" or "mother", never a token. Type the plain name or role instead; a real subject name there auto-collapses to "subject".',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.bubbles",
    label: "Speech & Thought Bubbles",
    hint: "Make a character in the scene speak or think an exact line — a balloon rendered into the image with the text lettered verbatim. Attribute it to \"subject\" or a plain role label; shorter text renders more reliably.",
    whatItIs: [
      "A list (max 4; 1–2 works best) of bubbles: a type (Speech = tailed balloon; Thought = cloud with a trail of circles), WHO it belongs to (the same rules as a Scene Role Assignment entity — \"subject\" or a plain role label like \"the bartender\", never a token), and the exact text to letter (max 80 characters, soft warning at 60 — legibility drops with length). Text is token-capable ({NAME} etc.) and is whitespace-normalized on Save; what you see saved is exactly what the engine is asked to letter.",
    ],
    howDerived: [
      "Moderator-authored, or proposed by the AI Visual-ideas generator when the fact contains a literal quote — picking an idea fills these rows (draft-only; Save still applies).",
    ],
    renderImpact: [
      "Each bubble compiles to one deterministic directive in the required SPEECH & THOUGHT BUBBLES section (stored order preserved, never de-duplicated or compressed). Explicit bubbles render even when the supporting-text policy is \"forbid\" — moderator intent wins; overlay/caption text stays forbidden as ever.",
      "Bubbles have their own prompt-budget pool: if the combined directives exceed it, Save fails with a bubble-specific error — shorten the text or remove a bubble. Nothing is silently dropped.",
      "An entity that matches no scene character still renders its directive, but the model may add, ignore, or misattribute that character — the preview shows a warning; confirm the render.",
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
    key: "vso.compositionGuidance",
    label: "Composition Guidance",
    hint: "Framing/camera/layout directives folded into the COMPOSITION section.",
    whatItIs: [
      "A list (max 20) of composition directives — framing, camera angle, subject placement, negative space. Token-aware.",
    ],
    howDerived: ["Moderator-authored, layered after the AI plan's own framing + camera + caption-negative-space directives."],
    renderImpact: [
      "Entries are appended to the COMPOSITION section (high priority — included while the char budget allows, after all required sections are safe).",
    ],
    workedExamples: [
      {
        scenario: "Renders keep centering the subject when the joke needs scale contrast.",
        input: 'Composition Guidance: ["low-angle wide shot; {NAME} tiny in the lower third against the colossal object"]',
        outcome: "The directive joins the COMPOSITION section after the AI plan's framing/camera lines.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.styleAgnosticPromptAdditions",
    label: "Extra Prompt Details (any style)",
    hint: "Extra scene text that must work under EVERY visual style — compiled as ADDITIONAL DETAILS.",
    whatItIs: [
      "A list (max 20) of free-form prompt additions that hold under any look/style the render is later given (photoreal, cartoon, painterly). Don't put style words here — style comes from the separate style system. Token-aware.",
    ],
    howDerived: ["Moderator-authored for content that doesn't fit the more specific fields (details, roles, composition)."],
    renderImpact: [
      'Compiled into the "ADDITIONAL DETAILS" section, placed after ENVIRONMENT at high priority and compressible — under extreme budget pressure it is trimmed sentence-by-sentence before being dropped (unlike the required override sections). Prefer Required Visual Details for anything that must survive unconditionally.',
    ],
    workedExamples: [
      {
        scenario: "The scene needs weather that isn't a required element.",
        input: 'Style-Agnostic Prompt Additions: ["a light drizzle glossing every surface"]',
        outcome: '"ADDITIONAL DETAILS: a light drizzle glossing every surface." — included while budget allows, style-neutral.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.negativePromptAdditions",
    label: "Do-Not-Render Additions",
    hint: "Exclusions — but Nano Banana 2 has NO negative-prompt parameter, so these become prose \"Do not …\" constraints.",
    whatItIs: [
      "A list (max 20) of exclusion entries. Despite the name, the target engine has no negative-prompt API parameter (the plan validator forces compiledPrompt.negativePrompt empty) — so every entry is turned into a prose constraint inside the positive prompt.",
    ],
    howDerived: ["Moderator-authored. Functionally these merge with Forbidden Visual Details; use whichever framing reads clearer for the exclusion."],
    renderImpact: [
      'Each entry is normalized into a "Do not …" line (same no-double-prefix rule as Forbidden Visual Details) and appended to the required-priority STRICT CONSTRAINTS section — guaranteed to survive the char budget. Nothing is ever sent through a negative-prompt channel, because none exists.',
    ],
    workedExamples: [
      {
        scenario: "Renders keep adding lens flare.",
        input: 'Negative Prompt Additions: ["add lens flare or bloom effects"]',
        outcome: '"Do not add lens flare or bloom effects." appears in STRICT CONSTRAINTS as prose — the engine has no negative-prompt parameter to receive it any other way.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [
      OVERRIDE_SCHEMA,
      COMPILER,
      {
        path: "lib/api-zod/src/imagePromptGeneration.ts",
        symbol: "validateImagePromptPlan",
        note: "Rule 16: compiledPrompt.negativePrompt must be empty for nano_banana_2 — exclusions must be positive prose.",
      },
      STALE_HASH,
    ],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.supportingTextPolicy",
    label: "Override supporting-text policy",
    hint: "Governs IN-WORLD readable text (signs, titles, scoreboards) — overlay/caption text is always excluded regardless.",
    whatItIs: [
      "An optional policy override (checkbox + mode + guidance) for in-world readable text. Two distinct text layers exist: the meme caption/fact text is composited OUTSIDE the image and is ALWAYS excluded from the render (the compiler unconditionally emits the overlay-text exclusion — no captions, watermarks, logos, brand marks baked in); this policy governs only text living inside the scene.",
      "When the checkbox is off, the default policy (allow) applies. Guidance is token-aware.",
    ],
    howDerived: ["Moderator-set. The editor warns when mode=require has no guidance — required text must be described."],
    renderImpact: [
      "Compiled into the required-priority STRICT CONSTRAINTS section per mode (see the per-value docs). Independently, an always-on incidental-text guard keeps background signage non-readable while yielding to any intentional in-scene text, so you only need mode=forbid to fully suppress text the scene would otherwise want. If the AI planner picked concrete supportingTextElements, those render regardless of mode — the planner's scene content is the strongest signal.",
    ],
    values: valuesFrom(SUPPORTING_TEXT_MODE_VALUES, SUPPORTING_TEXT_MODE_DOCS),
    workedExamples: [
      {
        scenario: '"Sharks have a {NAME} Week" — the joke needs the title card readable.',
        input: 'mode: require, guidance: \'a TV title card reading "{NAME} Week"\'',
        outcome: '"SUPPORTING TEXT: Readable in-scene text is required in this scene. Show it clearly: a TV title card reading "{NAME} Week"." (token resolved per render).',
      },
      {
        scenario: "Gibberish signage keeps appearing.",
        input: "mode: forbid",
        outcome: '"Avoid readable in-scene text unless required by a higher-priority instruction." joins STRICT CONSTRAINTS.',
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [OVERRIDE_SCHEMA, COMPILER, STALE_HASH],
    authoredStatus: "code-derived",
  },
  {
    key: "vso.violencePolicy",
    label: "Override violence policy",
    hint: "The ONLY control that can suppress violent depiction — default is allow at strong intensity.",
    whatItIs: [
      "An optional policy override (checkbox + mode + intensity + guidance) for how much of the fact's violence/consequences the scene depicts. The checkbox scaffold defaults to allow + strong — the platform default that depicts what the fact requires, including bodies/casualties, without gratuitous gore.",
      "This override is the ONLY violence suppressor in the pipeline: the auto-sanitizing modifiers were retired, and the planner is explicitly told the render policy 'is the ONLY layer that may suppress; do not self-censor beyond it'.",
    ],
    howDerived: ["Moderator-set, typically to soften/suppress a fact whose default renders are too grisly for its context. Guidance (token-aware) refines or, under allow, replaces the default directive line."],
    renderImpact: [
      'suppress emits the literal compiler line: "Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage."',
      'soften emits: "Soften violent consequences; avoid graphic injury and visible death unless explicitly required by a higher-priority instruction."',
      'allow emits the permission line only when the fact is violence-relevant (a violence modifier — cinematic_aftermath, projectile_impact_power, action_comedy — or violent lexicon in the fact/plan): "When the fact explicitly requires violence, death, weapons, or destruction, depict the action and consequences clearly without gratuitous gore." Your guidance text replaces it when set.',
      "All of it lands in the required-priority STRICT CONSTRAINTS section; the planner separately receives a matching RENDER POLICY block so scene planning and compilation agree. Intensity is planner-side context under allow (see the per-value docs) — the compiler never emits \"graphic\"-flavored language.",
    ],
    values: [
      ...valuesFrom(VIOLENCE_MODE_VALUES, VIOLENCE_MODE_DOCS),
      ...valuesFrom(VIOLENCE_INTENSITY_VALUES, VIOLENCE_INTENSITY_DOCS),
    ],
    workedExamples: [
      {
        scenario: '"{NAME} once threw a grenade and killed 50 people, then it exploded." — a render context where no bodies should be visible.',
        input: "mode: suppress",
        outcome: '"Do not depict violence, injury, or death directly; represent consequences symbolically or through environmental damage." — cratered ground instead of casualties.',
      },
      {
        scenario: "The same fact rendered normally.",
        input: "No override (default allow + strong)",
        outcome: "The fact is violence-relevant, so the allow permission line is emitted and the aftermath is depicted as the fact calls for.",
      },
    ],
    effect: "render-affecting",
    staleBehavior: "marks-render-stale",
    sourceRefs: [
      OVERRIDE_SCHEMA,
      COMPILER,
      PLANNER_RENDER_POLICY,
      {
        path: "lib/api-zod/src/renderPolicyEnums.ts",
        symbol: "VIOLENCE_INTENSITY_VALUES",
        note: "The intensity ladder + the strong-is-default / graphic-is-future-only comment.",
      },
      STALE_HASH,
    ],
    authoredStatus: "code-derived",
  },
];
