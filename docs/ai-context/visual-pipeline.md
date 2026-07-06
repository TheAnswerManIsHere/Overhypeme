# Visual Pipeline

> How a fact becomes a rendered image. This is the subsystem most prone to
> agents reintroducing old mistakes — read this and the failure patterns before
> touching it. Primary code: `artifacts/api-server/src/lib/imagePrompt/` (planner
> + compiler), `imagePromptJobs.ts` (production), and `lib/api-zod/src/` schemas.
>
> **Do not confuse two "image" pipelines:** `factImagePipeline.ts` is the **Pexels
> stock-photo seeding** path (builder backgrounds; uses `gpt-4o-mini` only to
> extract search keywords) — it is **NOT** where meme renders are planned. The
> render-time meme pipeline is `imagePrompt/` + `imagePromptJobs.ts`.

## Current source of truth

For a moderated render, the **moderator-authored "Visual Concept (Core Scene)" is
authoritative** when present. It is stored at
`enrichment.visualPromptStrategyOverride.coreSceneOverride`
(`lib/api-zod/src/visualStrategyOverride.ts`), capped at 1500 chars, carries
`{NAME}`/pronoun tokens, and is canonicalized + token-validated on save. It is
consumed **deterministically** in two places:

1. As a **planner directive** — `generator.ts` emits it under "MODERATOR-AUTHORED
   CORE SCENE (AUTHORITATIVE — hard directive)".
