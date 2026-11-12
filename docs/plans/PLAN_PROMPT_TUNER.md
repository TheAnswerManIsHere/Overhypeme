# Plan — Launch Phase 8: the prompt tuner

```plan-oracle
# Oracle — Launch Phase 8: prompt tuner (agreed with David, 2026-11-11, in conversation; workstream #887)

## Direction served
`docs/ai-context/product-strategy.md` (approved 2026-11-11): GPT Image 2.6 draws photoreal pictures, Nano Banana 2.1 draws styled ones; prompts are tuned to those two engines; quality is scene fidelity, likeness and style.

## Product intent (David's words and agreed answers)
- "I think we can skip any additional engine tests as we're now settled on using GPT for photoreal and Nano Banana for stylized. What we need to do is to tune the prompting for those engines. We never really built a good 'prompt tuner' so that's the next thing we should work on."
- The engines are settled: the strategy's "Provisional" wording and its three-factor check are removed. No more engine rounds.
- The tuner is built on the existing engine-comparison tool: hold the engine fixed, vary the prompt wording. David edits the prompt wording for an engine, saves it as a new version, the same facts and face photo are drawn with the old and the new version, judged blind, and a winning version is promoted to live in one click.
- Judging changes to five categories, each scored 1–5 per picture:
  1. Visual quality — craft: clean hands, faces, textures, lighting, no smears or artifacts (photoreal: looks natural; styled: details rendered the way the style means them to look).
  2. Gag fidelity — does the picture show the fact's approved gag with the details, framing and placement it calls for; judged against the gag, never the prompt text.
  3. Realism — physics and plausibility only: weight, contact, motion, objects staying consistent, even for supernatural scenarios; for styled pictures, within the style's own rules.
  4. Style interpretation — how well the requested style is represented; skipped on unstyled pictures.
  5. Facial fidelity — how well the likeness of the supplied photo is kept. (Renamed **Likeness** and asked on any supplied photo, David 2026-11-12.)
- Plus one overall pick per panel ("which would you send to a friend?") and a "broken" flag per picture for hard failures (wrong person, extra limbs, stray text or watermark), replacing the face-mismatch checkbox.
- Rounds 1 and 2 stay readable under their old categories; they are not mapped onto the new ones.
- Retired in this work: the Eval harness's golden set, runs and opportunistic ratings (the Eval page becomes the tuner's home); the Engines page's rows for engines no longer used and its synthetic-test panel (Muse stays, in reserve); the per-fact prompt preview in the fact editor, once the tuner covers it. The launch definition's admin-console line is amended to match.
- Signed-out visitors cannot make images (David, 2026-11-11).
- David, 2026-11-12: "I should be able to modify any section of the prompt that is compiled into the final prompt. There are elements of the final prompt that are global and others that are fact-specific. I think for this exercise, we're looking only at global elements." Section order fixed and labels editable; the violence line and text rules editable as "policy" with a second confirmation at promotion; tuning runs default to about 1 megapixel with member size selectable; old Eval data deleted.

## Must not change
- Blind judging (the judge never learns which engine or prompt version drew a picture until results).
- Recording of what fal actually billed per picture.
- The prompts the live site and the moderation pipeline use, until a version is promoted.
- Blind moderation and the legal-safety rules; faces only from photos a user supplies.

## Settled decisions
- Engines by look: GPT Image 2.6 photoreal, Nano Banana 2.1 styled; Muse Image held in reserve; FLUX 3 and Seedream 5.0 Pro out (product-strategy.md).
- Funniness is settled at moderation; cost and speed are recorded automatically, not judged.
- Pricing does not gate a comparison run David starts (decisions.md, 2026-11-07: "Ignore pricing entirely"); what stays is everything that keeps a paid call from happening twice. The per-run and weekly paid-run budget binds runs an agent starts (verification), not David's own tuning runs.

## Now / next / never
- Now: engines settled in the docs; the tuner on the comparison tool; the new judging; promote to live; the three retirements.
- Next: a screen-size picture option; choosing the engine by look in the live app; the rest of the admin-console rebuild (#628 admin-console phase).
- Never: more engine-selection rounds.

## Ceremony
Product code, production phase: full plan loop, tier `product`.
```

## Problem

Every picture today is drawn from one prompt recipe written for an older Nano
Banana engine, and every engine in a comparison receives byte-identical text.
The wording is code constants, so nobody can try a change without a code
release, and there is no way to see whether a change made pictures better.
The judging records one overall score per picture, which cannot say *what*
got better. An older Eval harness (golden set, runs, opportunistic ratings)
and an engine test bench sit beside the comparison tool and were not used for
the engine decision.

