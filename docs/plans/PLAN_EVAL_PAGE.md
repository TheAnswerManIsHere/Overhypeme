# Plan — Launch Phase 8: the Eval page, rebuilt as two wizards (amends PLAN_PROMPT_TUNER.md, part 3)

```plan-oracle
# Oracle — the Eval page redesign (agreed with David, 2026-11-12, in conversation; workstream #887)

## Direction served
The prompt tuner plan (`docs/plans/PLAN_PROMPT_TUNER.md`, approved 2026-11-12): engines settled (GPT Image 2.6 photoreal, Nano Banana 2.1 styled, Muse in reserve); prompts tuned per engine by blind comparison; the Eval page is where that work happens.

## Product intent (David's words and agreed answers)
- "Before we go any further, we must fix the Eval admin page so that its UI/UX is much better. It's totally unclear how it's supposed to work and what a user is supposed to do."
- "Let's prune anything that it isn't actually going to be used for." The old Eval harness (golden set, "Start eval run", runs, opportunistic ratings) is taken out now.
- "The Eval page is meant to help us do two things. 1) It is used to evaluate engines. 2) It is used to evaluate prompts." Two tabs at the top: "Evaluate Models" and "Evaluate Prompts".
- Evaluate Models is a wizard: (1) facts — a keyword search over facts that are fully active with all the correct enrichment, click a fact to add it, one or many; (2) engines — checkboxes over the candidate engines decided in code with David (GPT Image 2.6, Nano Banana 2.1, Muse); (3) photo types — male, pet, vehicle (female and non-binary dropped: "they're not necessary for judging the engine"); (4) looks (David: yes); (5) a single Description field (e.g. "GPT Image 2.6 vs. Nano Banana 2.1"). The system counts the images and shows the total with a cost estimate "so I know if I'm accidentally asking it to generate 200 images". No Round field and no Size field: "All images get rendered at 1 megapixel for comparisons."
- One "Generate Images" button does all the work: "I don't need separate buttons to build prompts and then render images." Generation runs on its own in the background with spinners showing progress.
- "The dev environment only stays up for a few minutes at a time … if there's any way to keep it alive to completion, that would be great."
- Evaluate Prompts works the same way (David: yes): facts, one engine, two to four wording versions, photo types, look, description, Generate Images; the wording editor sits in that tab.
- "Once the images are generated, there should be a button that says judge results. I hit that button and it takes us through the interface that we've already built so that I can rank on a scale of one to five the different categories and save those page by page for each thing once that's all done. There should be a finish button at which point we can analyze the results."

## Must not change
- Blind judging (the judge never learns which engine or wording version drew a picture until results).
- Recording of what fal actually billed per picture.
- The prompts the live site and the moderation pipeline use, until a wording version is promoted.
- Blind moderation and the legal-safety rules; faces only from photos a user supplies.
- Sets judged before this change stay readable on the results page.

## Settled decisions
- The prompt tuner plan's decisions stand: five 1–5 categories, the pick, the broken flag; promotion changes wording only, never routing.
- Comparison size (about 1 megapixel) only; the member-size option goes (David, 2026-11-12).
- Candidate engines: GPT Image 2.6, Nano Banana 2.1, Muse (David: "Recommended").

## Now / next / never
- Now: the two-tab page, both wizards, one-button generation, the evaluations list with Judge results / Finish / Results, the Eval harness removal, keep-alive while generating.
- Next: the rest of the original part 3 (engine retirement after the production routing read, fact-editor prompt preview removal, docs sweep) and part 4 (the destructive migration).
- Never: a separate prepare/render control; per-set round or size choices.

## Ceremony
Product code, production phase: plan, Astra assessment, David's approval, standard code-review loop per PR.
```

## Problem

The Eval page (`/admin/eval`, `pages/admin/evalDashboard.tsx`) stacks every
feature built for it as its own panel: the old Eval harness (golden set,
"Start eval run", runs, opportunistic ratings), the engine comparison panel
with a Round, a picture size and separate Prepare and Render buttons, and
the prompt wording editor. Nothing tells the admin what the page is for or
in what order to act, and half of it is no longer used.

## Current behaviour (as read in the code)

- `evalDashboard.tsx` renders, top to bottom: the harness header and
  "Start eval run" (`startRun`, line 92), the golden set (line 223), runs
  (line 241), opportunistic ratings (line 296), the `EngineComparison`
  panel and `PromptRecipes`.
- `EngineComparison.tsx` creates a set from typed fact ids, a round preset
  or a wording choice, a size; then "Prepare" and "Render" each plan a run
  (`/plan`), show its worst case and start it (`startComparisonRun`,
  `lib/comparison/runs.ts:125`). Panels and cells are durable async jobs
  (`enqueueJob`, `runs.ts:164`, `171`), so a restart resumes them.
