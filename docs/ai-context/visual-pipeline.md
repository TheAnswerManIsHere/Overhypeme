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
   non-compressible`. Since PR #222 it is **VERBATIM**: token-rendered but
   otherwise unmodified — NOT run through `sanitizePlannerProse` /
   `scrubIntentLanguage` (those apply only to the AI-scene path). Compiler-owned
   language is **detected and warned** (`moderator_core_scene_owned_language`,
   non-mutating), never stripped, and a non-empty Concept **never** falls back to
   the AI scene. (Only an empty/whitespace Concept uses the AI scene.)

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

## Frozen render inputs: identity + style (reproducibility)

**A render's identity and style are frozen ONCE, at the moment the user clicks
generate — never re-resolved live by the async worker (PR #223).**
`prepareImagePromptAttemptInputs()` (`imagePrompt/prepareAttemptInputs.ts`)
resolves a `PromptIdentitySnapshot` (`promptIdentity.ts`) and a
`ResolvedRenderStyleSnapshot` (`styleResolution.ts`), renders the fact text
from that SAME identity (so the frozen fact text and the compiler's later
token gate can never diverge), and persists both snapshots onto
`render_controls`. The `image_prompt_generation` worker reads the frozen
snapshots (`isValidPromptIdentitySnapshot` / `isValidRenderStyleSnapshot`)
instead of re-querying the user/style tables, falling back to live resolution
only for attempt rows that predate this change. Wired into both user-facing
generate routes (`/memes/ai/:factId/generate-v2`, and the generic branch of
`/generate`); moderation/eval renders use fixed sample identities and no live
style, so they were already reproducible and are intentionally left on their
existing `reviewRenderSubject` mechanism.

**The identity fed into the image prompt is reduced to a short prompt-safe
name** — `reducePromptName()`: prefer the validated `firstName`; else the
first whitespace-delimited token of `displayName`; else the canonical
fallback (`"Alex"`) — grapheme-safe-bounded to `RENDERED_IDENTITY_NAME_MAX`
(20 chars, `promptIdentityBudget.ts`). This is a **render-time reducer only**,
not a new profile storage bound: `validators/personalName.ts` remains the
sole source of truth for what a user may store, and the composited meme
**caption** (`createMemeRecord.ts`) independently uses the full stored
display name, untouched.

**An invalid/inactive/over-budget style is a typed rejection, never a silent
"no style."** `resolveRenderStyle()` returns a discriminated
`default | selected | invalid` result (reason: `not_found` / `inactive` /
`empty_suffix` / `copy_too_long` / `copy_invalid`); a generate request with an
invalid style gets an HTTP 400 before any paid work is enqueued, instead of
the worker quietly resolving `stylePrompt = ""`.

## Render-time prompt budget

**The engine prompt ceiling is 6900 chars** (`MAX_PROMPT_CHARS`,
`compilers/nanoBanana2.ts`; raised from 4000 — PR #224 — and again from 6000
to fund the dedicated bubble pool, David-approved. NB2's real context window
is ~131K tokens, so the ceiling is editorial discipline against
bloated/redundant authoring, not an engine capacity limit). The budget is
split into five reserves, derived from a **measurement of the real
compiler**, not invented numbers — `measureRequiredPromptBudget()`,
`measureModeratorAdditionsEmission()`, and `measureBubbleDirectivesEmission()`
(`imagePrompt/promptBudget.ts`) compile maximum-fixed-shape prompts through
the actual compiler and a proof test asserts the split still fits:

```
6900 = FIXED_REQUIRED_RESERVE_BUDGET (1750, measured compiler overhead)
     + CORE_SCENE_RENDERED_MAX       (2000, the moderator Concept)
     + MODERATOR_ADDITIONS_RENDERED_MAX (1500, other moderator content, excl. bubbles)
     + BUBBLE_DIRECTIVES_RENDERED_MAX (900, the SPEECH & THOUGHT BUBBLES section)
     + PROMPT_OUTER_MARGIN           (750, safety slack)
