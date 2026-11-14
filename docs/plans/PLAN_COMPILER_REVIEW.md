# Plan — Compiler review: the compiler updated for the approved gag, the two chosen engines, and photo-only pictures

Workstream: #950. Draft v4, 2026-11-14.

```plan-oracle
# Oracle — compiler review (workstream #950), scope agreed by David 2026-11-14, revised by David the same day (decision 1)

## Direction served
`docs/ai-context/product-strategy.md`, *Pictures and engines* and *Quality*: GPT Image 2.6 draws photoreal pictures, Nano Banana 2.1 draws styled ones, the site picks by the look chosen; "Whether a gag is funny is settled when the gag is approved at moderation; the engine's job is to draw that gag faithfully." Every AI picture is of a real person or thing from the user's life.

## Product intent
Every AI picture draws the approved gag as written, from a real photo, on the engine its look selects, with a prompt shaped for that engine.

## Must not change
- The approved gag (Visual Concept) reaches the engine verbatim and wins over anything AI-written.
- The admin prompt preview matches what a real render sends.
- Words meant to appear in the scene still appear; caption/overlay text is never baked in.
- Age-change gags still show one person, not two.
- Work already queued renders with the engine and wording it was queued with.
- Only a moderator can soften violence.

## Settled decisions (David, 2026-11-14)
1. The compiler is updated to work with the changes made elsewhere; this is not a comparison of an old pipeline against a new one. David, 2026-11-14, revising his earlier answer: "I think you've gone too far in the direction of 'let's test this new planner vs. the old one to see which is better' and need to stay more in the lane of 'we need to update the planner to work with the changes we've made elsewhere'. I'm trusting that the strength of the new models that we're using to update the planner will naturally lead to a better planner. That being said, we should do some UAT, but this isn't a bake off." and then: "Sorry, I used the word 'planner' but what I really meant was 'compiler'."
2. This review absorbs launch Phase 8 increment 4 (per-engine compiler adaptation and look-based routing; #887, `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`).
3. There is no future concept of a picture with no photo. David: "There will be no future concept of 'no picture'. The entire point of this site is that it's about bringing the user into the fact. Anything other than that doesn't serve the function of the software. For example images, we're going to use me, my wife, and my cat."
4. Consequence of 3, agreed: when a photo has no usable face or subject, the "Generate without face preservation" fallback goes; the person is asked for a better photo.
5. Consequence of 3, agreed: moderation test renders use three fixed photos — David, his wife, his cat — supplied by David before the paid test.

## Now
1. Update the compiler to work with the approved gag, the two chosen engines and the photo-only rule, touching the planner only where those changes require it; verify with a small UAT David judges, within his paid budget.
2. Route by look (photoreal → GPT Image 2.6, styled → Nano Banana 2.1) and shape the prompt for each engine.
3. Retire the no-photo path everywhere (the `t2i_fallback` mode, the invented-protagonist wording, the fallback gender control).
4. (Withdrawn with the comparison: nothing is removed from the pipeline without evidence, so the planner step and the compiler's defences against planner text stay as they are.)
5. The compiler takes the chosen gag explicitly — built after the storage change in #949 (up to three approved gags per fact).
6. Fix the small defects: the doubled `COMPOSITION: Composition:` label; thin-scene warnings firing on moderator gags.

## Next
Public example pictures (launch Phase 7); video.

## Never
Pictures of invented people; a third image engine.

## Ceremony tier
Full: plan, Astra review, David's approval; phased. Sensitive subsystem (visual pipeline). Includes a paid AI run.
```

## Preflight