2. As the **compiler CORE SCENE section** — `nanoBanana2.ts` uses the moderator
   core over the AI plan's `coreScene`, marked `moderatorAuthored / required /
   non-compressible`. (It still passes compiler-owned sanitization; if it's empty
   after sanitize it falls back to the AI scene with a **loud warning**, never
   silently.)

**The render-time plan + compiler are the single source of truth for what the
model receives.** Enrichment is an input, not the prompt (see
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)).

## End-to-end render flow

1. **Source-image analysis** (`sourceImageAnalysis/`) picks a `subjectRenderMode`.
2. **Frontier planner** (`generateImagePromptPlan()`) → `visualPlan` +
   `subjectFactCompatibility` via OpenAI Structured Outputs. `subjectFactCompatibility`
   is **advisory only — it never blocks rendering**. Facts are manually curated, so a
   "poor" rating still renders (possibly imperfectly) rather than leaving the user
   with nothing; the rating is persisted for admin visibility only. (A legacy job-level
   block existed before this was retired — see `imagePromptAttempts.ts`'s
   `buildRenderStatusPayload` comment for the historical-row mapping it left behind.)
   The "never blocks" instruction to the planner lives in **two** places that must
   stay in sync: the per-request user-message contract
   (`generator.ts`'s `buildImagePromptUserMessage()`) and the admin-configurable
   **system** prompt default (`imagePromptConfig.ts`'s
   `FACT_IMAGE_PROMPT_SYSTEM_DEFAULT`, key `fact_image_prompt_system`). The system
   prompt is seeded into `admin_config` with `ON CONFLICT DO NOTHING` — editing the
   TS constant does **not** reach an already-seeded row; changing that copy needs an
   idempotent DML migration too (see `0084_strip_stale_compatibility_fallback_rule.sql`,
   which mirrors the `0082_strip_retired_text_modifiers.sql` pattern).
3. **Compiler** (`compileForSubjectRenderMode()`, Nano Banana 2) → the
   engine-specific `compiledPrompt`.
4. **Production** (`imagePromptJobs.ts`) renders via fal.ai and persists an attempt
   (`imagePromptAttempts.ts`).

## Text-to-image vs image-to-image

`SUBJECT_RENDER_MODE_VALUES` (`lib/api-zod/src/imagePromptGeneration.ts`):

- `human_identity_i2i` — preserve a recognizable human face (reference image).
- `nonhuman_subject_i2i` — preserve an uploaded non-human subject.
- `t2i_fallback` — no reference; uses `fallbackSubjectGender`.

`tier2Heuristics.ts` suggests the mode from image analysis; a user choice can
override (`resolveSubjectRenderMode`). `generationModeFromSubjectRenderMode` maps
`t2i_fallback → "t2i"`, everything else → `"i2i"`.

## Visual Concept

The authoritative human-authored scene (above). A moderator authors it directly,
or **picks a candidate** (next section) which becomes the `coreSceneOverride` via
the same cap/token rules — "no new write surface."

## Candidate Visual Concepts

AI-drafted picks to avoid blank-page authoring (`lib/api-zod/src/visualConcepts.ts`,
Slice 2A / PRs #163, #166). The planner drafts exactly **3**
`{title, whyItWorks, sceneDescription}` concepts during moderation prep, stored on
`facts.visual_concept_candidates`. They use a **render-mode-agnostic** context so a
pick works across all modes. A pick → `coreSceneOverride`.

## Frontier visual planner

`generateImagePromptPlan()` (`imagePrompt/generator.ts`) calls OpenAI with strict
Structured Outputs. Engine is resolved from admin key `fact_image_prompt_engine_id`,
default **`openai-visual-planner`** (`engines/openai-visual-planner.ts`,
`endpointId: "gpt-5.5"`, `kind: llm`, `tierRequirement: legendary`, high reasoning
effort, 180 s timeout, deliberately blocked from becoming the global default LLM).
Resolution **never throws** — it falls back to the default utility LLM with a
recorded `fallbackReason`. (Introduced by PR #157.)

## Prompt compiler

`compileForSubjectRenderMode()` in `compilers/nanoBanana2.ts` — the
**deterministic Nano Banana 2 compiler**. It dispatches by render mode and
assembles a labeled contract where **the Visual Concept (CORE SCENE) LEADS**:
CORE SCENE · IDENTITY & REFERENCE (i2i) / RENDER TASK (t2i) · SUBJECT BINDING ·
SUBJECT REALIZATION · ROLE DETAILS · SUBJECT DETAILS · REQUIRED VISUAL DETAILS ·
ENVIRONMENT · ADDITIONAL DETAILS · COMPOSITION · LIGHTING AND STYLE · STRICT
CONSTRAINTS. Every section after CORE SCENE is either **operational** (identity/
reference, binding, style, policy) or **strictly additive** — it earns its place
only by contributing a concrete detail the Concept omitted; restatements are
de-duped out (content-word contiguity against emitted text). The old REFERENCE
INTERPRETATION section is gone: role info now flows through the additive **ROLE
DETAILS** section (`composeAdditiveRoleDetails`), which never doubles a name
("Alex is Alex leans…" — the retired bug). **The compiler OWNS** the identity/
reference/binding/STRICT-CONSTRAINTS/text-policy language; planner prose that
duplicates these is stripped (`RemovedProseReason`). The de-dupe haystack is
seeded ONLY from emitted text (never the non-emitted visualGoal/visualApproach).
Dropped role/key-element candidates are recorded in
`diagnostics.droppedCandidates`. Nano Banana 2 has **no negative-prompt
parameter** — exclusions are positive scene language.

## Render policy and readable text

**There is NO blanket "no readable text" rule** — do not reintroduce one. The
compiler always emits only the **narrow** overlay-text exclusion (no baked meme
captions, fact text, hashtags, watermarks, real logos/brand marks — the mandatory
forbidden set). In-world text (signs, TV titles, scoreboards, UI, numbers/symbols)
is governed by the `supportingText` policy mode
(`["allow","forbid","require"]`, `renderPolicyEnums.ts`):

- If the planner chose concrete `supportingTextElements`, the compiler renders that
  in-scene text clearly **regardless of mode** (scene content is the strongest
  signal).
- `require` → text required; `forbid` → avoid unless a higher-priority instruction
  requires it; `allow` (default) → silent unless intentional guidance.

Moderators can override via `supportingTextPolicyOverride`. Several authored
archetype strategies explicitly permit concise numbers/symbols/UI (formal-logic
equations, technology UI/status, the pi-PIN "four crisp digits"). The old
`no_readable_text` modifiers still map to bans **only when explicitly set** — not
globally.

## Identity and subject binding

Single-subject preservation is **deterministic in the compiler, not left to the
LLM**. `composeSubjectBinding()` fuses reference identity + life-stage transform +
single-instance into one entity ("Render exactly one {subject}. The transformed
subject IS {subject} — the same person de-aged or aged, not a second person"), and
`composeAntiSplitConstraints()` adds paired negative guards (no adult-plus-separate
baby, no clones). Age/life-stage transforms (`ageLifeStageTransform`,
`modifierDirectives.ts`) **must compile — never silently dropped**. The plan
validator enforces mode-appropriate likeness claims (t2i/nonhuman must not claim
human facial likeness).

**PuLID is NOT on the still-image render path** — it's Stage 1 of the *video*
pipeline only. Nano Banana 2 edit is the recommended still-image upgrade from
PuLID.

## Admin preview/debug surfaces (Runtime Compiled Prompt)

The admin **"Runtime Compiled Prompt Preview" must match runtime.** Parity comes
from all three surfaces going through the **same core path** —
`generateImagePromptPlan()` + `compileForSubjectRenderMode()` — not from a shared
wrapper. The **two admin preview surfaces** (the admin fact-page RCP preview,
`POST /admin/image-prompt/preview`, and the i2i/t2i engine workbench) call those two
functions via `assembleImagePromptForPreview()` (`imagePrompt/preview.ts`) and
nothing else; **production** (`imagePromptJobs.ts`) calls the same two functions
**directly** (it does *not* route through the preview helper). Both preview surfaces
must feed the canonical test identity `RUNTIME_PREVIEW_DEFAULT_NAME = "David
Franklin"` / he/him; production uses the real user identity
(`resolveAttemptIdentity`).

