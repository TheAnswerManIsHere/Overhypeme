# Plan — pictures drawn straight from the approved gag

```plan-oracle
Direction served
The approved gag is the authority for what a picture shows (visual-pipeline.md, "Current source of truth"; PLAN_THREE_GAGS.md). Humans approve gags; AI classification of a fact (enrichment) is kept for AI and code to use, and is no longer something moderators maintain or something that shapes a picture behind the gag (David, 2026-11-17).

Product intent (agreed by David, 2026-11-17)
- A picture is drawn from the approved gag and the compiler's fixed wording, with no AI planning call per picture.
- The useful work the render planner does today is re-homed, not dropped: pet subjects, bubble speakers, and filler detail (setting, lighting, pose) work at least as well as today. David: "We need to make sure we're not throwing out the baby with the bathwater on the planner."
- Bubble speakers: each gag carries its own cast (who is in the scene besides the subject, with a short description of each), produced by an AI step when the gag is saved and shown to the moderator read-only; the speaker dropdown offers the subject plus that cast; the compiler writes the speaker binding from the stored cast.
- Violence: comedic violence and its consequences are drawn reliably; intense gore is not. One rule, stated in one place, that a later NSFW mode can change. David: "A lot of the facts will have violence in them and that's for humor so it's important that we allow violence without creating intense gore (until we enable NSFW mode which might change that policy)."
- A moderator edits a gag as a scene and its bubbles, and that is everything that shapes the picture. The eleven "More art direction" controls leave both the screen and the pipeline; any live gag using one has its content folded into the scene text first (Q1: 1).
- The taxonomy editor leaves the moderation screen and stays on the Facts editor under an "AI classification" section; characters, hashtags and the humor note stay on moderation (Q2: 1).
- The age-transform and "one subject, no clones" compiler code, the modifier-keyed guards (crowd, cause-and-effect, role-reversal, sole-agent) and the keyword violence-relevance check are removed; the gag writer owns age handling.

Must not change
- An existing bubble's wording (the balloon instruction and its text).
- Tokenizing on save; the three-gag rules; a gag change applying only when its test renders are approved.
- The fact character list in enrichment and its moderator override.
- The legal and safety scanner.
- Classification data: nothing is deleted from enrichment.
- Every picture starts from a photo; engine routing by look.

Settled decisions
- Subjects are people and pets only; vehicles and objects are leaving the product (David, 2026-11-15, Issue #964). The pet case is in scope; an object case is not.
- Test renders are per gag: male, female, pet (PLAN_GAG_EXAMPLES.md, Issue #965, in flight). This work builds on it and does not redesign it.
- The locked gag-writer system prompt changes only by David's approval of its wording (docs/plans/gag-prompt-LOCKED.md).
- AI call settings live in code (decisions.md, 2026-11-14).
- Prompt wording versions (recipes) are stored and promoted in the database (prompt tuner).

Now / Next / Never
- Now, increment 1 (evidence): build the planner-free path beside the current one, including the per-gag cast, and run a blind before-and-after comparison David judges (person, pet, an age-change fact, a two-speaker bubble, a violent fact). The planner is removed only if the new path holds up.
- Now, increment 2 (switch): remove the planner and the compiler code named above; add the pet instruction, the cast-based speaker binding and the single violence line.
- Now, increment 3 (editor): the simpler gag card with cast chips and the cast-fed speaker dropdown; live values in the eleven controls folded into scenes; the taxonomy editor off the moderation screen.
- Next: uses of the classification (similar facts, filtering, video direction); whether enrichment's unused fields are dropped.
- Never in this work: NSFW mode; deleting classification data.

Ceremony
Full production loop; touches the visual pipeline and enrichment (sensitive subsystems); any data change to stored gags gets the migration review.
```

Workstream: #982

## Problem

Three things read as one to a moderator and are not.