- **Increment test.** This plan makes three things true, in three phases, each recognisable on its own: (1) a render is routed by its look to the engine the strategy names, and the compiler produces a prompt worded and shaped for that engine; (2) nothing can start a picture without a real photo; (3) the compiler is handed the selected gag's complete render input. The bound is the oracle's Now list; public example pictures, the gag picker and video are outside it. It is an update of the compiler inside the existing planner-then-compiler pipeline, not a comparison of pipelines (oracle decision 1); the planner is touched only where the compiler's changes require it.
- **Affected-surface inventory.** The class "no-photo generation" is mechanical: `git grep -n -e t2i_fallback -e generic_t2i -e fallbackSubjectGender -e proceed_t2i_fallback -e '"t2i"' -- ':!*.test.*' ':!**/__tests__/**' ':!docs' ':!**/fixtures/**'`, run 2026-11-14 at `1e00bd2`. It hits the shared schemas (`lib/api-zod/src/imagePromptGeneration.ts`, `renderScenarios.ts`, `promptRecipes.ts`, `engineComparison.ts`), the attempt and comparison schemas, every engine definition's `imageMode`, routing, scenario policy, the planner prompt and generator, the compiler, `promptBudget.ts`, `resolveRenderReviewInput.ts`, `styleResolution.ts`, the worker's legacy mirror, two admin routes, source-image analysis, the comparison layout and judging, five admin screens, the acceptance driver and legacy-fixture shapes, and 13 AI recordings (104 hits). Outside it: 299 hits in tests and fixtures, 13 in docs. No Postgres enum or CHECK constrains the stored values; they are plain varchars. Phase 2's scope is drawn from this list and its build re-runs the search. **That search does not find every producer, and round 2 proved it:** an older generator outside the planner and compiler makes no-photo pictures without using any of these names (`aiMemePipeline.ts:275`, reached from `POST /admin/facts/backfill-ai-memes`, `routes/admin.ts:2179`, the `fact_ai_meme_backfill` worker and `scripts/backfill-ai-memes.ts`). So the class is "anything that submits an image generation without a reference photo", and its oracle at build time is every caller of the vendor image-submission functions, read one by one, beside the name search.
- **The class "who chooses the engine for a new attempt"** is one function, `buildAndEnqueueImagePromptAttempt` (`imagePromptAttempts.ts:117-165`), with two callers (`reviewRenderScenarios.ts:295`, `routes/reviews.ts:1618`); the comparison tool calls the vendor directly per cell (`comparison/runs.ts:498-560`); the admin preview reads `currentImageEngineIds()` (`adminImagePrompt.ts:186`).

## Problem

The gag generator and the engine catalogue were rebuilt; the prompt compiler was not. Today:

- Routing is by photo/no-photo only: `IMAGE_ENGINE_IDS = { t2i: "nano-banana-2", i2i: "nano-banana-2-edit" }` (`imageEngineRouting.ts:33-36`). The look never reaches the choice, and the one compiler (`imagePrompt/compilers/nanoBanana2.ts`) words and shapes every prompt for Nano Banana 2.
- The planner's brief still describes three modes, one of them an invented protagonist with a chosen gender (`imagePromptConfig.ts:54-93`). The strategy forbids that picture.
- A legacy generator still invents gendered scenes from a fact's text and draws them on FLUX with no photo, from an admin action and a script (`aiMemePipeline.ts:275`).
- The compiler (and the planner before it) reads the fact's single gag from `enrichment.visualPromptStrategyOverride`; #949 gives a fact up to three.
- Real output carries `COMPOSITION: Composition: …`, and thin-scene warnings fire on moderator gags.

## Direction

`docs/ai-context/product-strategy.md`, *Pictures and engines* and *Quality*. This plan makes the last unreviewed stage of the AI pipeline fit the pipeline that now exists.

## Product Intent

Every AI picture draws the approved gag as written, from a real photo, on the engine its look selects, with a prompt shaped for that engine.

## Must Not Change

As the oracle lists: the gag verbatim and authoritative; preview equals runtime; in-scene words appear and caption text is never baked in; an age-change gag shows one person; queued work renders with the engine and wording it was queued with; only a moderator softens violence. Also unchanged: the planner-then-compiler split and the compiler's ownership of identity, reference, binding and policy language; stored history stays readable (every old attempt, comparison and recipe version still opens and says what drew it); pets and objects remain valid subjects.

