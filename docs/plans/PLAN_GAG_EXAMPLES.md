# Plan — gag examples per subject kind, and people-and-pets subjects

```plan-oracle
Direction served
docs/ai-context/product-strategy.md (approved 2026-11-11): "Every AI picture is of a real person or thing from the user's life ... No pictures of generic people are sold or offered as meme backgrounds." and "Examples are stored per gag and per look ... Only one unstyled example per approved gag is required." Plan docs/plans/PLAN_THREE_GAGS.md (approved 2026-11-14): a gag is approved when a moderator approves one of its test renders, which becomes its example. This plan amends both: a gag's examples are one per subject kind (male, female, pet), and subjects are people and pets only (David, 2026-11-15).

Product intent (this plan)
Increment 1, Test Renders per gag (Issue #965): a moderator iterates on a gag cheaply and commits to the full set only once the gag works. Saving a gag, or approving the Gags step, draws one male render of each changed gag and nothing else. Once the moderator is happy, one action draws that gag's female and pet renders; any single render can also be drawn. Each gag carries three approved examples, male, female and pet, each approved from that gag's own renders; a gag is offered to users only when all three are approved. Approve for Production requires every gag that will be offered to have its three approved examples. The fact-level render grid, its scenario checkboxes, the render waiver, the Generic (text-to-image) render, the object/vehicle render and the "How the AI read this fact" panel leave the Test Renders step; the Final hashtags editor keeps a home on that step; the warning beside Approve the Gags names the gag with unsaved edits. The Facts editor (a live fact's gags) and a refresh review follow the same flow; a refresh's picks apply at promotion.
Increment 2, people and pets only (Issue #964): a meme's subject is a person or a pet everywhere in the product. The AI prompts (gag writer, planner, photo classifier, compiler identity line) stop offering cars, vehicles and objects as subjects; photo classification stops returning them as subjects; the admin evaluation and preview tools drop them; records already stored with them stay readable as history. The product strategy, decisions and the Manual record the decision.

Must not change
- What any live fact renders for users today.
- No paid render fires without a moderator's action; no catalogue-wide re-render.
- A live fact always has at least one approved gag, enforced by the database as well as the code.
- The refresh cycle never touches what users get until promoted.
- The moderator-authored scene stays authoritative and verbatim at render time; one source of truth per gag.
- Blind moderation, the legal-safety rules, the humor note, the gag writer's locked prompt (except the vehicle/object wording increment 2 removes, as a new locked version).

Settled decisions
1. Q8 (David, 2026-11-15): every gag needs all three examples (male, female, pet) before it is offered. "Once the gag works, rendering the additional images is trivial."
2. Q9 (David, 2026-11-15): subjects are people and pets only, product-wide, pre-launch. "This is a core product direction and needs to be done pre-launch." It supersedes "themselves, a friend, a pet, a car" in product-strategy.md.
3. Q10 (David, 2026-11-15): "An approved fact should have three renders (male, female, pet) for each gag. The waste I'm removing is rendering them all every time I make a change to the gag. Once the gag works, we do the final render of the additional types." The gate is per gag; the fact-level grid that rendered every scenario on every change goes.
4. Q11 (David, 2026-11-15): gags already on live facts, which have no examples, stay offered as they are (keeps 2026-11-14 Q3 "Stay live"); giving each its three examples is a launch-readiness item.
5. Q12 (David, 2026-11-15): in Phase 7, a photo with neither a person nor a pet is refused: "Pick a photo of a person or a pet." Recorded here; built in Phase 7.
6. The Generic (text-to-image) render goes (David, 2026-11-15: "We decided we're not doing those anymore"; Issue #963, absorbed).
7. "How the AI read this fact" leaves Test Renders (David, 2026-11-15: "not useful here").
8. Scope approved by David 2026-11-15 ("Q11 1. Q12 1. Approved"): one plan, two increments, Test Renders per gag first.

Next (not in this plan)
Phase 7's photo upload refusal (Q12) and the picker; styled examples per look; giving every carried-over live gag its three examples (launch readiness).

Never
A catalogue-wide re-render; examples as meme backgrounds; a fourth gag.
```