**Preview ≠ byte-identical to production** because `IMAGE_PROMPT_TEMPERATURE = 0.4`
(two live calls word differently). Divergence is **temperature, not caching** —
previews don't cache and don't read the `aiScenePrompts` blob (that cache serves
only video/PuLID/backfill). Making outputs identical needs temp 0 or result-reuse
— **ask David first** (see `.agents/memory/image-prompt-preview-parity.md`).

## Known failure modes

- **Duplicate/competing planning channels** — the compiler owns identity/
  reference/text-policy; don't let planner prose re-author those clauses.
- **Injecting raw enrichment behind the planner** — cultural references and
  semantic entities are planner *inputs* only; they are deliberately NOT re-emitted
  to the engine as "Interpret X means Y" meta lines (would leak brand names/meta).
- **Blanket text bans** — retired; keep the narrow overlay-only exclusion.
- **Preview/runtime mismatch** — never re-hardcode a per-route preview name; don't
  blame caching for divergence (it's temperature).
- **Reintroducing violence auto-softeners** — the old `avoid_gore`/
  `non_graphic_action` auto-softeners were removed; only an explicit moderator
  `soften`/`suppress` policy may reduce depiction. Default is `allow (strong)`.
- **Over-constraining sole-agent** — the strong sole-agent line is keyed off
  stored frame/modifiers, never raw fact text, so it can't fight intended
  co-action/crowd/symbolic scenes.

## Things NOT to reintroduce

- A global "no readable text" rule.
- `gpt-4o-mini` / `gpt-image-1` / FLUX as the render prompt/model path — the render
  path is the **frontier planner (`gpt-5.5`) + Nano Banana 2** (`nano-banana-2` /
  `nano-banana-2-edit`). (`gpt-4o-mini` survives only for utility/Pexels keywords;
  FLUX only via `pulid-flux` in video.)
- An enrichment-time visual-preview phase (retired; render-time plan/compiler is
  the source of truth).
- Violence auto-softeners; per-route preview identities; competing prompt channels.

## Files to inspect before visual-pipeline work

- `imagePrompt/generator.ts` (planner), `compilers/nanoBanana2.ts` (compiler),
  `compilers/failureModeConstraints.ts`, `modifierDirectives.ts`,
  `imagePrompt/preview.ts` (parity), `imagePrompt/types.ts`,
  `imagePrompt/resolveRenderReviewInput.ts`, `imagePromptJobs.ts` (production),
  `imagePromptConfig.ts`, `imagePromptAttempts.ts`.
- `lib/api-zod/src/imagePromptGeneration.ts`, `visualStrategyOverride.ts`,
  `visualConcepts.ts`, `visualPromptStrategies.ts` (11 authored strategies),
  `renderPolicyEnums.ts`.
- `engines/openai-visual-planner.ts`, `engines/nano-banana-2*.ts`, `catalogue.ts`;
  `sourceImageAnalysis/`; `factRenderScenarios.ts` (render-input hash).
- `.agents/memory/image-prompt-preview-parity.md`, `docs/ADMIN_FIELD_REFERENCE.md`.