## Settled Decisions

Oracle decisions 1–5, plus these technical choices of ours:

- **S6. No comparison of pipelines, and nothing removed without evidence.** David asked for an update of the compiler, not a bake-off (oracle decision 1). It follows, as our consequence and not his ruling, that the planner step keeps its model and its role, and the compiler's defences against planner text stay. The Phase 8 plan's "planner/compiler split kept" line stands. The planner's brief changes only where the compiler's changes force it: the no-photo mode goes, and nothing in it names one engine.
- **S7. One compiler, engine-aware; no copy.** Token rendering, moderator authority, identity binding, text policy and violence policy stay in one place. What differs per engine family is wording (the existing recipe store) and shape (below). No second wording store.
- **S8. Transition by a quiet window, not a replay framework.** The only producers of render work today are admin actions (inventory above); no member route exists (`meme-and-video-studio.md:170-177`). Before syncing code that changes planning, compilation, baseline wording or supported modes, new render admissions are paused, the old workers finish the whole chain, and the sync happens only once it is quiescent. See *Runtime Behavior*.
- **S9. The test faces are already David and his wife**, kept on purpose and cleared for any testing (`decisions.md`, 2026-10-17, *The default reference faces are David's and his wife's*). They are reused; the files' "Pending: licensed/synthetic" notes are stale and are corrected. The cat photo is supplied by David and stored beside them.
- **S10. Judging AI pictures is David's** (`decisions.md`, 2026-10-17, *AI-generated images are checked by David*). The UAT pictures are his to judge.
- **S11. The moderation approval gate is unchanged.** Test renders drawn by a superseded engine read out of date as today, and a recorded waiver still lets a fact through (`routes/reviews.ts:478`). Hardening that gate belongs to public example pictures (Next).
- **S12. The UAT is the strategy's small check**, not a judging round: "a small check (a second face, screen size, the three styles) replaces a third judging round" (`product-strategy.md`, *Pictures and engines*).

## Repo Context Inspected

`compilers/nanoBanana2.ts` (whole), `compilers/failureModeConstraints.ts`, `imagePrompt/recipe.ts`, `recipeStore.ts`, `generator.ts` (override handling), `imagePromptConfig.ts`, `imagePromptAttempts.ts`, `imagePromptJobs.ts`, `imageEngineRouting.ts`, `engines/*`, `styleResolution.ts`, `comparison/{sets,layout,runs,admission,judging}.ts`, `lib/api-zod/src/{renderScenarios,engineComparison,imagePromptGeneration,visualStrategyOverride}.ts`, `reviewRenderScenarios.ts`, `factRenderScenarios.ts`, `defaultReferenceResolver.ts`, `sourceImageAnalysis/*`, `__tests__/fixtures/compilerBaseline.json`; docs `visual-pipeline.md`, `product-strategy.md`, `PLAN_PHASE8_ENGINE_EVALUATION.md`, `PLAN_GAG_GENERATOR.md`, `uat-doc-format.md` *Lanes*; issues #887, #935, #949.

## Current Behavior

- **Queue time** freezes on the attempt: engine id, recipe version, modes, render controls, the source-photo analysis, the rendered fact text and the whole enrichment snapshot, which carries the moderator override (`imagePromptAttempts.ts:117-165`). **Worker time** calls the planner, loads the recipe (`recipeById(null)` is the code baseline, `recipeStore.ts:30`), compiles and renders (`imagePromptJobs.ts:102-235`). The style is resolved live at worker time; `freezeRenderStyleSnapshot` has no caller outside tests.
- **The planner** (`gpt-5.5`, high reasoning effort) receives the gag and bubbles as authoritative text; the other override fields reach only the compiler. It is deliberately not told the look (`generator.ts:644`). Five of its outputs drive compiler decisions rather than prose: the age transform, the selected frame (failure-mode lines), supporting-text elements, caption negative space, secondary characters.
- **The comparison tool's** layout demands a text-only and an edit engine per family (`layout.ts:57-94`).
- **Moderation** requires three scenarios, one of them `generic_t2i`; default reference photos are files in the repository (`defaultReferenceResolver.ts:48-77`); the male and female ones are David and his wife (S9). One admin action, `POST /admin/reviews/:id/render`, accepts only no-photo rendering (`routes/reviews.ts:1524`), and the female scenario's sample name and pronouns are selected by the no-photo gender control (`reviewRenderScenarios.ts:67`).