## Current behaviour (as read in the code)

- **One compiler, no per-engine wording.** `compileForSubjectRenderMode`
  (`artifacts/api-server/src/lib/imagePrompt/compilers/nanoBanana2.ts:1653`)
  assembles the prompt from a planner-written visual plan plus code constants:
  the identity preambles (`:93-98`), `DEFAULT_PHOTOREALISTIC_STYLE` (`:106`),
  the "RENDER STYLE" framing, and `failureModeConstraints.ts`. The look
  style's suffix comes from `look_styles` rows. The compiler has no version.
- **A comparison freezes one prompt per panel.** `preparePanelInFlight`
  (`lib/comparison/runs.ts:235`) stores `visual_plan`, `compiled_prompt` and
  `style_snapshot` on `comparison_panels`; every cell (panel × engine) reads
  the panel's text (`runs.ts:439`). A cell stores no prompt of its own.
- **Judging** (`lib/comparison/judging.ts`, `comparisonPickSchema` in
  `lib/api-zod/src/engineComparison.ts`): one 1–5 score per picture, a
  face-mismatch mark, a captured-the-style mark; `picked_cell_id` exists and
  is always null. Results average the single score.
- **Live and moderation renders** go through `lib/imagePromptJobs.ts`, which
  compiles with the same compiler and routes the engine by mode from config
  (`lib/imageEngineRouting.ts`; fallback `nano-banana-2`).
- **Old tooling**: `routes/eval.ts`, `lib/eval/*`, `eval_runs`,
  `facts.eval_golden*`, eval columns on `image_prompt_attempts`,
  `pages/admin/evalDashboard.tsx`, `GoldenToggle`, `AttemptEvalControl`;
  `EngineTestPanel` in `pages/admin/engines.tsx` with its `assemble-prompt`
  and `test` routes; `RuntimePromptPreview` mounted in the fact editor and
  the moderation page.

## Proposed design

### A. Prompt recipes: versioned, per engine family