```

The additions measurement **excludes bubbles** and the bubble measurement
carries **only** bubbles, so the two pools can never double-count. The 900
pool fits 2–3 maximum-length bubbles or 4 realistic ones (the compact
directive template is deliberate — every fixed word bills against the pool);
a payload that can't fit fails save with `bubble_directives_rendered_too_long`
— never a silent drop or partial section.

**The bubble-text placeholder used for measurement must preserve the real
literal characters, not just their projected length** (Codex P2, PR #229,
post-merge fix). Bubble text is the one field whose compiled form runs
through an *escaping* serializer (`serializeLiteralPromptString` — every
embedded `"`/`\` doubles). A naive length-only placeholder (e.g. `"x".repeat(n)`)
either **undercounts** real quoted speech (no escaping ever triggers) or, if
filled with worst-case-escaping characters uniformly, **over-penalizes**
ordinary quote-free bubbles regardless of their actual content. The fix,
`projectWorstCaseRenderedText()` (`lib/api-zod/promptIdentityBudget.ts`,
sibling to `projectWorstCaseRenderedLength`), walks the same token-substitution
logic but returns the real authored string with only `{TOKEN}` spans replaced
by a safe worst-case-length filler — so the measurement, run through the real
serializer via the same delta-compile method, reflects the actual escaping
cost of what a moderator (or the AI proposer) actually wrote. **Generalizes:**
any save-time budget measurement for a field whose compiled form is
content-transformed (escaped, wrapped, case-folded, …) — not just
length-expanded by token substitution — needs a placeholder that preserves
the real content through that transform, not a content-blind filler.