- Candidates: `COMPARISON_DEFAULT_FAMILIES` (`lib/api-zod/src/engineComparison.ts:13`)
  lists six families.
- Scenarios: `generic_t2i`, `i2i_male_default`, `i2i_female_default`,
  `i2i_nonhuman_animal`, `i2i_nonhuman_object_vehicle`
  (`lib/api-zod/src/renderScenarios.ts`).
- Judging (`pages/admin/comparisonJudging.tsx`) saves one panel at a time
  with previous/next; results live at `/admin/eval/results?sets=…`.

## Proposed design

### A. The page: two tabs

`/admin/eval` shows two tabs, **Evaluate Models** and **Evaluate Prompts**,
selected tab kept in the URL (`?tab=models|prompts`) so a link and the
browser's back button land on the right one. Each tab holds, in order: a
one-line description of what it does, its wizard, and its list of past
evaluations. The Evaluate Prompts tab also holds the wording editor,
collapsed by default, under its own heading.

### B. The wizard (both tabs)

Steps, each one screen with Back / Next, the next step disabled until the
current one is valid:

1. **Facts.** A search box filters the eligible facts by keywords in the
   fact text (server-side, as you type, debounced); clicking a result adds
   it to a chip list; clicking a chip removes it. At least one.
   **Eligible** means the fact is active (not deleted, published) and its
   active, effective enrichment passes its existing validation with a saved
   Visual Concept (the approved gag lives there). A pending refresh candidate
   does not make an active fact ineligible. The search and creation use one
   shared predicate; if a fact stops being eligible between search and
   Generate, creation says which one and the wizard keeps every other
   selection. The search shows how many facts are eligible.