- A **prompt recipe** is every piece of **global** wording the compiler
  owns — the wording that is the same for every fact — as named pieces
  (David, 2026-11-12: *"I should be able to modify any section of the prompt
  that is compiled into the final prompt … for this exercise, we're looking
  only at global elements."*). Today's global pieces, as read in
  `nanoBanana2.ts` and `failureModeConstraints.ts`:
  - the identity paragraph, in three variants (person photo, pet or object
    photo, no photo) and the no-photo gender clause;
  - the subject-binding sentences, including the age-change variants;
  - the speech- and thought-balloon phrasing and the balloon carve-out line;
  - the caption-space sentence;
  - the photoreal style line;
  - the overlay-text and incidental-text rules, and the in-scene-text
    variants (literal text, visual graphic, require, forbid) in
    `composeSupportingTextDirective` (`nanoBanana2.ts:382`);
  - the violence line and its soften and suppress variants
    (`composeViolenceDirective`, `nanoBanana2.ts:470`);
  - the no-duplicates and age-change "do not" lines;
  - each failure-mode line (sole agent, active action, crowd,
    cause-and-effect, role reversal);
  - the fourteen section labels;
  - any other fixed wording inside a composer: the inventory is taken from
    the code during implementation, not from this list, and each piece keeps
    its fact-specific content and its emission condition fixed;
  - one free-text **engine notes** piece, empty by default, at a fixed point.
- **Fact-specific sections are not part of a recipe**: the core scene,
  subject realization, role, subject and required visual details,
  environment, additional details, bubble content, the fact's own framing,
  lighting, a look style's own text, and the moderator's "do not" lines. The
  recipe screen shows them for the chosen fact, fixed.
- **Each piece is a template with named slots** (for example `{name}`,
  `{side}` for the caption space, `{forbiddenTypes}` for the overlay rule).
  A version that drops a slot a piece requires is refused at save with the
  reason shown. Any piece except a policy piece may be emptied.
- **When a line appears stays as it is.** A recipe changes a line's wording,
  never the condition under which the compiler emits it (failure-mode lines
  are conditional, `failureModeConstraints.ts:67`; age-change lines appear
  only on age-change facts).
- **Section order is fixed** in this work, because order decides what is
  trimmed first when a prompt runs long; labels are editable. Reordering is
  *next* if tuning shows order matters (David, 2026-11-12).
- **Policy pieces** — the violence line and the two text rules — are editable
  like the rest but marked "policy" on screen, and cannot be emptied (a
  caption baked into the picture would collide with the overlay). Promoting
  a version that changed one asks a second, separate confirmation naming the
  changed policy wording (David, 2026-11-12).
- Recipes are stored as **immutable versions per engine family**. A saved
  version is never edited; changing wording saves a new version with a note
  saying what changed and who saved it.
- **The baseline version is today's wording, exactly.** With no promoted
  version, or for an engine family that has none, the compiler produces
  byte-identical output to today's. This is the invariant that keeps live and
  moderation prompts unchanged until a promotion.
- The planner's instructions (what writes the scene description) are **not**
  part of a recipe in this work: they are not compiled into the final prompt,
  and changing them changes every engine at once.
- **What editing looks like.** The recipe screen lists each piece by a plain
  name with its current text in an editable box, and beside it a preview of
  the fully assembled prompt for a fact David picks, with the recipe's pieces
  highlighted and everything else (the approved gag's scene, the supplied
  identity, the look style's own text) shown as fixed. For example the
  person-photo identity piece today reads "Image-to-image edit using the
  reference image as the person's identity source. Preserve the reference
  person's recognizable identity and likeness…", and the binding piece "The
  reference person is {name}."; David can reword either, and cannot edit
  the scene or the gag from this screen. The preview switches between the
  three photo types and an age-change fact, so conditional pieces can be
  seen.
- The approved gag and every moderator-authored section reach the prompt
  through the shared assembly path whatever the recipe says; a recipe cannot
  remove them.
- **One resolver, one assembly.** The tuner, the render worker and the
  moderation page's prompt preview all obtain the recipe from the same
  resolver and compile through the same function, so what a preview shows is
  what a render sends.
- Look-style suffixes stay where they are (`look_styles`), shared by all
  engines; a recipe changes how a style is framed, not the style's own text.

### B. Tuning runs on the comparison tool

- A comparison set gains a second kind: **prompt comparison**. It names one
  engine family and two or more recipe versions (the live one is offered by
  default as "old"). Facts, scenarios, looks and the reference photo work as
  they do today. Picture size defaults to comparison size (about 1
  megapixel) for a prompt comparison, with member size still selectable
  (David, 2026-11-12).
- The scene plan is made **once per panel and shared** by every version, so
  the only thing that differs between the pictures in a panel is the recipe.
- **Frozen inputs.** A panel freezes, at preparation, the fact's wording,
  its approved gag, the supplied photo, the look style, the shared scene
  plan and the request settings; later edits to the fact or gag do not
  change what a panel was drawn from or is judged against. "Only the wording
  differs" is thereby a property of the comparison, not a hope.
- The set screen offers the person-photo scenarios by default for a prompt
  comparison; the other scenarios remain selectable.
- Each picture records the recipe version and the exact prompt text it was
  drawn with. Billed-cost recording, reruns, admission and the
  double-call protections are unchanged and apply to prompt comparisons as they do to
  engine comparisons.
- Blindness: the judging page shows the panel's **frozen gag and fact
  wording and the reference photo**, and neither version labels nor any
  prompt text (today's judging payload carries the panel's prompt,
  `judging.ts:223`; for second-edition sets it carries none). Results
  reveal, per picture, the version and the prompt text used.

### C. Judging, second edition

- Every **new** set, of either kind, is judged with the five categories in
  the oracle, each 1–5 per picture, with the oracle's wording shown as help
  text beside each. Style interpretation is not asked on an unstyled panel;
  The fifth category is **Likeness**, asked on every panel with a supplied
  photo — person, pet or object — and never on one without (David,
  2026-11-12: *"Likeness is what I'm going for."*).
- One **overall pick per panel** and a **broken** flag per picture. A picture
  lost for good after the existing retry allowance counts as 1 in each
  applicable category average, cannot be the pick, stays in the pick-share
  denominator, and is counted separately as lost (David, 2026-11-10: "Count
  it as 1"; decisions.md).
- A judgement is complete only when every shown picture has every applicable
  score and the panel has its pick; the server refuses a partial one.
  Re-judging keeps the earlier judgement in history, as today.
- **Results per set**: for each engine or version — the share of panels it
  was picked on, the mean of each category, broken and lost counts, billed
  cost per picture and time to draw. No blended single number is computed
  from the five; the pick share is the headline.
- **Existing sets keep the judging they were made with**: sets 1–4 show
  their single score, face-mismatch and captured-the-style marks exactly as
  now, and cannot be re-judged under the new categories. Results are no
  longer averaged across sets of different editions.

### D. Promote to live

- On a prompt comparison's results, each version has a **Promote** action
  with a confirmation naming the engine family and the version. Promotion
  records who and when, and the tuner page shows the live version per family
  and its history; promoting an earlier version again is the undo.
- From then on, any render whose engine belongs to that family — live,
  moderation or a new comparison's default — compiles with the promoted
  recipe. An engine family with no promoted version uses the baseline.
  Saving a version, or running a comparison with it, changes nothing live.
- A render attempt records the recipe version it compiled with. Work
  already queued keeps the version it was queued under.
- Moderation's "is this render still current?" check
  (`computeScenarioInputHash`, `lib/reviewRenderScenarios.ts:119`) takes the
  recipe version as an input, so after a promotion affecting the engine
  moderation renders with, existing moderation renders show as out of date
  exactly as they do when the engine changes; nothing is re-rendered
  automatically.
- Promotion changes wording only. It never changes which engine a render is
  routed to.
- **Consequence to accept (decision 2 below):** promotion takes effect on
  subsequent renders routed to that engine family, and this work leaves
  routing unchanged. On the dev app today both routing settings name Nano
  Banana 2 (read 2026-11-11: `image_engine_t2i = nano-banana-2`,
  `image_engine_i2i = nano-banana-2-edit`; production unable to verify: the
  same read there settles it, run before increment 2 merges). So a promotion
  for GPT Image 2.6 or Nano Banana 2.1 selects the version for later
  comparisons and has no effect on live or moderation renders until routing
  sends renders to that family — by the existing per-mode default or by
  routing by look (*next*).

### E. Retirements

- **Eval harness**: the golden-set toggle, eval runs, opportunistic ratings
  and their dashboard are removed — routes, jobs, screens, the `eval_runs`
  table, the golden columns on facts and the eval columns on render attempts.
  Render attempts themselves stay; they are core to moderation.
- **The Eval page becomes "Prompt tuner"**: comparison sets (both kinds),
  judging, results, recipe versions and the live version per family.
- **Engines page**: the synthetic-test bench and its routes are removed.
  Engines no longer used are marked retired by migration — FLUX 1.1 Pro,
  FLUX 2 Pro, FLUX 3, Seedream 5.0 Pro, Nano Banana Pro, GPT Image 2 and GPT
  Image 2.5. Kept: Nano Banana 2 (live routing uses it today), Nano Banana
  2.1, GPT Image 2.6, Muse Image, and the non-image engines. Retired engines
  still display by name in old comparison results.
- **Prompt preview** (`RuntimePromptPreview`) is removed from the fact
  editor, where the tuner's recipe preview replaces it. The moderation
  page's copy stays, reading the recipe through the shared resolver.
- **Opportunistic ratings** go from the moderation render tiles too
  (`FactRenderScenarioTile`, `AttemptEvalControl`), not only from the Eval
  page.
- Before the engine-retirement migration is written, the deployed routing
  values (`image_engine_t2i`, `image_engine_i2i`) are read on dev and on
  production; an engine either of them names is not retired.
- Signed-out picture-making is already refused server-side
  (`routes/render.ts:109`); a test asserts it and nothing is rebuilt.
- **Docs**: product-strategy.md loses "Provisional" and the three-factor
  check and records signed-out visitors; decisions.md records the engine
  settlement, the judging categories and the retirements; launch-definition's
  admin-console line, the visual-pipeline doc, the Manual and in-app help are
  swept to match.

## Data model and migration impact

- New: recipe versions (per family, immutable) and the promoted-version
  record with history. Changed: comparison sets (kind, family, versions,
  judging edition), cells (version, prompt text; uniqueness widens from
  panel × engine to include the version), picks (per-category scores, pick,
  broken marks).
- **Existing rows**: sets 1–4, their cells and picks are not rewritten; they
  are stamped as the first judging edition and engine-comparison kind by
  column default. No backfill of scores.
- **Destructive**: dropping `eval_runs`, `facts.eval_golden*` and the eval
  columns on `image_prompt_attempts`. Before the migration is written, a
  read-only count on the dev database of golden facts, eval runs and rated
  attempts is recorded in the PR; a non-zero count is reported to David with
  a recommendation before anything is dropped. Dev, read 2026-11-11: 1 eval
  run, 2 golden facts, 11 rated attempts (decision 4 below). Production:
  (unable to verify: whether production
  holds any eval rows; the same read-only count there would settle it, and
  it is run before the destructive migration is merged).
- Migrations follow the repo's numbered-file ceremony and the
  `overhype-migration-review` checklist; the destructive one ships in its
  own PR, after the code that reads those columns is gone.

## Security, permissions, validation

All new routes are admin-only, validated server-side with shared zod
schemas. A recipe piece has a length cap and the compiled prompt stays under
the existing budget gate; a version is validated at save through
the real compiler's budget measurement (`measureRequiredPromptBudget`) across
every mode and conditional clause, keeping the existing reserves for a
moderator's scene, additions and bubbles — a successful preview of one fact
is not the gate — and an oversized version is refused with the reason shown,
leaving the promoted version untouched. The render-time overflow refusal
stays. `measureRequiredPromptBudget` (`promptBudget.ts:95`) is extended, not
just given a recipe: its fixture today supplies a selected style and no
bubbles, so it must also measure the photoreal default line, the labels and
the repeated balloon wording at the preserved allowance for moderator
bubbles and additions. Promotion and version saves are attributed.
Starting a tuning run keeps today's admission exactly: the cost shown is a
label, not a limit (decisions.md, 2026-11-07), and the double-call
protections (one lock, one reservation per call, request id stored before
polling) cover the extra cells a prompt comparison adds. Paid dispatch stays
refused in CI.

## Testing

- Baseline equality: expected prompt text is captured from the current
  compiler **before** it is refactored, across the existing test corpus and
  every render mode; the baseline recipe must reproduce those bytes.
- Enqueue → promote → worker: an attempt queued before a promotion, and one
  with no recipe field at all, compile as baseline. Adding recipe support
  alone leaves every existing moderation render current; only a promotion
  affecting moderation's engine marks them out of date.
- A promoted version changes the compiled text for its family only; other
  families and unpromoted state are unchanged.
- Prompt-comparison planning: one plan per panel, one cell per version, each
  cell's stored text equals compiling its version.
- Judging: completeness refusal, not-applicable rules, pick required, broken
  marks, history on re-judge; first-edition sets still judge and display as
  before; blind payloads carry no version, engine or prompt text.
- Results: per-version aggregation, a lost picture counted as 1 and in the pick denominator, no cross-edition
  averaging.
- Retirement: removed routes return 404; retired engines are refused by
  routing and by new sets, and still render in old results.
- Frontend tests and E2E for the tuner page's states (empty, running,
  partial, failed, complete) per `async-ui-status.md`.

## Increments (each its own PR, in order)

1. **Judging, second edition** (C), with the frozen fact wording and
   approved gag for new sets of either kind, their display during judging,
   and no prompt text in second-edition blind responses (from B) — usable at
   once on engine comparisons. Editing a fact or gag after preparation
   leaves a new set's judging reference unchanged.
2. **Recipes, prompt comparisons and promotion** (A, B, D).
3. **Retirements and docs** (E), with the destructive migration as its own
   PR at the end.

## Risks

- **The compiler refactor changes live prompts by accident.** Mitigated by
  the baseline-equality test over the existing corpus, required before
  increment 2 merges.
- **Judging load.** Five scores per picture is five times today's clicks; a
  tuning run is expected to be small (a handful of facts, two versions). The
  page keeps keyboard entry.
- **Small-sample conclusions.** A promotion rests on David's judgement of a
  few panels; results show the number of panels beside every figure.

## Decisions David took while planning (2026-11-12)

1. **What is editable:** every global piece of the compiled prompt;
   fact-specific sections are out of scope for this work.
2. **Promotion and the live site:** accepted as described in D — *"Accept as
   is. Nobody is using the site today."*
3. **Likeness** on any supplied photo.
4. **Old Eval data:** delete with the harness.
5. **Section order** fixed, labels editable; **policy pieces** editable with
   a second confirmation at promotion; **run size** defaults to about 1
   megapixel.

## Definition of done

David can save a new recipe version for GPT Image 2.6 or Nano Banana 2.1,
run it against the live version on facts of his choosing, judge blind on the
five categories (Likeness on any photo) with a pick and broken flags, read results per version with
real cost, and promote the winner; the old Eval harness, test bench, unused
engines and prompt preview are gone; the docs say the engines are settled.