## Problem

The Test Renders step was built for one fact-level grid. Approving the Gags step clears the review's renders and draws the generic, male and female scenarios (plus the non-human one when forced) for the gate gag, and Approve for Production reads that grid. A gag has one example, from any scenario. So:

- every change to a gag costs a full set of paid renders before the moderator knows whether the gag works;
- an example says nothing about how the gag looks for a woman or a pet;
- the screen carries a generic text-to-image render the strategy retired, a car render for a product that, from now on, has no car subjects, and an AI-read panel the moderator does not use there.

Separately, cars, vehicles and objects run through the AI prompts, photo classification and the admin tools as subjects, which David has now ruled out product-wide.

## Direction

Amends `PLAN_THREE_GAGS.md` (approved 2026-11-14) and `product-strategy.md` (approved 2026-11-11), as the oracle states. Increment 1 makes a gag's examples one per subject kind and the moderator's render spend proportional to iteration. Increment 2 makes the product's notion of a subject people and pets only.

## Product Intent, Must Not Change, Settled Decisions

As in the `plan-oracle` block above, verbatim.

## Vocabulary

- **Subject kind:** male, female or pet. Each is drawn from one committed reference photo (`artifacts/api-server/src/assets/render-references/`: `male.jpg`, `female.jpg`, `nonhuman-animal.jpg`).
- **Example:** a moderator-approved test render of a gag, for one subject kind.
- **Complete set:** a gag's three examples (male, female, pet), all rendered from the gag's current content.
- **Iteration render:** the one male render drawn when a gag changes.

## Repo Context Inspected