1. **A picture is planned twice.** A moderator approves a gag (scene and bubbles). At render time a second AI, the render planner (`imagePrompt/generator.ts`, GPT-5.5 at high effort, 180 s timeout), is called for every picture. It receives the whole classification and an archetype strategy headed "apply this — do not improvise" (`generator.ts:550`), then the gag marked authoritative (`generator.ts:359`). Its output fills the sections that follow the gag in the prompt (subject details, environment, lighting, key elements) and nobody sees it before the picture is drawn. It costs up to $0.768 per two calls at the recorded bound (`visual-pipeline.md`, *The engine comparison*) and is the slowest step before the engine.
2. **The classification still steers pictures behind the gag.** The compiler reads `enrichment.modifiers` for age transforms, the no-clones guard, three modifier guards and a violence keyword check (`compilers/nanoBanana2.ts:448, 779–795, 1281–1298`; `failureModeConstraints.ts`). A moderator who never opens the taxonomy cannot see why a picture changed.
3. **The gag card has eleven controls nobody needs.** "More art direction" (`GagsPanel.tsx:224`) exposes Moderator Intent, Subject Depiction Mode and Description, Required and Forbidden Visual Details, Scene Role Assignments, Composition Guidance, Extra Prompt Details, Do-Not-Render Additions, and the supporting-text and violence policy overrides. Each exists to correct the planner.

## Direction

As the oracle block. This plan makes true: what the moderator approved, plus wording that is the same for every fact, is the whole prompt.

## Product Intent, Must Not Change, Settled Decisions

As the oracle block above, verbatim.

## Vocabulary

- **Planned path** — today's: planner call, then the compiler.
- **Direct path** — the compiler alone, from the gag's content, the photo's type, the look and the recipe.
- **Cast** — a list stored in a gag's content: each character in the scene other than the subject, as a `label` and a short `description` taken from the scene.
- **The fold** — the one-off conversion of a stored gag's eleven extra fields into its scene text.
- **Cast extraction** — the one producer of a cast: an AI step that reads a scene and its bubbles' speakers. It runs when a draft is prepared for saving, in the fold, and in comparison preparation.

## Repo Context Inspected (at `d08b786`)

`artifacts/api-server/src/lib/imagePrompt/generator.ts`, `compilers/nanoBanana2.ts`, `compilers/failureModeConstraints.ts`, `recipe.ts`, `preview.ts`, `imagePromptJobs.ts`, `visualConcepts/generator.ts`, `comparison/runs.ts`, `factRenderScenarios.ts`, `visualConcepts/inputHash.ts`, `moderation/nsfwClassifier.ts`, `moderation/falSafety.ts`, `routes/gags.ts`, `routes/ai.ts`; `lib/api-zod/src/visualStrategyOverride.ts`, `imagePromptGeneration.ts`, `promptBudget.ts`; `lib/db/src/schema/factGags.ts`; `artifacts/overhype-me/src/components/admin/gags/GagsPanel.tsx`, `EnrichmentEditor.tsx`, `BubbleEditor.tsx`, `fieldDocs/visualStrategy.ts`; `docs/plans/gag-prompt-LOCKED.md`, `PLAN_BUBBLE_SPEAKERS.md`, `PLAN_THREE_GAGS.md`; `docs/ai-context/visual-pipeline.md`, `taxonomy-and-enrichment.md`, `legal-safety-moderation.md`; fal's schemas for `openai/gpt-image-2.6/sunburst/edit` and `google/nano-banana-2.1/edit` (read 2026-11-17); Issues #964, #965, #968, #980; Astra's scope assessment (`.agents/reviews/gag-direct-render/round-0.md`).

## Current Behavior