## Source-of-Truth Analysis

| Concept | Source of truth | This plan |
| --- | --- | --- |
| The scene | The approved gag (moderator's Visual Concept and its scene controls) | Unchanged; Phase 3 makes "which gag" an explicit input |
| Which engine draws | The attempt's recorded engine; for a new attempt, code | New attempts: the look's class decides, in code. History unchanged |
| Global wording | Recipe store, per engine family; code baseline when none is live | Unchanged store; a baseline per family; shape becomes part of a recipe |
| The planner's brief and engine | Code (`codeOwnedPrompts.ts`, `engines/openai-visual-planner.ts`) | Unchanged home; the brief is edited |
| What the engine was sent | The attempt's stored compiled prompt | Unchanged; never recomputed as truth |
| The fixed test photos | Files in the repository (S9) | Unchanged; the cat's photo is added |

No new store of wording, engines or gags is created.

## Proposed Design

### Phase 1 — Two engines: route by look, word and shape the prompt per engine

**What it makes true:** a new render with no look goes to GPT Image 2.6 and one with a look goes to Nano Banana 2.1; each compiles with its own family's wording and shape.

- **Routing.** The engine for a new attempt is resolved from the validated look once, at queue time, before anything else, and the look's resolved text is frozen on the attempt with it (the existing unused snapshot path). An invalid look is refused, never defaulted. Preview, moderation renders and the worker read the same resolution. The moderation freshness hash keys on the engine the scenario's look class would use now.
- **Compiler.** It becomes engine-aware through the recipe it is already handed: each family gets a code baseline, and how sections are joined and labelled becomes part of a recipe, so the prompt tuner can adjust shape later without new machinery. Nano Banana 2's baseline stays byte-identical. Each new family's starting wording and shape follow that vendor's published prompting guidance, read at build time and cited in the PR; section order stays fixed.
- **Planner, minimally.** Any wording in its brief that names Nano Banana 2 is made engine-neutral. Its model, its role and its inputs are otherwise unchanged, and it still is not told the look.
- **Small defects.** The doubled composition label; density and tone warnings no longer judge planner fields the gag makes irrelevant.

### Phase 2 — No picture without a photo

**What it makes true:** no route, screen, scenario, comparison, planner brief or analysis result can start or describe a picture without a usable reference photo; history still reads.

- **Two existing uses are replaced before the mode goes, not merely refused.** The admin render action that today accepts only no-photo rendering becomes a photo-backed render from the fixed reference selection and the chosen look (or is folded into the scenario action that already does that), so the workflow keeps working. The sample name and pronouns for each fixed photo move to the reference identity itself, so the wife's renders never acquire David's name and pronouns when the gender control is deleted.
- New attempts in the no-photo mode are refused at queue time and by the worker. Source analysis reports "this photo cannot be used" with its reason where it used to suggest no-photo; the unused "Generate without face preservation" choice is deleted. Admin preview and moderation controls lose the option and the gender control.
- The planner's brief and its output contract lose the no-photo mode and the fallback gender; the compiler's no-photo entry point and its wording pieces are retired; a stored recipe version that still carries them loads without error. The comparison layout accepts a family with only an edit engine.
- Moderation's required scenarios become David and his wife; the cat stays conditional as the animal scenario is today; the object scenario stays optional. `generic_t2i` stops being offered or required and its old renders stay viewable.
- Stored values are not migrated: old attempts, panels and sets keep their strings and their readers keep the labels.
- **The legacy background generator is retired**: its admin action and route, the script's admission and the generation path. Stored images and readable history are preserved. Its queue, `fact_ai_meme_backfill`, is part of the quiet window; queued work finishes under the old implementation before its handler is removed. Neither the former screen action, the route nor the script can start new generation.

### The UAT — after Phase 2

**The strategy's small check (S12), judged by David, on the pipeline as it will run.** Four approved gags: an age change (David), one with a secondary character (his wife, the second face), one with in-scene words or a bubble (David), one starring the cat. Each is drawn once photoreal on GPT Image 2.6 and once in a look on Nano Banana 2.1, the four styled pictures covering the three styles, at screen size: eight pictures, named gag by gag in the pre-run statement. David judges each on one question, whether it draws the gag, with likeness and style noted. A picture that fails is a fix on a fresh branch, by wording or shape first.

- **Cost, by the repository's reservation figures and with no shared preparation** (the worker plans per attempt, `imagePromptJobs.ts:147`): each picture reserves two planner calls ($0.768) plus its image ($0.12868 on GPT Image 2.6, about $0.32779 on Nano Banana 2.1). Two batches through the ordinary moderation render path: the four GPT pictures at about $3.59, then the four Nano Banana pictures at about $4.38, each inside the $5 per-run budget, about $7.97 in all, likely under $2. A failed picture gets at most one retry, priced before it runs. The vendor's bill and the week's total are read before each batch. GPT Image 2.6's reasoning figure is an allowance, not a vendor ceiling: Question 1.
- **Phase 3 gets a targeted recheck**, not a second sample: one fact with two gags, one picture of each, priced the same way before it runs.

### Phase 3 — The selected gag is the compiler's input (after #949's storage change)

**What it makes true:** the compiler, the preview, the moderation render and the comparison tool all receive one selected gag's complete render input — scene, bubbles, role bindings, required and forbidden details, composition guidance, subject realization, text-policy override — and never read "the fact's gag" for themselves. The attempt freezes it. Gag two can never inherit gag one's bubbles. The planner is passed the selected gag's scene and bubbles where it reads the fact's today, and nothing more. The concrete type follows #949's stored shape and is finalised when that lands; if #949's shape cannot express a gag's complete input, that returns to David as an amendment.

## Data Model and Migration Impact

No schema change in Phases 1 and 2: the frozen look snapshot uses an existing field, and stored mode values are left as they are. Phase 3's storage is #949's. Nothing is backfilled or rewritten, so there are no partial or failed row states.

## Runtime Behavior

- **Queued work across each release (S8).** Before syncing code that changes planning, compilation, baseline wording or supported modes, a controlled window admits no new renders. The old workers finish everything pending and processing, including delayed retries, review-render preparation (which creates attempts later), prompt generation (which enqueues image generation), image generation, comparison preparation and comparison rendering. The sync happens only once that whole chain is quiescent; otherwise the old implementation keeps running. Admissions resume after the deployment check. This is an operating procedure for today's admin-only system, and the property is stated as checked, not as impossible. A worker meeting a job shape it no longer supports fails it terminally with a readable reason; that is an operational fault to investigate, not the way queued work is preserved.
- **A look deleted or edited between queue and render** no longer changes a queued render: the look text is frozen at queue time.
- **Planner failure** behaves as today.

## Admin/User UX Impact

- An attempt shows the engine its look selected. Moderation shows two required test renders (David, wife) and the conditional cat; a fact whose old renders were drawn by the old engine reads out of date, and the recorded waiver works as today (S11).
- Admin photo analysis says a photo cannot be used and why. The admin render action and preview offer photo-backed rendering only. No member-facing screen changes: none exists for AI pictures today.

## Security, Permissions, and Validation

All touched routes stay `requireAdmin`. Engine and look are validated server-side at queue time and again by the worker.

## Testing Plan

- **Phase 1:** routing — every look class maps to its engine, an invalid look is refused, preview and worker agree for the same inputs; Nano Banana 2's baseline corpus still reproduces byte for byte; each new family's baseline compiles every corpus input within the prompt budget with all required sections present; a queued attempt keeps its engine, wording and look text across a routing change, a promotion and a look edit. Preview parity is shown by passing the same resolved inputs and the same planner result through both assembly paths; two independent planner calls may differ by sampling, and the test must not introduce reuse of a preview's plan as new behaviour.
- **Transition:** the quiet-window procedure is exercised with a preparation job that creates a later attempt, a baseline-wording attempt and a job mid-execution; each completes under the old contract before replacement.
- **Phase 2:** the inventory's search, re-run, shows no producer of a no-photo attempt; queue-time and worker refusals; the replaced admin render action produces a photo-backed attempt; the retired background generator's action, route and script start nothing; the wife's scenario renders with her name and pronouns; a stored recipe with retired pieces loads; legacy-fixture rows in the old mode still render their admin views.
- **Phase 3:** two gags on one fact compile to prompts sharing no gag-owned text; planner, preview, moderation and comparison receive the same selection.
- **Recordings.** Each phase refreshes the recorded AI responses its request changes invalidate (the planner's and the downstream image calls', which are keyed on endpoint and full input) before its replay checks are claimed as passing; the affected calls are priced through the recording runner, unaffected recordings are reused, and the refresh is batched inside the per-run budget. Exact counts are settled at build time.
- **Paid:** the recording refreshes; the UAT's eight pictures; Phase 3's two-picture recheck.
- **UAT (judgement only):** David's eight pictures after Phase 2.
- Runners per `docs/tests/TESTING.md`.

## Implementation Steps

1. Phase 1: routing by look with the frozen look; per-family baselines and shape in recipes; engine-neutral planner wording; defects; recordings.
2. Phase 2: replace the two no-photo-only uses; retire the mode and the legacy generator across the inventory; scenario change; the cat photo in place; recordings.
3. The UAT, in two batches; fixes if any.
4. Phase 3: the selected gag as the compiler's input, after #949; the two-picture recheck.

Phases 1 and 2 and the UAT do not depend on #949. Phase 2 starts as soon as Phase 1 merges.

## Risks and Mitigations

- **GPT Image 2.6 may respond poorly to the starting shape.** The UAT shows it; shape and wording are recipe changes, and the prompt tuner already exists to adjust them.
- **Whether the planner's additions drift from an approved gag is not measured** (oracle decision 1 chose an update over a comparison). The UAT's one question is exactly that fidelity, on eight pictures.
- **The UAT's cost is estimated, not capped**, on GPT Image 2.6. Two batches, GPT first, the bill read between them.
- **Routing change makes existing moderation renders read out of date.** Existing rule and existing waiver (S11).
- **#949 lands a shape that differs from what Phase 3 assumes.** Phase 3 is specified by its invariant, not a type.

## Questions for David

1. **Accept an estimated, not capped, cost for the four GPT Image 2.6 UAT pictures?** Their batch is reserved at about $3.59, but the vendor publishes no ceiling on that engine's reasoning charge, so the figure is an estimate. Option 1: accept it, with the bill checked before the second batch. Option 2: defer the GPT pictures until a firm bound exists, which leaves the photoreal engine untested by you. Recommendation (Astra's and mine): option 1.

Needed from David, not a question: one photo of the cat, before the UAT.

## Definition of Done

- Phase 1: a no-look render is drawn by GPT Image 2.6 and a looked one by Nano Banana 2.1, visible on the attempt; preview equals what was sent.
- Phase 2: no screen, route, script or planner brief offers or describes a picture without a photo; neither the name search nor the read of every image-submission caller finds a producer; old no-photo records and stored images open.
- The UAT: David has judged the eight pictures and any failure has its fix.
- Phase 3: a fact with two gags renders each with only its own content.
- Every oracle must-not-change item has a passing automated check, and the intended behaviour can be exercised in the admin product.