At `a15be27`:
- Scenarios and their policy: `lib/api-zod/src/renderScenarios.ts`; `artifacts/api-server/src/lib/factRenderScenarios.ts`; `artifacts/api-server/src/lib/reviewRenderScenarios.ts`.
- The routes that use them: `routes/reviews.ts` (approve-visual-concept clears the review's renders and force-enqueues the default batch; `resolveVisualRenderGate` and the waiver; render-scenarios routes); `routes/gags.ts`.
- The gag store: `lib/gags/gagStore.ts` (`approveGagRender`, `applyReviewGagOps`, `cancelReviewGagOps`, `refreshLeavesApprovedGag`) and `lib/gags/resolver.ts` (`availableGags`, `resolveOfferedGag`).
- `lib/db/src/schema/factGags.ts` and migration `0139_fact_gags.sql` (checks `fact_gags_approved_has_example`, `fact_gags_pending_ops_owned`, `fact_gags_pending_example_has_content`; triggers `facts_live_requires_approved_gag`, `fact_gags_live_fact_keeps_approved_gag`).
- Frontend: `components/admin/FactVisualReviewGrid.tsx` (AI-read panel, Final hashtags editor, run checkboxes, grid), `components/admin/gags/GagsPanel.tsx`, `pages/admin/moderation.tsx` (step 3, `canApproveProduction`, the waiver UI).
- Subject surfaces, swept for increment 2 (survey result on Issue #964): the zod enums in `imagePromptGeneration.ts`, `engineComparison.ts`; photo classification (`sourceImageAnalysis/*`, `fal-yolo-world.ts`); prompts (`visualConceptsConfig.ts` and `docs/plans/gag-prompt-LOCKED.md`, `imagePromptConfig.ts`, `imagePrompt/generator.ts`, `imagePrompt/recipe.ts`, `visualPromptStrategies.ts`); admin UI (`EvaluationWizard.tsx`, `FactRenderScenarioTile.tsx`, `PromptRecipes.tsx`, `RuntimePromptPreview.tsx`); docs (`product-strategy.md`, `visual-pipeline.md`, `glossary.md`, `docs/manual/5-visual-pipeline.md`).
- Context docs: `visual-pipeline.md`, `moderation-workflow.md`, `decisions.md` (2026-11-14 and 2026-11-15 entries).

## Current Behavior

- **Approving the Gags step** clears the review's render attempts and force-enqueues a default batch per gag that has a pending change, plus the gate gag. The batch covers generic, male and female, and the non-human scenario when forced.
- **Approve for Production** reads the gate gag's fact-level grid. Missing required scenarios return `visual_render_incomplete`; the moderator can waive them, and the waiver is stored on the review.
- **A gag's example** is one render of any scenario, stored as `approved_example_attempt_id` (or `pending_example_attempt_id` inside a refresh). Approving it also sets `approved_content` (outside a refresh), which is what makes the gag offered (`availableGags`).
- **Carried-over gags** (migrated by 0139) have `approved_content` and no example.

## Source-of-Truth Analysis

- **A gag's content:** `fact_gags.approved_content` / `pending_content`. Unchanged.
- **A gag's examples:** today two columns on `fact_gags`; after increment 1, one table (below). The two columns stay this release only as unread recovery snapshots and are dropped later, so there is never a second live store of examples.
- **Which renders exist:** `image_prompt_attempts`, bound to a gag by `gag_id` and to a subject kind by `review_render_scenario_key`. Unchanged.
- **Whether a gag is offered:** one predicate, in one place (the resolver), used by `availableGags`, the Gags panel's state words and the production gate.
- **Subject kinds:** one enum in `lib/api-zod`, read by the server and the screens.

## Proposed Design

### A. Examples, one per subject kind (increment 1)

- **Storage.** A table `fact_gag_examples` (gag, subject kind, render attempt, stage). Stage is *approved* (part of what users get) or *pending* (picked for the gag's pending content). Rules:
  - a gag has at most one example per subject kind per stage;
  - a pending example exists only beside pending content;
  - an example is a finished, unstyled render of that gag, of the matching subject kind, drawn from the content it stands for.

  The two example columns on `fact_gags` are copied into it and stop being read or written; they are dropped in a later release (*Data Model*).
- **The database enforces the set.** Deferred constraint triggers on `fact_gags` and `fact_gag_examples` refuse a commit that leaves approved content without a complete approved set or the grandfathered flag, using the same fact-first locking order as the live-fact triggers. Replacing a set inside one transaction is allowed; deleting or moving an approved example, or clearing the grandfathered flag early, is refused. (A row-level CHECK cannot count rows in another table, so the existing `fact_gags_approved_has_example` check is replaced by these triggers.)
- **Approving a render.** "Approve this render" on a gag's male, female or pet tile records it as that gag's example for that kind, against the content it was drawn from (today's `CONTENT_CHANGED` refusal stays). A render of any other scenario is refused.
- **When the set completes, the change applies** (outside a refresh). A gag's change reaches users only once its three examples are approved for the new content (Q8). At that moment the pending content becomes approved, and its three examples become the approved set, in one transaction. Until then the approved version and its examples, if any, stay offered. A new gag, with no approved version, is not offered until its set completes.
- **Inside a refresh,** the three picks stay pending and apply at promotion, as today's single pick does; declining cancels them.
- **Offered** (one predicate): not removed, has approved content, and either a complete approved set or the grandfathered state (B).
- **Discard, removal, decline and promotion** treat a gag's pending examples as one set: they all go or all apply together.
- **An approved example stays approved when engine or prompt settings change later** (2026-11-14 settled decision 6). Only a change to the gag's own content clears its pending picks.

### B. Gags that predate the set (Q11)

A gag approved before this change keeps its approved status and stays offered with fewer than three examples. That is every carried-over gag, and any gag approved with one example under increment 1. The database records it as grandfathered (a new flag, `approved_before_example_sets`, set from the existing `approved_carried_over` and from the cases the migration cannot map), and the moderation screen shows "Approved before examples were per subject: needs male, female and pet examples."

The state ends for a gag the first time it completes a set. A grandfathered gag that gets a change follows the normal rule: the change applies when its set completes. Giving every grandfathered gag its set is a launch-readiness item, recorded in `launch-definition.md`.

### C. Renders: one male render while iterating (increment 1)

- **Saving a gag** draws one male render of the saved content, once per content. A render already drawn for that content is reused, never redrawn. "Saving" covers every way a gag's content changes: an edit, an idea used as a gag, a discarded change, a new gag. All of them go through one scheduling path, which the Gags approval also uses.
- **A failed render or enqueue** shows on its tile and can be retried; it never reads as the save failing.
- **Approving the Gags step** keeps every existing render and requests a male iteration render only for each surviving new or changed gag that lacks one for its saved content. An unchanged approved gag, including a grandfathered gag with no examples, gets no render just because the moderator moves on; its renders are requested explicitly. Going back through Gags without an edit draws nothing.
- **"Once per content" is a content identity, not the full input hash.** A render is reused when it was drawn from the same saved gag content for the same subject kind; the full input hash (engine, recipe, settings) stays on the attempt as provenance and does not redefine reuse. The tile shows exactly the attempt the scheduler reused or drew for the gag's current content, so a discard back to earlier content shows that content's render, approvable. Renders of other content stay as history.
- **"Render female and pet"** on a gag draws the two missing renders for its current content. Each tile can also redraw a single render on request.
- **The Generic (text-to-image) and object/vehicle scenarios leave moderation.** Their stored renders stay as history and are no longer listed. The pet scenario no longer depends on whether the fact mentions an animal: it always draws from the pet reference.
- **Every render is a moderator action.** The only automatic render is the male iteration render, which a save or the Gags step approval triggers.

### D. The production gate (increment 1)

Approve for Production (first-time and refresh) requires every gag that will be offered after approval to have a complete set for the content it will carry, or to be grandfathered (B). "Will be offered after approval" is computed on the state the approval produces: a refresh's removals and replacements included. An optional gag whose set is incomplete stays hidden rather than blocking, as long as the fact still has an offered gag. The fact-level grid, `resolveVisualRenderGate`, the render waiver and its stored column go. A refused approval names each gag and the kinds it lacks.

### E. The Test Renders step (increment 1)

- **Leaves:** the fact-level grid, the run checkboxes, the tally, "How the AI read this fact" and the waiver panel.
- **Stays:** the Final hashtags editor keeps its place on the step, as a section of its own.
- **Each gag card shows:** its male iteration render; the "Render female and pet" action; the three tiles, each with "Approve this render"; and the examples approved so far, in words ("Male approved; female and pet to approve").
- **The Gags step's Approve warning** names the gag with unsaved edits.
- **The Facts editor's gags panel** follows the same flow for a live fact outside a review: a change applies when its set completes.

### F. People and pets only (increment 2)

The sweep is about the **personalised subject** only. Animals, vehicles and objects appearing as props or supporting characters in a gag stay legitimate content, so authored scenes, taxonomy and the rest of the locked gag prompt are not rewritten.

Two kinds of value are separated throughout: values **accepted for new writes** (classification, planning, render requests) lose the vehicle, object and mascot subject kinds; values **read from history** (old analyses, attempts, evaluations) keep parsing.

- **The subject enum** loses its object, vehicle and mascot values for new writes. A stored record holding one stays readable, through a legacy reader that maps it to "unknown (retired kind)".
- **The non-human render mode** keeps its stored name, `nonhuman_subject_i2i`, so old rows parse, and is documented as pets only.
- **The prompts** lose their vehicle and object wording:
  - the gag writer's locked prompt, as a new locked version with its sha pin;
  - the planner and classifier prompts, the compiler identity line (`identity.object`) and the non-human strategy text, each with a prompt version bump.

  The test doubles that carry these prompts are re-recorded, a paid run within the paid-run budget.
- **Photo classification** stops returning vehicle, object or mascot subjects, including the fallback that files any unmatched detector label as an object. Its cache is versioned, so a cached analysis from the old policy is never reused for a new request.
- **Stored prompt recipes** (`recipeFrom` overlays a promoted recipe on code defaults): a promoted recipe whose identity wording still names "a pet or an object" would keep that wording after the baseline changes. Increment 2 promotes a new version of each such live recipe, with only that wording changed, and leaves the history intact.
- **A photo whose only subject is a vehicle or object** is classified as having no usable subject (Q12's refusal reads that in Phase 7). The detector's label list keeps those labels only to recognise and reject them.
- **Admin tools** drop the Vehicle evaluation photo type, the object/vehicle chips and the preview options.
- **Docs** record the decision.

## Data Model and Migration Impact

- **Migration (increment 1)** creates `fact_gag_examples`.
- **It moves each existing example into the table:**
  - `approved_example_attempt_id` becomes an *approved* example, under the subject kind of its attempt's scenario;
  - `pending_example_attempt_id` becomes a *pending* example, the same way.
- **An example from a scenario that is no longer a kind** (generic, object/vehicle) is not moved. Its gag is marked grandfathered, so it stays offered. The migration's NOTICE counts the moves and the dropped examples.
- **Additive in this release, because of the publish order.** Replit applies its own schema diff to production before the app's migration runner (`docs/engineering/migrations-and-backfills.md`, *Replit's publish changes production's schema before the runner does*), and that diff copies structure, not rows. Dropping the example columns in the same release could lose them before the copy reads them. So this release:
  - creates the table and copies the selections, leaving `approved_example_attempt_id`, `pending_example_attempt_id` and `visual_render_approval_waiver` in place, unread and unwritten;
  - adds the grandfathered flag (`approved_before_example_sets`) beside `approved_carried_over` rather than renaming it, set from it and from the dropped-kind cases below;
  - replaces `fact_gags_approved_has_example` with the deferred triggers;
  - treats the retained columns as recovery snapshots only: the check `fact_gags_pending_example_has_content` is removed, and `fact_gags_pending_ops_owned` is rewritten to protect pending removals without consulting the old example column, so a migrated refresh can still be discarded, declined or promoted. Every example rule follows the new table. The reverse migration restores the retired checks.

  Dropping the old columns is a later cleanup PR, after every target database has migrated (taken as *next*).
- **The live-fact triggers are unchanged:** a live fact needs an approved gag, which grandfathered and complete gags both are.
- **Row-state matrix:**

  | Row state | Outcome |
  |---|---|
  | Approved with an approved example | moved to its kind |
  | Approved with none | carried over; grandfathered |
  | Pending with a pending example | moved to its kind as pending |
  | Removed gag | its examples move with it, as history |
  | Generic or object example | dropped, gag grandfathered |
  | Second run | no-op (idempotent; the table is keyed by gag, kind and stage) |
  | Arrival order | correct whether the runner or Replit's schema diff reaches the database first: the copy reads columns that this release never drops |

- **The reverse migration** drops the table, the triggers and the new flag and restores the old check. The original columns were never touched, so it is exact for any database reversed before new-model edits; after a moderator has approved examples under the new model, the recovery is fix-forward, not reverse.
- **Increment 2 needs no migration.** Stored subject values stay as history, read through the legacy reader.

## Runtime Behavior and Edge Cases

- **Two moderators completing a set at once.** Completion takes the gag row's lock, so the change applies once.
- **A change saved after examples were picked** clears the pending examples for the old content: they no longer show the gag.
- **Removing a gag** removes its examples with it. Today's guard against removing the last approved gag of a live fact stays.
- **A pet render of a gag about a human-only trait** (a beard) is still required (Q8). The moderator judges its example like any other.
- **A failed or missing reference photo** fails that render as today (`reference_asset_unavailable`). The set cannot complete until it renders.

## Security, Permissions and Validation

- **Every route stays `requireAdmin`.**
- **Render requests take the subject kind from the enum**, never free text.
- **Approving a render checks every rule in A on the server.** The screen only reflects them.
- **No new paid path:** every render is one a moderator triggers. The paid-run budget governs only increment 2's re-recordings.

## Testing Plan

**Increment 1:**
1. **Examples.** Each kind is approved only from that kind's finished, unstyled render of the gag's current content. The other scenarios, other gags' renders, styled, unfinished and stale renders are refused.
2. **Completing a set.** The third example applies the change and the set atomically. Two concurrent completions apply once. A new gag is offered only with a set.
3. **Grandfathering.** A grandfathered gag stays offered. A change to it applies only when its set completes. Its marker ends then.
4. **Refresh.** Picks stay pending and apply at promotion; a decline cancels them.
5. **Renders, counted per action.** A save (edit, idea, discard, new gag) draws one male render, reused for unchanged content; a failed one is visible and retryable. The Gags approval draws nothing for an unchanged grandfathered gag, draws one render for the one changed gag of a refresh with several, and draws nothing when the moderator returns through Gags without an edit. The Gags approval draws only missing male renders and clears nothing. "Render female and pet" draws only what is missing. Generic and object/vehicle are never drawn.
6. **The gate.** It refuses a fact whose offered gag lacks a kind, and names it; it passes complete and grandfathered gags. The waiver route is gone.
7. **The migration.** The row-state matrix above, run twice, on populated data, both runner-first and schema-diff-first (the diff applied, then the runner); approved and refresh-pending selections survive both, and afterwards a migrated refresh can be discarded, declined and completed and promoted while the legacy snapshot columns stay unchanged. The reverse migration restores the pre-migration state exactly.
7a. **Database rules.** Deleting or moving an approved example, or clearing the grandfathered flag early, is refused at commit; replacing a set in one transaction succeeds.
7b. **Reuse.** Content A, then B, then discard back to A: the tile shows A's render, approvable, and no new render is drawn. Overlapping save and Gags-approval requests draw one render. An explicit redraw draws a new one.
8. **Component tests.** The gag card's three tiles and its "what's approved" words. The Test Renders step without the grid, panel or checkboxes. The Final hashtags editor still saves. The unsaved warning names the gag.

**Increment 2:**
9. **Prompts.** None of the prompts offers a vehicle or object as the personalised subject: a grep test over the shipped prompt texts. The new gag-writer lock is pinned by its sha.
10. **Classification.** Classifying a vehicle-only or object-only photo yields no usable subject. Person and pet photos are unchanged.
11. **Legacy reads.** A stored attempt with a retired kind still loads in the admin screens.
12. **Admin tools.** The admin tools offer no vehicle option. The acceptance run's re-recorded doubles match.

**Runners:** `bash artifacts/api-server/scripts/run-test.sh`; `pnpm --filter @workspace/api-server test`; `npx vitest run`; `pnpm run typecheck:libs`.

**UAT, judgement steps only:**
- Iterate a gag with male renders, then render and approve its female and pet examples.
- Read the Test Renders step.
- Increment 2: read the gag writer's ideas on a pet fact.

## Implementation Steps

**Increment 1** (one PR):
1. The examples table, migration and reverse; the store and resolver changes (A, B).
2. Renders: the male iteration render, "Render female and pet", the Gags approval change, and the two scenarios leaving (C).
3. The gate (D).
4. The screens (E).
5. Docs: `visual-pipeline.md`, `moderation-workflow.md`, `decisions.md`, `launch-definition.md`'s readiness item; a corrected UAT for PR #956's step 2.

**Increment 2** (one PR):
6. The subject enum and the legacy reader; classification.
7. The prompts and their versions; the re-recorded doubles.
8. Admin tools.
9. Docs: `product-strategy.md`, `decisions.md`, `glossary.md`, `visual-pipeline.md`, the Manual, and the moderation and launch docs that still say "one example" or describe the waiver.

## Risks and Mitigations

- **A moderator finishes male, forgets female and pet, and can't approve.** The gate names the missing kinds per gag, and the gag card says what remains.
- **Dropping the waiver removes an escape hatch** for a reference photo that fails. A failing photo is fixed rather than waived: the reference-asset health check already reports it.
- **Increment 2's prompt changes shift idea and picture quality.** The changes are confined to deletions of vehicle and object wording. The UAT judges the writer's output on a pet fact.

## Open uncertainty

Whether the classifier can distinguish a pet from a stuffed toy or a mascot costume reliably enough for Q12's refusal. That is Phase 7's to measure; this plan only stops naming those subjects.

## Questions for David

None. Every choice above follows a settled decision or is a technical fork recorded here.

## Definition of Done

- **Increment 1:**
  - On dev, a moderator saves a gag and gets exactly one male render.
  - They iterate, then render and approve female and pet.
  - They approve the fact for production.
  - The Test Renders step shows no grid, no AI-read panel, no generic and no car render.
  - A grandfathered live gag is still offered.
- **Increment 2:**
  - No shipped prompt, classifier result or admin choice offers a vehicle or object subject.
  - Stored history still loads.
  - The strategy says people and pets.