- **Planner call sites** (`git grep -n "generateImagePromptPlan\|assembleImagePromptForPreview"`, non-test): the render worker (`imagePromptJobs.ts:160`); `preview.ts:82`, used by the admin Runtime Compiled Prompt preview (`routes/adminImagePrompt.ts:234`) and comparison preparation (`comparison/runs.ts:330`). The prompt-wording preview recompiles a stored attempt's plan (`imagePromptJobs.ts:750`, `routes/adminPromptRecipes.ts:85`).
- **What the compiler takes from the plan**: `coreScene` (unused when a gag exists, and every gag has a scene), `subjectDetails`, `environment`, `lightingAndStyle`, `keyVisualElements`, `subjectTreatment` (life stage), `secondaryCharacters`, `composition`, `supportingTextPolicy`, `archetypeApplication.selectedFrame`.
- **Speaker bindings** (#973): the planner must list each bubble speaker in `secondaryCharacters` under its exact label; the compiler writes `mom: the older woman in the red coat.` from that, or from a Scene Role Assignment when the gag has one (`PLAN_BUBBLE_SPEAKERS.md`, F).
- **Violence**: default "allow, strong". The engine gets the line `violence.allow` ("…depict the action and consequences clearly without gratuitous gore", `recipe.ts:232`) only when a modifier or a keyword matches (`nanoBanana2.ts:445`). A gag's violence override can soften or suppress. Nano Banana runs at `safety_tolerance` 5 of 6; GPT Image 2.6's `enable_safety_checker` defaults to true and we send nothing for it.
- **What screens a drawn picture**: the engine's own filter, and a moderator looking at test renders. The generated-image classifier scores sexual content, not gore (`moderation/nsfwClassifier.ts`). An engine's content refusal is not handled as its own outcome: Issue #980 records an attempt left `processing` after fal's `content_policy_violation`.
- **Render freshness** hashes classification and fact characters (`factRenderScenarios.ts:125`); the gag writer's own freshness reuses that projection (`visualConcepts/inputHash.ts:69`).
- **Pets**: the photo's type is known before planning (`sourceImageAnalysis/`, `subjectRenderMode`); the compiler already has identity wording for a pet's photo (`recipe.ts:95`). The locked gag-writer prompt tells the writer the subject may be a pet and not to require a human body (lines 7, 54, 168–170).

## Source-of-Truth Analysis

- **What a picture shows:** the gag's content version (scene, bubbles, cast). After this plan nothing else fact-specific reaches the engine. Classification stays the gag writer's input and stops being a render input.
- **The cast** is part of the gag's content, not a table of its own and not enrichment: it is derived from that version's scene, so it is approved, frozen on a render and promoted with it (`gagStore.ts` compares a render's frozen content with the gag's).
- **The fact character list** stays in enrichment. It names who the fact mentions; the cast names who this gag draws. Cast extraction is given the list so a character it finds is labelled as the fact labels them.
- **The violence rule** is one sentence defined once in code, and that sentence is what both the engine and the gag writer are sent. A recipe may format around it (label, position) and may not reword or drop it; a stored recipe version's own violence wording stops being read at the switch, so a promoted version adopts the rule without being re-saved. Balloon wording and every other recipe piece are untouched.
- **Wording that is the same for every fact** stays the recipe's.

## Proposed Design

### A. The direct path, and the comparison that decides it (increment 1)

- The compiler gains a way to compile with no plan: the gag's scene verbatim as CORE SCENE, then identity and reference, the cast's speaker bindings, the bubbles, composition and caption space from the render controls, the look, and STRICT CONSTRAINTS. The sections that exist only to carry planner output (subject details, environment, lighting, key elements, additive role details) are not emitted. The section order and every surviving line's wording are today's.
- **Filler hypothesis:** setting, lighting and pose the gag does not state are left to the engine, under one fixed instruction to keep the gag's scene exactly and fill unstated detail plausibly. Both routed engines reason before drawing (`reasoning_effort`, `thinking_level` in fal's schemas).
- **Pets:** when the photo is a pet, one fixed instruction tells the engine to stage the scene for that animal's body while keeping the gag's action. No per-picture rewrite call.
- **Violence:** the one rule (B) is emitted on every picture.
- **One selected gag is the input.** The direct compile is handed one gag's content (scene, bubbles, cast) as an explicit input, never "the fact's gag" read out of the classification; the attempt freezes that gag (its id and content); and the worker, the admin preview, a moderation render and the comparison are all given the same selection, the comparison choosing a gag rather than always the default one. Two gags on one fact compile to prompts that share no gag-owned text. (This is the remaining invariant of the compiler review's Phase 3, Issue #950, carried here because this plan rewrites that input path; the compiler-review session reports David absorbed Phase 3 into this plan, its Q11: 1, amendment PR #984.)
- **The direct side is the whole replacement.** It already leaves out everything increment 3 removes: the age-transform and no-clones lines, the modifier guards, the sole-agent and active-action lines, the keyword check, and every one of the eleven fields' sections. The shared code is deleted at the switch; its behaviour is absent from the direct side from the start.
- **The cast for a comparison** comes from cast extraction run at preparation and frozen on the panel. Increment 1 runs it nowhere else.
- **Comparison:** the engine comparison gains a third kind beside `engine` and `prompt`: each panel's pictures differ only by path. The same gag, bubbles, cast, photo, identity, look, engine and size are frozen per pair; the path is recorded on the cell and never shown while judging. It uses second-edition blind judging, with one addition: a panel shows the frozen bubbles it expected, each with its speaker, beside the frozen scene, so attribution and wording can be judged. David starts the run from the Eval page, where its cost is shown, as with every comparison.
- **The set David judges** covers, on both engine families: an ordinary fact; a pet photo; an age-change fact; a gag with two bubbles spoken by two different characters; a violent fact; and one fact with two gags, a picture of each, to show neither carries the other's content. At least two facts per case.
- **Acceptance is David's judgement, case by case and engine family by engine family.** Results are reported per case within each family, never pooled, so one engine cannot hide another's regression. For each he judges the property the case exists for: pet staging; age treatment; each balloon on its speaker with its words; filler detail (setting, lighting, pose) on the ordinary case; violent consequences shown without intense gore. The scores are aids to that judgement: broken counts and the Gag fidelity average per case, with a direct average more than half a point below the planned one flagged for his attention. No tolerance accepts a shortfall on his behalf.
- **A case that fails keeps the planned path.** The remedy is a revised fixed instruction, or a saved-gag adaptation designed and brought to David, followed by another comparison. A per-picture AI call for pets is not a fallback this plan authorizes: the oracle rules it out.
- Increment 1 changes nothing a moderator or a render does outside a comparison: no save runs cast extraction yet.