**Save-time validation measures the compiler's actual emitted length, not a
raw field-text sum** (Codex caught this on PR #224 before merge: a naive sum
of raw field text undercounts what the compiler emits — `"Do not …"` negation
prefixes, `"label: "` role-binding forms, `"; "`-joins, and per-section
labels that only appear once a field is populated). `validateVisualStrategyOverrideForSave()`
(`lib/api-zod/src/promptBudget.ts`) takes the measured emission as an
argument from its caller (the save routes), which computes it via
`measureModeratorAdditionsEmission()` — compile the fixed shape twice (once
with the override's worst-case-projected content, once empty) and take the
delta, so every fixed cost cancels out and what remains is the additions'
true contribution. **Never re-derive a raw-sum estimate for this check** — it
will silently undercount; see the `naiveAdditionsRenderedLowerBound` doc
comment for why it's a lower bound only, never the gate.

`CORE_SCENE_RAW_MAX` (1500) matches the frontend editor's
`CORE_SCENE_MAX_CHARS` and the candidate generator's `CANDIDATE_SCENE_MAX_CHARS`
— a save is never rejected by the budget gate for content the authoring UI
itself presented as valid.

**The compiler never silently truncates required content that overflows the
budget** — the old behavior (`assembleSections`' final hard-cut) could lop the
STRICT CONSTRAINTS safety guardrails off the end of the assembled prompt,
since they're emitted last. It now surfaces
`diagnostics.requiredBudgetOverflow` and the worker fails terminal
(`required_budget_overflow`) instead of shipping a guardrail-truncated
prompt. Reachable only by legacy over-budget content — save validation
prevents it for new saves.

## Terminal vs retryable render failures

The `image_prompt_generation` worker classifies each deterministic stage
failure as **terminal** (fails the queue row on the first attempt, no wasted
retries, typed `error_code` persisted) vs the existing **retryable** default
(transient failures still retry with backoff) — see
[`architecture-map.md`](./architecture-map.md#async-jobs-and-queues) for the
underlying additive `HandlerResult` contract. Terminal codes:
`invalid_persisted_enrichment`, `rendered_fact_unresolved_token`,
`planner_output_invalid_after_retry` (only when the planner's error is
validation-exhaustion, `ImagePromptError.cause === "validation_exhausted"` —
a genuine provider/timeout failure stays retryable), `compile_failed`,
`moderator_core_scene_unresolved_token`, `required_budget_overflow`. Both
`error` (human-readable) and the typed `error_code` are cleared on a
successful later attempt and surfaced together in the render-poll payload
(`buildRenderStatusPayload`) so the UI never parses a "code: message" string.

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

## Visual Strategy Override authoring (auto-tokenize on Save)

Moderators author `coreSceneOverride` and the rest of `visualPromptStrategyOverride`
in **plain English** — naming the subject naturally ("David leans against the
bar"), not hand-typed `{NAME}`/pronoun tokens. Clicking **Save** runs every
changed rendered-text field through the shared tokenizer core (see
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#shared-core-fact-submission-and-admin-visual-concept-authoring-pr-206))
and **shows the tokenized result in the field** before it persists — not a
silent swap, mirroring the fact-submission write→preview→confirm pattern. This
is the ONE save path (`tokenizeAndSaveVisualOverride` in
`useFactEnrichmentEditing.ts`) every VSO surface calls — the Visual Concept
card, the full override panel, and the Facts-page save all route through it,
and it always persists the *whole* current enrichment so a concurrent hashtag
edit is never dropped.

**Authoring rule (load-bearing):** name ONLY the main subject; refer to every
other character by role, never by name ("the bartender", not a second real
name). The tokenizer only recognizes the personalized subject, so a second
named character is left literal in the compiled prompt — this rule is what
keeps tokenization reliable, and it's also what keeps `roleBindings` (below)
from double-naming the subject on the compiler side.

**A role binding's `entity` is a plain label, never a token.** `roleBindings[i]`
has two fields with different rules: `visualRole` is prose — token-capable,
auto-tokenized on Save like any other field. `entity` identifies WHO the role
belongs to ("subject" or a relationship/type label like "mother") — it is
**never** tokenized; typing the subject's own name there auto-normalizes to
the literal string `"subject"` (`normalizeRoleEntity`), and a `{…}` token typed
there is rejected as an error, enforced **both** client-side (Save blocks and
red-borders that row) **and** by a hard schema `superRefine` backstop in
`visualPromptStrategyOverrideSchema` (defense-in-depth for a bypassed route or
a manual PATCH). This is why `entity` is no longer a token-chip target in the
editor and no longer canonicalizes a typed token — it's a label field, not
rendered prose.

**Any field the tokenizer can't cleanly resolve blocks persistence** and
surfaces a field-specific red-bordered error (`vsoTokenizeErrors`) instead of
silently saving something wrong; both the Visual Concept card and the override
panel disable entirely while a batch tokenize round trip is in flight
(`vsoTokenizing`), so no edit can race it.

## Candidate Visual Concepts

AI-drafted picks to avoid blank-page authoring (`lib/api-zod/src/visualConcepts.ts`,
Slice 2A / PRs #163, #166). The planner drafts exactly **3**
`{title, whyItWorks, sceneDescription, bubbles}` concepts during moderation prep,
stored on `facts.visual_concept_candidates`. They use a **render-mode-agnostic**
context so a pick works across all modes. A pick applies the WHOLE concept
via `withCandidateConceptDraft` (scene → `coreSceneOverride`, bubbles →
`bubbles`; unrelated VSO fields preserved; never merged; atomic — one invalid
bubble makes the whole concept unpickable).

**Picking is blocked while unrelated Visual-Strategy edits are unsaved**
(`computeCandidatePickBlockedReason`, `components/admin/candidatePickGate.ts`).
Candidates are validated server-side against the **persisted** override, but a
pick only replaces the scene + bubbles fields — so an unsaved draft edit to
any *other* field (role bindings, required details, …) would let a pick land
on a base the server's saveability proof never covered. The gate gives clear
copy ("Save or discard your current Visual Strategy changes…") rather than
silently risking a stale-base save. Scene/bubble-only dirtiness (typing in the
Concept box, a previous pick) stays pickable — only *other*-field drift blocks.
**Gotcha:** a MISSING override (nothing persisted yet) must normalize to the
same stripped shape as the empty scaffold `withCoreSceneOverride`/`withBubbles`
create on a moderator's first edit, or the comparison wrongly treats a fresh
empty-arrays draft as "different from nothing" and blocks picking on the very
first keystroke (Codex P2, PR #229).

**Candidate bubble contract (prompt version 2):** `bubbles` is REQUIRED on
the strict wire (`[]` = the normal no-bubble case; strict Structured Outputs
forbids omittable properties). The generator proposes a bubble only when it
materially serves the gag — the headline case is a literal quote in the fact
text (the exact quote goes in `bubbles[].text`, never restated in the scene:
single-channel is enforced by `detectBubbleDirectiveLanguage` + a
literal-restatement check, with the one corrective retry). Over-cap text is
INVALID output, never truncated (slicing a quote corrupts it). Token errors
store the candidate unpickable (the existing scene pattern); an
all-unpickable response FAILS the attempt rather than storing `ok`. Every
pickable concept is preflighted through `validateVisualStrategyOverridePersistence`
on the exact override a pick produces, so pickable ⇒ saveable is shared-code
truth. The deployed system prompt was migrated (0090) because
`seedVisualConceptsConfig` is ON CONFLICT DO NOTHING — editing the TS default
alone never reaches deployed rows (same class as migration 0085).

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
ENVIRONMENT · ADDITIONAL DETAILS · COMPOSITION · LIGHTING · RENDER STYLE · STRICT
CONSTRAINTS. **Style is single-channel (PR #222):** `LIGHTING` carries physical
light/mood/palette only, and the selected visual style is emitted as its own
required **RENDER STYLE** section (the resolved `stylePrompt`, or a medium-only
photorealistic default when none) — never folded into lighting. Supporting-text
elements carry a `kind` (`literal_text` → quoted glyphs; `visual_graphic` →
unquoted "depict as visuals, not written words"), so a description is never baked
in as literal text. Every section after CORE SCENE is either **operational** (identity/
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

## Speech & thought bubbles (moderator control, compiler-owned language)

Explicit `bubbles` on the VSO (`{type: speech|thought, entity, text}`, max 4;
text ≤80 chars, soft-warn 60; entity follows role-binding rules — "subject"
or a plain label, tokens hard-rejected). Ownership is strictly
single-channel:

- **The compiler owns all bubble prompt language**: one compact deterministic
  directive per bubble (stored order, atomic, via the shared
  `serializeLiteralPromptString` — tokens render BEFORE escaping) in the
  required `SPEECH & THOUGHT BUBBLES` section, which is **dedupe-exempt**
  (`dedupe: "none"` — the assembler's sentence de-dup would otherwise drop a
  bubble whose words the Concept already used). Explicit bubbles render even
  under `supportingText.mode === "forbid"`; the overlay-caption exclusion is
  untouched (a carveout line states the precedence in compiled language).
- **The runtime planner only stages** (gated by `includeModeratorBubbles`,
  planner-true / candidate-false): it sees type/entity/rendered-text context
  and is told to pose characters compatibly and leave headroom — never to
  author balloons. While bubbles are active, planner prose that authors a
  balloon is stripped (`bubble-directive-owned-by-compiler` removal reason);
  a moderator Concept doing the same gets a non-mutating warning
  (`bubble_language_in_moderator_scene`).
- **Entity diagnostics are structured** (`diagnostics.warnings`, never the
  breakdown): `bubble_entity_unresolved` / `bubble_entity_ambiguous` with a
  typed `{bubbleIndex, entity}` context, resolved against subject + role
  bindings + the planner's effective secondary characters (so a valid
  secondary-speaker bubble doesn't false-warn). The directive still emits —
  moderator authority; the engine may still misresolve, which UAT verifies.
- **UI**: ONE shared `BubbleEditor` (first-class beside the Visual Concept
  card on Moderation + embedded in Advanced VSO), one draft, no drift.

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

- Requiring moderators to hand-type personalization tokens to author the
  Visual Strategy Override — retired by PR #206. Authoring is plain English;
  Save auto-tokenizes and shows the result. Token chips remain only as a
  manual fallback, not a requirement.
- A global "no readable text" rule.
- `gpt-4o-mini` / `gpt-image-1` / FLUX as the render prompt/model path — the render
  path is the **frontier planner (`gpt-5.5`) + Nano Banana 2** (`nano-banana-2` /
  `nano-banana-2-edit`). (`gpt-4o-mini` survives only for utility/Pexels keywords;
  FLUX only via `pulid-flux` in video.)
- An enrichment-time visual-preview phase (retired; render-time plan/compiler is
  the source of truth).
- Violence auto-softeners; per-route preview identities; competing prompt channels.
- **Re-resolving identity or style LIVE in the async worker** — retired by
  PR #223; both are frozen at attempt-construction (see "Frozen render inputs"
  above). A worker that re-queries `usersTable`/`lookStylesTable` directly
  instead of reading `render_controls.promptIdentity` /
  `.resolvedRenderStyle` has regressed this.
- **Silently hard-truncating required prompt content when it overflows the
  budget** — retired by PR #224; the compiler now fails terminal
  (`required_budget_overflow`) instead, because the old truncation could cut
  the STRICT CONSTRAINTS safety guardrails off the end.
- **Summing raw VSO field text as a proxy for the compiler's emitted length**
  — this undercounts the compiler's wrapping (negation prefixes, role-binding
  labels, list joins, section labels) and was the exact bug Codex caught on
  PR #224. Any new save-time budget check must measure through the real
  compiler (`measureModeratorAdditionsEmission()` pattern), never sum raw
  field lengths.

## Files to inspect before visual-pipeline work

- `imagePrompt/generator.ts` (planner), `compilers/nanoBanana2.ts` (compiler),
  `compilers/failureModeConstraints.ts`, `modifierDirectives.ts`,
  `imagePrompt/preview.ts` (parity), `imagePrompt/types.ts`,
  `imagePrompt/resolveRenderReviewInput.ts`, `imagePromptJobs.ts` (production),
  `imagePromptConfig.ts`, `imagePromptAttempts.ts`.
- **Reproducibility (PR #223):** `imagePrompt/prepareAttemptInputs.ts`
  (freeze + render fact text from the same identity), `promptIdentity.ts`
  (`PromptIdentitySnapshot`, `reducePromptName`), `styleResolution.ts`
  (`ResolvedRenderStyleSnapshot`, `resolveRenderStyle`),
  `lib/api-zod/src/resolvedIdentityForms.ts` (shared token/grammatical-form
  contract), `promptIdentityBudget.ts` (`RENDERED_IDENTITY_NAME_MAX`,
  `projectWorstCaseRenderedLength`).
- **Prompt budget (PR #224):** `imagePrompt/promptBudget.ts` (api-server —
  `measureRequiredPromptBudget`, `measureModeratorAdditionsEmission`, the
  live-compiler measurement), `lib/api-zod/src/promptBudget.ts` (the reserve
  constants + `validateVisualStrategyOverrideForSave`), `asyncJobs.ts`
  (`HandlerResult`, `terminalFailure`).
- `lib/api-zod/src/imagePromptGeneration.ts`, `visualStrategyOverride.ts`
  (override schema + the path-aware `collectRenderedTextEntries` /
  `setRenderedTextAtPath` / `normalizeRoleEntity` authoring helpers),
  `visualConcepts.ts`, `visualPromptStrategies.ts` (11 authored strategies),
  `renderPolicyEnums.ts`.
- Authoring: `artifacts/api-server/src/routes/ai.ts` (`/ai/tokenize-enrichment`),
  `useFactEnrichmentEditing.ts` (`tokenizeAndSaveVisualOverride`),
  `useDraftForm.ts` (`saveValue`), `EnrichmentEditor.tsx`
  (`VisualStrategyOverridePanel`, `isFixableRoleEntityTokenIssue`),
  `VisualConceptCard.tsx`, `subjectExampleNames.ts`.
- `engines/openai-visual-planner.ts`, `engines/nano-banana-2*.ts`, `catalogue.ts`;
  `sourceImageAnalysis/`; `factRenderScenarios.ts` (render-input hash).
- `.agents/memory/image-prompt-preview-parity.md`, `docs/ADMIN_FIELD_REFERENCE.md`.
