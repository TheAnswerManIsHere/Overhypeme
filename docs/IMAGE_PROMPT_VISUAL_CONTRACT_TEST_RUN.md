# Image-prompt visual contract + age-transform binding — automated test run

Paired with **`docs/IMAGE_PROMPT_VISUAL_CONTRACT_UAT.md`** (the click-through
acceptance test). This doc is the engineering safety net for Replit.

## TL;DR

```
# libs (from repo root) — api-zod schema + validator changes
pnpm run typecheck:libs                                                  # clean

# api-server (from artifacts/api-server)
pnpm run typecheck                                                       # tsc + cycles + no-console, clean
node --import tsx/esm --test src/__tests__/nanoBanana2Compiler.test.ts        # 28 pass
node --import tsx/esm --test src/__tests__/imagePromptGeneration.validate.test.ts  # all pass
node --import tsx/esm --test src/__tests__/modifierDirectives.test.ts         # all pass
node --import tsx/esm --test src/__tests__/imagePromptUserMessage.test.ts     # all pass
node --import tsx/esm --test src/__tests__/imagePromptPreview.test.ts         # 12 pass
node --import tsx/esm --test src/__tests__/adminEngines.test.ts               # pass (non-regression)

# overhype-me (from artifacts/overhype-me)
pnpm run typecheck                                                       # clean
npx vitest run src/__tests__/RuntimePromptPreview.test.tsx               # 9 pass
npx vitest run                                                          # full suite green
```

## The problem this fixes

"When David was born, he drove his mom home from the hospital" rendered with an
**adult** David plus a **separate** baby (or just an adult driving). Three causes,
all in the render-time pipeline:

1. The compiler's hardcoded lead said *"Preserve the reference person's
   recognizable face"* with **no age caveat**, and the semantic directive split
   the adult ("David") from "the baby" — two entities, never fused.
2. `modifierDirectives.ts` had **no mapping** for `age_transform` /
   `baby_child_version` / `older_self_version`, so de-aging was silently dropped.
3. The engine prompt front-loaded abstract intent ("showcasing the absurdity",
   "Intent: … Stage it as: …") instead of describing the picture.

## What changed

The Nano Banana engine prompt is now a fixed, deterministic **labeled contract**
assembled by `compilers/nanoBanana2.ts`:

```
IMAGE-TO-IMAGE TASK · SUBJECT BINDING · CORE SCENE · SUBJECT DETAILS ·
ENVIRONMENT · COMPOSITION · LIGHTING AND STYLE · STRICT CONSTRAINTS
```

- **Transformation-aware identity** — the i2i preamble preserves *recognizable
  identity and likeness* and explicitly *allows age / body / hair / clothing /
  life stage to transform* while keeping the same person (no more unconditional
  "preserve the face").
- **SUBJECT BINDING** (deterministic, human i2i only) fuses identity + life
  stage: *"The reference person is David. David is a baby/infant in this scene.
  Render exactly one David. The transformed baby IS David — the same person
  de-aged, not a second person."* Triggered by `ageLifeStageTransform.applies`
  **or** an age modifier, **or** `avoid_duplicate_subject` (single-instance form).
- **STRICT CONSTRAINTS** carries the negative anti-entity-split guards (*"Do not
  render the adult reference person separately. Do not add a second, generic
  baby."*) plus semantic/cultural/text-policy rules.
- **Intent scrub** — authorial commentary ("showcasing the absurdity",
  "emphasizing the humor", "humorous contrast", etc.) is stripped deterministically
  from every visual field, clause-by-clause, so only pixels-mapping language ships.
- **Age modifiers** now compile into loud directives in `modifierDirectives.ts`
  and are never dropped.

### Schema (render-time only — NO DB migration, regenerated each render)

`lib/api-zod/src/imagePromptGeneration.ts`, `IMAGE_PROMPT_GENERATION_VERSION` →
`v3`:

- `visualPlan` gains concrete visual fields: `coreScene` (string),
  `subjectDetails` (string[]), `environment` (string[]), `lightingAndStyle`
  (string). These map 1:1 to the labeled sections.
- `subjectTreatment.ageLifeStageTransform` `{ applies: boolean; targetState: string }`.
- `visualGoal` / `visualApproach` remain but are **internal** (no longer emitted
  to the engine).
- New validator rules (17–18): `coreScene` non-empty, ≥1 `subjectDetails`, ≥1
  `environment`; `ageLifeStageTransform` coherence (`applies` ⇒ non-empty
  `targetState`; `!applies` ⇒ empty `targetState`). Each returns a
  `correctableHint` so the generator's one-shot corrective retry can self-fix.

The OpenAI system prompt (`imagePromptConfig.ts`) and user message
(`imagePrompt/generator.ts`) were updated to produce the new fields, ban intent
commentary, and signal the age transform.

## Schema / DB checks for Replit

- **No migration.** These fields live only in the render-time LLM response and
  the in-memory plan; nothing persists a new column. Confirm `drizzle-kit` shows
  **no pending schema diff** from this branch.
- The `image_prompt_attempts` / `memes` tables are untouched.

## Test inventory

- **`nanoBanana2Compiler.test.ts` (28)** — labeled structure + headers;
  transformation-aware preamble; SUBJECT BINDING from modifier and from
  LLM-provided `targetState`; anti-split guards; age modifier → loud directive;
  `avoid_duplicate_subject` single-instance binding; binding omitted for plain
  facts; **non-human subject with an age modifier gets NO person/adult language**;
  intent-scrub (clause-level + whole-sentence + structured fields); no "Intent:/
  Stage it as:"; budget survival of required sections; breakdown reassembly.
- **`imagePromptGeneration.validate.test.ts`** — new rules 17–18 (empty
  coreScene/subjectDetails/environment rejected; ageLifeStageTransform coherence)
  plus all prior rules still green.
- **`modifierDirectives.test.ts`** — every age modifier maps to a loud,
  identity-bound de-aging/aging directive and is never dropped.
- **`imagePromptUserMessage.test.ts`** — the user message documents the concrete
  fields, the age-transform binding, and the no-intent rule.
- **`imagePromptPreview.test.ts` / `adminEngines.test.ts`** — end-to-end through
  the real compiler with the new schema; transformation-aware preamble surfaced.
- **`RuntimePromptPreview.test.tsx`** — the admin compiled-prompt preview surfaces
  the new `coreScene`/`subjectDetails`/`environment`/`lightingAndStyle` fields and
  renders the new breakdown section ids/labels.

## What's deliberately NOT shipped

- No DB migration / re-enrichment (render-time only).
- Non-human age handling stays with the modifier directives + non-human identity
  preamble; the person-style binding is human-i2i only by design.
- No rollout flag — on by default (pre-launch).