### B. Violence

- One sentence, defined once in code and sent word for word to the engine and to the gag writer (in its request's limits; the locked system prompt is unchanged): comedic violence and its consequences are shown clearly, without intense gore.
- The keyword check and the three violence-relevant modifiers go; the engine line is always present.
- A gag's violence and supporting-text overrides go with the eleven controls. A moderator who wants a gentler picture writes a gentler scene.
- Engine dials stay as they are. NSFW mode later changes the policy definition and the dials; nothing here builds it.
- **An engine's content refusal becomes its own terminal outcome** on a render: typed, not retried, shown on the test-render tile with the engine's reason. Issue #980 owns the diagnosis of the newborn case; this plan owns only that a refusal is visible and final.
- **Named limit, for the approval readout:** nothing we run scores a drawn picture for intense gore. For a moderator's test renders a human is the check. For a member's own picture (launch Phase 7, not built) the limit rests on the rule in the prompt and the engine's filter. What controls are adequate for member pictures is recorded as a decision for Phase 7's plan; no classifier is approved by this one.

### C. The cast (increment 1 builds extraction; increment 2 puts it in the editor)

- `cast` is a list in the gag's content: `label`, `description`, with a marker written only when an extraction succeeded. A successful empty cast (nobody else in the scene) and a cast never extracted are different states everywhere they are read.
- **One producer:** cast extraction. It reads a scene, its bubbles' speaker labels and the fact character list (for labels only: it never adds a character the scene does not show), and returns who is in the scene besides the subject. Its engine and prompt are set in code.
- **It binds, it never renames.** For each bubble speaker other than the subject, extraction must return a cast entry whose `label` is exactly that bubble's speaker string. A bubble's stored speaker and text are never changed by it.
- **The cast is derived, never authored.** Nothing writes a cast entry except extraction from that version's scene, so the scene alone is always enough to rebuild it.
- **In the editor it runs on the draft, before anything is stored** (F). A speaker the scene does not contain, or a failed extraction, stops the save with the draft kept and the gag's stored versions untouched.
- A used gag idea goes through the same preparation, so the locked gag-writer prompt is unchanged.
- The compiler's speaker binding (`nanoBanana2.ts:591`) reads the cast. The balloon directive itself is unchanged.
- The cast is part of the content a test render freezes and an approval compares, like the scene: a pending change's cast serves nobody until its renders are approved.

### D. What stops reading the classification (increment 3)

- The render worker, the admin prompt preview, comparison preparation and the prompt-wording preview all compile directly. The admin preview becomes exact: with no model call in it, the prompt it shows is the prompt a render sends.
- Removed: the planner, its engine definition and system prompt, its output contract and validator, the authored archetype strategies' render-only parts, `subjectFactCompatibility`, the age-transform and no-clones code, the modifier guards, the violence keyword check, the sole-agent and active-action lines.
- Kept: what the gag writer reads (the mechanism line and subtype guidance, reference meanings, limits).
- **Freshness is split:** a render's hash drops every classification field and the fact character list, and keeps everything else it covers today (the gag's content, the reference photo's version, the identity, the render controls, the look, the engine, the recipe). The gag writer's freshness keeps its own list of the classification fields it reads.
- Attempts recorded by the planned path keep their stored plan and stay readable everywhere they are shown; the prompt-wording preview handles both kinds. A direct attempt has no stored plan, so every reader that infers a state from the plan's presence (the render status's "prompt ready", `imagePromptAttempts.ts:239`) reads the compiled prompt instead.
- Recipe pieces that only the removed sections used stay stored in old versions and are ignored; the editor stops offering them.
- `IMAGE_PROMPT_GENERATION_VERSION` moves once, at the switch. Existing test renders then read out of date; nothing re-renders on its own.