2. **Engines** (models tab): checkboxes over the candidates, all three
   unticked by default; at least one. **Wording** (prompts tab): one engine
   from the candidates, then two to four of its versions with the live one
   and the newest pre-ticked (today's behaviour).
3. **Photo types**: male, pet, vehicle — checkboxes, male pre-ticked; at
   least one. The candidate list and the photo types are constants in code
   (`lib/api-zod`), changed only by a PR.
4. **Looks**: "No look (photoreal)" plus the active looks from the catalogue,
   checkboxes, "No look" pre-ticked; at least one. Models tab: any number.
   Prompts tab: exactly one (today's rule).
5. **Description and confirm**: a required Description field, then the count
   — "N facts × M engines (or versions) × P photo types × L looks = X
   images" — with the worst-case cost from the existing admission estimate
   (preparation plus rendering), computed read-only from the proposed
   selection with the same layout and costing functions the run uses — no
   set exists yet. Above a threshold (50 images) the count is shown as a
   warning. **Generate Images** creates the evaluation and starts
   all of its work.

Nothing in the wizard is saved until Generate Images; leaving the tab keeps
the wizard's state for the page visit.

### C. One-button generation

- **Generate Images creates and starts one evaluation, once.** The request
  carries a token the wizard generates; repeating it (a lost response, a
  double tap) returns the evaluation it already created instead of buying a
  second batch. Creation and admission happen in one server action.
- **Admission reserves both stages at once** — every panel's preparation and
  every cell's rendering, at the existing per-call bounds — and queues the
  preparation. Rendering waits on its panel.
- **Preparing a panel makes its already-admitted cells runnable in the same
  transaction** that records the panel as prepared, so a restart between the
  two cannot strand them, and replaying the transition never submits a cell
  twice. A panel whose preparation fails or is skipped releases its cells'
  unused reservations and marks them resolved.
- **Recovery is one action per failure**, each saying whether it can cost
  another call: *Retry scene* re-runs a failed preparation and then that
  panel's pictures with no further control; *Retry picture* starts a cell's
  one permitted rerun; *Retry storage* re-stores an image fal already drew,
  at no cost. Successful work is kept. The spend guarantees of comparison
  runs (one submission per admitted attempt, reservations settled at their
  bound, ambiguous calls failed rather than repeated) are unchanged.

### D. Past evaluations

Each tab lists its evaluations, newest first: description, created date,
counts, and a status derived from the existing panel, cell and judgement
records (no stored counters) — **Generating** (with a spinner, "14 of 40"),
**Needs action** (a failure that can still be retried, with its reason and
its retry control), **Ready to judge**, **Judging** ("3 of 10 panels"),
**Finished** — with failed, skipped and lost counts visible. Per evaluation:

- **Judge results** is enabled when no panel has generation or recovery work
  outstanding. Skipped panels and panels whose pictures are all lost for good
  stay visible and need no judgement; a lost picture still counts as 1, as
  the tuner plan settled. It opens the existing blind judging screen at the
  first unjudged panel. Panels are saved one at a time as today.
- On the judging screen, a **Finish** button appears once every judgeable
  panel has a complete saved judgement. The server rechecks that before
  marking the evaluation finished, and refuses while anything is pending,
  running or recoverable. An evaluation with nothing to judge says "No
  images to judge" and is never shown as a finished comparison.
- **Results** opens the existing results page for that evaluation.
- Sets created before this change appear in the list (their Round and size
  shown as read-only facts), so nothing is orphaned.

### E. Keeping dev alive while generating

What survives a restart is the record, not always the motion: a picture
with a recorded fal request resumes polling; a call interrupted before fal
gave a request id is failed as ambiguous rather than paid for twice (it then
shows **Needs action**); a crashed job is reclaimed only after the existing
30-minute cutoff. Those protections stay. What stalls a run is the dev app
being stopped.

- The first PR measures, through the connector and with no other activity
  keeping the workspace awake, whether the page's polling keeps the **API
  worker** running past the observed shutdown interval.
- The evaluations list polls every 5 s while anything is in flight. If a
  poll fails, the list shows "Connection lost — progress unavailable" with
  the last known status, keeps trying, and reconciles when the server
  answers; a failed poll alone is never reported as "the server stopped".
- If polling keeps the worker alive, the tab says "Keep this page open until
  generation finishes". If it does not, see the decision below; nothing in
  this plan changes hosting.

### F. Pruning the old harness

Removed now: the golden-set toggle (Eval page and the fact editor's
`GoldenToggle`), "Start eval run", runs, opportunistic ratings — their
screens (Eval page and the moderation render tiles' `AttemptEvalControl`),
their routes (including the rating route in `reviews.ts`) and their job
producers. The image-prompt workers they shared with moderation stay. Their tables and columns are left in
place until part 4's destructive migration, which drops them. The Round
selector, the size selector, typed fact ids and the separate Prepare /
Render buttons go from the comparison screens. `COMPARISON_DEFAULT_FAMILIES`
becomes the three candidates.

## Data model and migration impact

- Additive only: `comparison_sets.finished_at` (nullable, written by Finish)
  and `comparison_sets.request_token` (nullable, unique, for Generate
  Images' idempotency). Nothing dropped in this work.
- Older sets keep their `round` and `image_size`; new sets write round 1
  and comparison size.

## Security, permissions, validation

Admin-only routes as today. The fact search is admin-only and returns fact
id and text only. Creation re-validates every input server-side: eligible
facts (same predicate as the search), candidate engines only, photo types
from the allowed three, active looks, description non-empty and capped.

## Testing

- Server: eligibility predicate (each failing condition excluded, a pending
  refresh candidate not); creation refuses an ineligible fact, a
  non-candidate engine, a disallowed photo type; a repeated Generate with
  the same token returns the same evaluation; one-button run prepares then
  renders every cell with one admission and reservations settled at bound;
  an interruption between "prepared" and "cells runnable" leaves no cell
  stranded or submitted twice; Retry scene / Retry picture / Retry storage
  each do exactly their one thing; status derivation across mixed success,
  skips, recoverable and exhausted failures and zero judgeable panels;
  Finish refused while work is pending or recoverable and when judgements
  are incomplete.
- Frontend: wizard step gating and Back/Next, fact search add/remove, the
  image count and cost for a known selection, the over-50 warning, the
  evaluations list states and buttons, the tab in the URL.
- Browser (E2E smoke, screens shard, against the fake fal double): the
  models wizard from facts to Generate, progress, Judge results, a saved
  panel, Finish and Results, surviving a reload; the prompts flow the same
  in increment 2. The existing blindness, billed-cost and old-results checks
  stay.
- The harness removal: its routes answer 404; moderation tiles render
  without the rating control.

## Increments (each its own PR, in order)

1. **The two tabs, the models wizard, one-button generation, the evaluations
   list with Judge results / Finish / Results, the keep-alive measurement
   and its result (E), and the harness's screens and routes removed (F).**
2. **The prompts tab**: its wizard and evaluations list, the wording editor
   moved into it.

Then the remaining original part 3 items and part 4, as the tuner plan
lists them.

## Risks

- A long run admitted at once reserves its whole worst case up front; the
  estimate shown before Generate Images is that same number.
- The eligibility predicate could exclude facts David expects to see; the
  search shows a count of eligible facts so a surprise is visible.
- Keep-alive may not be achievable on dev; the plan says what happens then.

## For David at approval

1. **Keeping dev awake is best effort.** Recommendation: try the page's
   polling and ship honest "connection lost / needs action" behaviour now,
   with no hosting change; if polling cannot keep the worker alive, bring
   measured hosting options (Replit documents a Reserved VM for continuous
   background work) as a separate decision. The alternative is to treat
   continuous running as required before this work counts as done.

## Definition of done

David can open Eval, pick Evaluate Models, choose facts by searching, tick
engines, photo types and looks, see the image count and cost, write a
description, press Generate Images once, watch it finish, press Judge
results, judge page by page, press Finish and read the results — and the
same on Evaluate Prompts — with nothing on the page that is not used.