### E. The fold and the cast fill (increment 2)

One resumable job, run before any reader of the eleven fields is removed, over every renderable gag version: approved and pending independently, a refresh's pending operations and example picks untouched.

- **Every version gets cast extraction**, whether or not it has anything to fold: a gag with no extra fields can still have a second speaker.
- **The fold is by meaning, and everything meaningful lands in the scene:** required details, composition guidance, extra prompt details and a subject depiction description become scene sentences; forbidden details and do-not-render additions become "no …" sentences; every Scene Role Assignment, the subject's own and a silent character's included, becomes a scene sentence saying who does what. The cast is then extracted from the folded scene by the one producer.
- **Policy overrides:** guidance on a violence or supporting-text override becomes a scene sentence where it describes the picture. A violence override of soften or suppress, a supporting-text override of forbid or require, and guidance that is policy and not picture, are listed for a moderator.
- Moderator Intent and notes, which never reached the engine, are kept in the archived original only.
- **Capacity:** the additions budget the eleven fields used (`MODERATOR_ADDITIONS_RENDERED_MAX`, 1500) moves to the scene, so a gag that fitted before the fold fits after it. Nothing is truncated; a version that still does not fit is listed.
- **A conversion that would change what the picture shows, and not only how the direction is written, is not done by the job:** the version is listed, and a moderator's edit goes through the ordinary pending change and render approval.
- **Increment 3 does not start until both lists are empty:** versions listed for a moderator, and versions whose cast extraction is missing or failed.
- The original content of every converted version is kept so the fold can be reversed.
- A folded approved version stays offered with its example (Issue #965, Q11, and its obligation that every live gag has its three examples before launch). Its test renders read out of date, as any content change does.

### F. The editor (increment 2)

- A gag card is: the scene, the bubbles, and read-only cast chips ("In this scene: mom, the bartender").
- **Preparing a draft** is the existing tokenize step with cast extraction added, run on the draft in the browser's hands and storing nothing. It runs when the moderator adds or edits a bubble after changing the scene, and again at Save if the scene changed since. The card shows that it is reading the scene, and its result: the tokenized scene and the cast.
- **The speaker dropdown offers the subject and the draft's cast.** A saved bubble whose speaker is not in the cast is shown unchanged, marked, and must be re-picked or the scene edited before the gag saves.
- So a moderator writes a scene, sees its cast, gives two characters a bubble each and saves once: no intermediate saved version, and no extra test render (Issue #965 draws one on save).
- "More art direction" and its eleven controls are gone from the card on both the moderation review and the Facts editor.
- The moderation review no longer shows the taxonomy editor. The characters editor is lifted out of it and stays on moderation with hashtags and the humor note. The Facts editor keeps the taxonomy under "AI classification".
- This lands with or after Issue #965's per-gag test renders, on the same card.

### Alternatives considered

- **Keep the planner, feed it less.** Rejected: it keeps the per-picture cost, the delay and the unseen second author.
- **Have the gag writer return the cast.** Rejected for now: it changes the locked prompt, and a moderator-written gag would still need a separate step, making two producers.
- **Require the speaker's label word for word in the scene.** Rejected: "mom" and "his mother" are the same person, and the binding needs a description of them.
- **Hide the eleven controls and keep them applying.** Rejected by David (Q1: 1).

## Data Model and Migration Impact

- `fact_gags` content gains `cast` and its extraction marker; no new table or column for it. Old content parses as *not extracted*, never as an empty cast.
- The fold is a resumable job with a dry run. Per version, two results. Fold: nothing to fold; converted; listed for a moderator; already converted (no-op). Cast: extracted (possibly empty); failed (retried by the next run); already extracted (no-op). It reports each count and the list.
- Comparison tables record the new kind and each cell's path.
- The eleven fields leave the schema's accepted input in increment 3; stored legacy keys parse and are ignored.
- Rollback: increment 1 and 2 add and convert, with originals kept. Increment 3's removal is a code revert while attempts recorded either way stay readable.

## Runtime Behavior and Edge Cases

- A render with a pet photo and a gag whose bubbles name a second speaker gets both the pet instruction and the binding.
- A gag with no other characters has an empty cast and no binding lines.
- A bubble speaker absent from the scene stops the save (today the pipeline tries to add them; under the gag-as-authority rule the scene must say they are there).
- A refresh's pending change carries its own cast; the approved version's cast keeps serving users until promotion.

## Admin UX Impact

- Preparing shows the tokenized scene and the cast together; a stopped save names the bubble, or says reading the scene failed and offers a retry.
- The fold's job has per-item and aggregate status in the pattern of Taxonomy Health.
- A refused render shows "the engine refused this picture" with its reason.

## Security, Permissions and Validation

- Preparing a draft and the job are admin-only. At save the server checks the cast it is given: the same label rules as a bubble speaker, a length cap on descriptions, an entry for every bubble speaker, and the prompt budget.
- No member-facing route changes.

## Testing Plan

- The direct compile is pinned by a captured corpus, as the planned path's is.
- Invariants asserted: a direct render's prompt does not change when any classification field or the fact character list changes; an existing bubble's directive is byte-identical on both paths; the violence sentence in the engine prompt and in the gag writer's request is the one constant, whatever recipe version is live; extraction never alters a bubble; a failed extraction stores nothing; not-extracted and empty casts are told apart.
- The fold: idempotent and reversible; each result state; a subject's role, a silent character's role and an allow-mode override with guidance all reach the scene; an ordinary legacy gag with a second-speaker bubble gets a cast.
- Integration: a pending change's cast is invisible to users until approval; a refresh promotion carries its cast; the worker and the admin preview produce the same prompt; a refused render ends terminal and typed; a direct attempt reports its status correctly with no stored plan.
- Gag selection: two gags on one fact compile to prompts sharing no gag-owned text; worker, preview, moderation render and comparison compile the gag they were given.
- The comparison kind: pairs differ only by path; the path is absent from every judging payload; the expected bubbles are shown.
- Screen facts are automated UI checks, not steps for David: preparing a draft shows its cast; the dropdown's options; the eleven controls absent on both screens; the taxonomy editor absent from moderation and present on the Facts editor.
- UAT (David): the blind comparison. Nothing else in this plan needs his eye.

## Implementation Steps

1. **Increment 1 — evidence.** Direct compile, cast extraction (used by comparison preparation only), the one violence sentence on the direct side, comparison kind. Ends with David's judged comparison.
2. **Increment 2 — editor, fold and cast fill.** The simplified card with draft preparation, cast chips and the cast-fed dropdown; taxonomy editor off moderation; the job, with both lists worked to empty.
3. **Increment 3 — switch.** Every surface compiles directly; the planner and the compiler code named above are removed; freshness split; refusal outcome.

The oracle lists the switch second and the editor third. The order here differs for one reason: the fold has to finish before anything stops reading the eleven fields, and the fold belongs with the editor change that stops new values being typed.

## Risks and Mitigations

- **The direct path draws worse in a case.** A failed case keeps the planned path until a remedy passes another comparison; increment 3 waits on it.
- **Cast extraction mislabels.** Its result is visible before save and tested on every gag's renders.
- **Folded text reads worse than the fields did.** Converted gags' renders read out of date and are re-approved through the ordinary flow as moderators reach them.

## Open uncertainty

- How many live gags hold values in the eleven fields; the fold's dry run measures it.
- Whether engines honour a single always-present violence line without it colouring non-violent pictures; the comparison's ordinary-fact case shows it.
- Whether GPT Image 2.6's filter refuses comedic violence at its default; the violent-fact case shows it.

## Questions for David

Existing approved gags stay offered after the switch with the examples they have: Issue #965's Q11 already decided that live gags stay offered and that each needs its three examples before launch, and this plan follows it. (Shown to David earlier as Q3; answered by that decision, so not asked.)

- **Q4: Nothing scores a drawn picture for intense gore; for members' own pictures (Phase 7) the limit would rest on the prompt rule and the engine's filter. Accept that for this work, with the question of adequate controls recorded for Phase 7's plan?**
  1. Yes.
  2. No: design a gore control now.
  Recommendation: 1. No member pictures are drawn until Phase 7.
  **Answered: 1** (David, 2026-11-17: "approved", given on an approval ask that recommended approving with Q4: 1).

## Next (taken from this plan, not in it)

- What controls on intense gore are adequate for members' pictures (a decision for Phase 7's plan).
- Dropping enrichment fields nothing reads; uses of the classification.
- Having the gag writer return the cast with each idea (needs a locked-prompt change).

## Definition of Done

David has accepted the blind comparison; a render's prompt comes from the gag's scene, bubbles and cast plus fixed wording, and no classification edit changes it; no code path calls a planner; a pending gag change stays invisible until its renders are approved; the gag card on both screens shows scene, bubbles and cast only; the taxonomy editor is on the Facts editor only; both of the job's lists are empty.
