```plan-oracle
# Oracle — Launch Phase 8: Engine evaluation

Agreed with David at the scope-of-work gate, 2026-11-06 (Issue #887 — Launch
Phase 8 — Engine evaluation; a phase of Issue #628 — Get to launch: define the
launch, then make it true). The product lane now builds 8 → 7 → 6 (David,
2026-11-06), so this phase runs before the image offering (Phase 7) and the
loop (Phase 6). Phase 8's dependency on Phase 11's spend accounting is replaced
by the standing paid-run budget.

## Direction served

The image offering is the product's visible quality, and the engine under it
was chosen in early 2026. David, 2026-11-06: *"in order for the AI rendered
background to be valid as the default, we're going to have to spend the time
revisiting AI text to image engines. The technology has improved so much since
we started building and I think now might be a good time to review what is
possible."* The launch definition lists "style presets reviewed against the
winning engine" under image memes and keeps the eval dashboard for exactly
this. `PLAN_GET_TO_LAUNCH.md` v11, *Phase 8*: "the default image engine is the
best current model on this product's own facts, chosen from evidence, with
presets tuned to it."

## Product intent

The default image engine for each render mode — text-to-image for the free
hero renders, reference-photo editing for Legendary's face in the scene — is
the one that looks best to David on this product's own facts, chosen blind
from the same prompts, at a price Phase 11 can afford. The engines are also
compared on three rendering styles people actually choose, so Phase 7 can
offer styles that work. Presets and the compiler are then tuned to the
winner(s).

David's judging rule (2026-11-06): *"We're not really testing how well the
engine interprets the prompt yet. Once I decide which engine looks good, we
can tune it to better represent the prompt."* This round judges how the
pictures look; prompt fidelity is the compiler tuning after the pick.

## Scope, now (four increments, build order)

1. **The engine becomes a parameter.** The worker and the eval runner read the
   image engine for each generation mode from the catalogue instead of the two
   hard-coded strings (`imagePromptJobs.ts:327`, `factRenderScenarios.ts:73`,
   both `generationMode === "i2i" ? "nano-banana-2-edit" : "nano-banana-2"`);
   an eval run can name its engine (today its body is `{ label }` only); the
   five candidates join the catalogue, inactive for users, behind the existing
   flag. The fal pricing warm-up's rate-limit errors are fixed (K13) and a
   default text engine is set (K4), because the evaluation depends on pricing
   and planning working cleanly. Two look styles are added for the
   stylisation round: `3d-cartoon` and `caricature` (prompt suffix within the
   compiler's 180-character RENDER STYLE bound); `anime` exists.
2. **The comparison.** David names the three golden facts and sets them up on
   dev (a stop that waits on him; the plan spells out what "set up" must mean:
   approved, a Visual Concept the planner accepts, enrichment resolved with no
   override errors, the human and non-human reference scenarios resolvable).
   Round 1, photorealistic: three facts × five render scenarios
   (`generic_t2i`, `i2i_male_default`, `i2i_female_default`,
   `i2i_nonhuman_animal`, `i2i_nonhuman_object_vehicle`) × six engines (the
   five candidates and Nano Banana 2 as control), one render per cell, the
   same compiled prompt and each engine's defaults; the reference faces are
   the defaults (David's and his wife's, decided 2026-10-17). Round 2,
   styles: the same three facts × two scenarios (`generic_t2i` and the human
   reference scene) × three styles (anime; 3D cartoon / toy figure;
   caricature) × six engines. Runs are recorded in the eval dashboard per
   engine with their cost. Before the runs, two premises the survey could
   not settle are checked: whether Google has deprecated Nano Banana 2 (read
   from Google's own page), and whether GPT Image 2.6's fal price has
   settled, in which case it replaces 2.5.
3. **The judging.** Blind panels in the eval dashboard: each one fact and
   scenario (and style, in round 2) across the six engines with names hidden
   and positions shuffled; David picks the best and marks any face that is
   not the person. Fifteen panels in round 1, eighteen in round 2. Picks are
   recorded against the hidden engine; the result is a winner per mode
   (text-to-image; reference edit), written to `decisions.md` with the
   tallies. An optional round 3: the top two engines on six more facts, if
   rounds 1 and 2 leave them close; David's call at the time.
4. **Adopting the winner.** The catalogue default per mode set to the
   winner(s); the compiler adapted (the planner/compiler split kept, the
   Visual Concept still leading); presets re-reviewed against it; the dev
   catalogue's hero sets re-rendered on the winner so Phase 7 offers them;
   the two weakest catalogue entries (FLUX Pro v1.1, FLUX.2 Pro) removed as
   part of the sweep.

The shortlist (David, 2026-11-06, "as listed"): GPT Image 2.5 Sunburst at
high quality (~$0.053 at 1K on fal), Nano Banana 2.1 (~$0.04), FLUX 3 Image
($0.048), Seedream 5.0 Pro (~$0.0675), Meta Muse Image ($0.01, the cheap
outlier); Nano Banana 2 ($0.08) as control. Each engine's edit sibling carries
the reference scenarios. GPT Image 2.6 replaces 2.5 if its fal price settles
before the runs.

Cost: about 200 renders in rounds 1 and 2, under $10 at the listed prices;
each run under the $5 per-run budget and the whole under the $25 week.

## Next, not this phase

- An automated face-similarity score (needs a face-embedding dependency;
  David's eye is the judge at launch).
- Per-engine style presets beyond the winner's; the user-facing style
  picker and the catalogue alignment (Issue #888 — Get to launch: align the
  style catalogue with the styles people actually choose) are Phase 7's.
- Re-rendering production, which starts empty at Seed.

## Never

- A run that starts without the budget rule being met.
- A judging panel that shows the engine's name.
- Any engine that is not on fal (no new vendor).
- PuLID or a LoRA-training path.

## Must not change

- The planner/compiler split and the Visual Concept as authoritative
  (`visual-pipeline.md`).
- The hard gate that a fact goes live only with approved hero renders
  (`launch-definition.md`).
- The paid-run budget: $5 a run, $25 a week, above it asks first, every run
  reported with its cost (`uat-doc-format.md`, *Lanes*; `decisions.md`,
  2026-10-17 and 2026-10-21).
- AI-generated images are checked by David; Claude reads them only for
  verifiable facts (`decisions.md`, 2026-10-17).
- The default reference faces stay David's and his wife's (`decisions.md`,
  2026-10-17).
- No new vendors without David (`launch-definition.md`, *Must not change*).

## Settled, David's (2026-11-06)

- Phase 8 builds first (8 → 7 → 6); its wait on Phase 11 replaced by the
  budget rule.
- A winner per mode, decided from the same panels.
- The shortlist of five plus the control, as listed.
- Three facts, which David names and sets up on dev; fifteen panels in round
  1 and eighteen in round 2; the optional third round.
- The judging rule: look now, prompt fidelity after the pick.
- The three styles, chosen on the research David asked for (anime; 3D
  cartoon / toy figure; caricature), with painting the runner-up not chosen.
- The style-catalogue alignment filed as Issue #888 for Phase 7.

## Ceremony

Production phase, product tier, the `overhype-visual-pipeline` skill (the
visual pipeline is the overlay's sensitive subsystem), the standard loop with
Codex review on every PR. Schema changes (engine rows, look styles, eval-run
engine column, blind-panel picks) take the migration review. Planning on
Fable; the build moves to Opus at its start. David's batch item, the winner,
is answered by the comparison itself.
```

# PLAN — Launch Phase 8: Engine evaluation

> Workstream: Issue #887 — Launch Phase 8 — Engine evaluation (a phase of
> Issue #628 — Get to launch: define the launch, then make it true).
> v5, 2026-11-06, presented for approval after Astra's round 4 (the GPT 2.5 reference-image allowance disclosed honestly and folded into D2; the ledger carries each exchange's reasoning). The fenced `plan-oracle` block above is the scope
> David agreed at the gate; it is what this plan is measured against.

## Problem

The image engine under every render was chosen in early 2026 and is wired in
by name: two places in the worker pick `nano-banana-2` or
`nano-banana-2-edit` by string, the eval runner can only re-render the golden
set under today's configuration, and the prompt compiler is written for that
one engine. Since then the field has moved (GPT Image 2.5 leads every public
board; Nano Banana 2.1 is top-8 at half the price; FLUX 3 Image takes ten
reference photos at a flat price), and the hero renders are about to become
the free tier's background (Phase 7) and the picture a shared meme carries
(Phase 6). There is no way today to put six engines in front of David on the
same fact and the same prompt and let him pick, and no record of which engine
drew which stored image once the default changes.

## Direction

`PLAN_GET_TO_LAUNCH.md` v11, *Phase 8*, and the launch definition's "style
presets reviewed against the winning engine". This increment makes it true
that the default image engine per render mode was chosen blind by David from
the same prompts on this product's own facts, at a known price, with the
compiler and presets tuned to it, and that every stored render records the
engine that drew it.

## Product Intent

Verbatim from the oracle, *Product intent*:

> The default image engine for each render mode — text-to-image for the free
> hero renders, reference-photo editing for Legendary's face in the scene — is
> the one that looks best to David on this product's own facts, chosen blind
> from the same prompts, at a price Phase 11 can afford. The engines are also
> compared on three rendering styles people actually choose, so Phase 7 can
> offer styles that work. Presets and the compiler are then tuned to the
> winner(s).
>
> David's judging rule (2026-11-06): *"We're not really testing how well the
> engine interprets the prompt yet. Once I decide which engine looks good, we
> can tune it to better represent the prompt."* This round judges how the
> pictures look; prompt fidelity is the compiler tuning after the pick.

## Must Not Change

Verbatim from the oracle, *Must not change*:

> - The planner/compiler split and the Visual Concept as authoritative
>   (`visual-pipeline.md`).
> - The hard gate that a fact goes live only with approved hero renders
>   (`launch-definition.md`).
> - The paid-run budget: $5 a run, $25 a week, above it asks first, every run
>   reported with its cost (`uat-doc-format.md`, *Lanes*; `decisions.md`,
>   2026-10-17 and 2026-10-21).
> - AI-generated images are checked by David; Claude reads them only for
>   verifiable facts (`decisions.md`, 2026-10-17).
> - The default reference faces stay David's and his wife's (`decisions.md`,
>   2026-10-17).
> - No new vendors without David (`launch-definition.md`, *Must not change*).

Added by this plan, from the code it inspected:

- A stored render's attribution never changes when the default engine
  changes: an attempt records the engine that drew it, and nothing derives
  that from today's configuration.
- The Runtime Compiled Prompt preview and the runtime stay one path
  (`assembleImagePromptForPreview` → `generateImagePromptPlan` +
  `compileForSubjectRenderMode`); the evaluation uses that path to prepare
  panels and adds no second prompt channel.
- Moderation's required-scenario policy is unchanged; the evaluation selects
  its own five scenarios explicitly.
- No evaluation image enters a fact's shared image set.

## Settled Decisions

From the oracle, *Settled, David's (2026-11-06)*, verbatim:

> - Phase 8 builds first (8 → 7 → 6); its wait on Phase 11 replaced by the
>   budget rule.
> - A winner per mode, decided from the same panels.
> - The shortlist of five plus the control, as listed.
> - Three facts, which David names and sets up on dev; fifteen panels in round
>   1 and eighteen in round 2; the optional third round.
> - The judging rule: look now, prompt fidelity after the pick.
> - The three styles, chosen on the research David asked for (anime; 3D
>   cartoon / toy figure; caricature), with painting the runner-up not chosen.
> - The style-catalogue alignment filed as Issue #888 for Phase 7.

Technical decisions taken in planning (ours; the scope exchange's reasoning
is on the ledger, `.agents/reviews/phase8-engine-evaluation/concerns.json`):

- **The comparison unit is a frozen panel** (ledger C1). The planner runs at
  temperature 0.4 (`imagePrompt/generator.ts:42`), so "the same compiled
  prompt" has to be prepared once per fact–scenario–style and stored, then
  rendered through every engine. A panel freezes the planner output, the
  compiled prompt, the reference identity type and asset version, and the
  resolved style snapshot. Cells are panel × engine.
- **Round 2's single human scenario is `i2i_male_default`**, because its
  reference is David's own face and he is the strongest judge of that
  likeness. Round 2 is therefore 3 facts × {`generic_t2i`,
  `i2i_male_default`} × 3 styles × 6 engines = 108 cells, 18 panels.
- **One request builder maps purpose, aspect ratio and engine to settings
  the endpoint supports** (ledger C5). Purposes are `comparison`, `preview`
  (ephemeral moderation renders) and `final`. Each engine definition declares
  its size vocabulary (Nano Banana's `0.5K`–`4K` tokens, GPT Image's pixel
  dimensions, FLUX 3's named squares and `1k`–`4k`, and so on) and the
  builder picks, per purpose, the supported setting nearest the intent: about
  one megapixel for `comparison`, the engine's smallest supported size for
  `preview` (which is `0.5K` on Nano Banana 2 and `1K` on 2.1, since 2.1 has
  no 0.5K), and about four megapixels for `final`. The effective settings are
  recorded on the attempt and are what costing prices. Today's
  `pickRenderResolution` (`imagePromptJobs.ts:83`) is the Nano Banana 2 case
  of this and goes. Preview and runtime select any compiler adaptation
  through the same engine and mode selection, so adopting a winner changes
  ordinary moderation renders correctly, not only the comparison.
- **The engine per mode is two admin-config keys**, `image_engine_t2i` and
  `image_engine_i2i`, validated at write and at read against the catalogue
  (an active engine of kind `image` whose `imageMode` matches). They exist
  because routing is per mode and the engines table's one `isDefault` per
  kind cannot say two things; boot reconciliation preserves admin-owned
  `isDefault` (`reconcile.ts`), so that was never the reason. The admin
  engines screen's "set default" for an image engine writes the key for
  that engine's mode, so there is one authority; `isDefault` per kind stays
  for `llm` and `utility` and is ignored for `image`.
- **Routing is resolved once, at attempt construction, and stored** (ledger
  C2). The attempt's own hash and its worker execution use the stored
  selection; historical signatures and diagnostics read it. The hash that
  says what moderation would render *now* (`computeScenarioInputHash`)
  includes the current key for the scenario's mode, so changing a default
  makes an old attempt stale without changing what it says drew it. An
  attempt queued under engine A before the key changes to B still renders
  through A and reads as stale; the next attempt uses B.
- **Each candidate is a pair of engine definitions**, text-to-image and
  edit, with `imageMode` on the definition. The evaluation pairs them by a
  shared `family` field so a per-mode winner is a family's half, never an
  orphan.
- **Attribution is a column.** `image_prompt_attempts.actual_image_engine_id`
  is written at construction and backfilled for every existing row from its
  generation mode (`nano-banana-2` / `nano-banana-2-edit`, the only values
  history can hold); the signature and diagnostics read the column. The
  migration is forward-only: once any non-control engine has rendered, the
  column holds facts nothing else can reconstruct.
- **The affected-surface inventory for the hard-coded engine**:
  `git grep -nE '"nano-banana-2(-edit)?"' artifacts/api-server/src --
  ':!**/__tests__/**' ':!**/engines/**'` returns `imagePromptJobs.ts:327`
  and `factRenderScenarios.ts:74`; both become reads of the resolver. The
  engine definition files and their tests keep the literal ids, as they
  should.
- **Spend is bounded before dispatch, by reservation, not estimated after**
  (ledger C3; Astra's replacement design, taken). A comparison set spans
  several budgeted runs. Each run names its cells and records their frozen
  request settings, the planner preparation it needs and the paid attempts
  it permits; before any planner or fal call its conservative bound must fit
  the per-run allowance, and I confirm it fits the week's remaining budget
  from the fleet paid-run ledger (the app does not read GitHub). The bound
  is a reservation held per call until billing settles it, reusing the
  paid-run recorder's `Allowance` policy (reserve, settle, refuse on an
  unknown price) over database rows rather than its in-memory store, and
  recording the real billed amount rather than clipping it to the
  reservation as the recorder does. Queue retries are off for the comparison queue (its
  `async_job_<queue>_max_attempts` is 1), and comparison calls go through a
  single-submission transport of our own that keeps the SDK's status and
  result polling but submits once (the installed `@fal-ai/client` 1.9.5
  retries queue submission three times regardless of client configuration,
  `src/queue.js:34`, `src/request.js:59`), so one permitted attempt is one
  priced call; a
  manual re-run of a cell goes through admission again. A storage failure
  after a successful generation never buys a second image: the cell keeps
  the vendor's result URL and the retry is storage-only. A failed or
  ambiguous paid call keeps its reservation until billing establishes
  otherwise. Resuming an interrupted run cannot reset what is already
  committed, because reservations are rows, not memory.
- **Every candidate carries a complete per-call bound, with its evidence,
  and an engine without one is not dispatched to** (ledger C3, round 2).
  `falCallPrice` prices per-image, per-request and per-megapixel units
  today; the token-billed candidates get a `tokens` price model on the
  definition that names each billable component, its documented ceiling and
  the source. Rates and sample bills alone are not evidence of a maximum.
  The bounds for the shortlist at the frozen comparison settings (about one
  megapixel, one output image, a compiled prompt bounded at 4,000 text
  tokens, one reference image of at most 3840×2160 on the edit side), all
  read on 2026-11-06:
  - **Nano Banana 2.1** (fal: input $1.764/M, text and thinking output
    $8.823/M, image output $35.294/M). Google's model page for
    `gemini-nano-banana-2.1` documents, model-specifically, **1,120 tokens
    per input image**, **1,120 output tokens per 1K output image** (1,680 at
    2K, 3,780 at 4K) and a **maximum of 32,768 output tokens**. So: image
    output $0.0395; prompt 4,000 × $1.764/M = $0.007; one reference image
    $0.002; thinking and any text, at most the output limit less the image,
    31,648 × $8.823/M = $0.279. Complete bound per call: **$0.34**, against
    fal's measured $0.0396 to $0.049. The comparison runs `thinking_level:
    medium`, the engine's documented default (ledger C7); the ceiling covers
    it whatever it spends.
  - **GPT Image 2.5 Sunburst, high quality** (fal: text input $5/M, image
    input $8/M, image output $30/M, **no charge for text output**, totals
    rounded up to $0.0001; OpenAI's model page: "Text output is not billed
    because this model outputs images, not text"). Image output tokens are a
    vendor constant per model, quality and size: OpenAI's own calculator,
    read on 2026-11-06 with the model set to GPT Image 2.5 (Sunburst and
    Flare) at 1024×1024, gives **low 196, medium 439, high 1,756, xhigh
    3,122, max 7,024** output tokens, so high is **$0.05268**, which is the
    figure fal's billed matrix shows to the cent. The prompt adds at most
    4,000 × $5/M = $0.02. The reference image is the one component OpenAI
    publishes no rule for on the GPT Image models (its vision calculator
    excludes them): the request builder resizes every reference to at most
    1024 on the long edge before upload, fal's billed figure for that size
    is about $0.008, measured, and the reservation is twice it, $0.016.
    **That is a padded measurement, not a documented maximum**, and the
    plan does not call it one: text-to-image has a complete bound of
    **$0.073**; the edit reservation of **$0.089** rests on the measured
    reference charge, and David's acceptance of that is **D2**. 2.5 exposes
    no reasoning parameter on fal. As a check on the measured component, the
    first GPT cell to dispatch in each run is an **edit cell with a frozen
    comparison reference**, it settles before any other GPT cell dispatches,
    and a settled bill above its reservation halts the run; that limits what
    follows an overrun and cannot undo the charge already incurred.
  - **GPT Image 2.6** adds `reasoning_effort`, which fal bills as text
    output at $10/M with no documented ceiling, and OpenAI documents none.
    Fal publishes its rates, so its price has settled in the ordinary sense;
    what cannot be done is admitting a 2.6 call under the bound this plan
    requires. Whether 2.5 stands in for it is therefore **D2**, David's, in
    *Questions for David*, not a reading of the oracle (ledger C6).
  - **FLUX 3 Image**: $0.048 per image at 1K, "one flat price per image,
    whatever the number of references": **$0.048**. **Seedream 5.0 Pro**:
    $0.0675 per image up to 1536², edit plus $0.0045 per extra input,
    marked tentative on fal, so it is re-read on the day: **$0.072**. **Meta
    Muse Image**: $0.01 per image: **$0.01**. **Nano Banana 2** (control):
    $0.08 per image at 1K: **$0.08**.
  - **Planner preparation is priced from the request as it is actually
    built** (ledger C3, round 3). The planner call sends `gpt-5.5`
    `max_completion_tokens` of 10,800 (`IMAGE_PROMPT_MAX_TOKENS` 2,800 plus
    `REASONING_TOKEN_HEADROOM` 8,000, `openaiChatParams.ts`), so its output
    bound at the recorder's $30/M is **$0.324**; its input (system prompt,
    schema and user message) is bounded at 8,000 tokens × $5/M = $0.04;
    and the generator makes one corrective call on a validation failure, so
    a panel's preparation reserves two calls: **$0.73 a panel**, against a
    realistic $0.10. Comparison planner calls use an OpenAI client built
    with `maxRetries: 0` (the ordinary client keeps the SDK's defaults; only
    the recorder's is built that way today, `aiClients.ts:62`), and each
    call, the corrective one included, passes admission.
  - **Weekly admission counts settled charges plus unresolved worst-case
    reservations**, as the standing rule counts an unrecorded cost at its
    worst case; settlement releases what a call did not spend. The fleet
    ledger stays the record and I read and write it; nothing new is built
    for the week.
  Worked calculation, round 1 (15 panels, 15 cells per engine): preparation
  $10.95 in three batches; GPT 2.5 $1.33; Nano Banana 2.1 $5.10 in two
  batches; FLUX 3 $0.72; Seedream $1.08; Muse $0.15; control $1.20:
  **$20.5 reserved across about seven runs**, against an expected bill near
  $5.50. Round 2 (18 panels) reserves about $24.7 across about eight runs
  against an expected bill near $6.50. No run reserves more than the $5
  allowance, runs are sequential so reservations never stack, and the week's
  expected total, about $12, is under $25 with the unresolved worst case of
  one in-flight run on top. Prices are refreshed from the pricing cache and
  these pages before each run; a change above any figure here re-runs
  admission, not the plan.
- **GPT Image 2.6 replaces 2.5 when its price for our settings is
  established**, and on nothing else (ledger C6; the earlier "twice the
  price" rule was mine, not the oracle's, and is withdrawn). Established
  means fal's published figures for the text and edit requests at our frozen
  settings, or one budgeted probe render of each under the admission rule.
  Whether 2.6 then fits a run is the admission bound's answer; if it cannot
  fit the per-run allowance at any batch size, that is a question for David
  at that moment, not a rule written now.
- **Nano Banana 2 is not deprecated** (Google's deprecation table, read
  2026-11-06: `gemini-3.1-flash-image`, released 2026-05-28, "No shutdown
  date announced"; only the preview was shut down). What remains is one
  check that `fal-ai/nano-banana-2` is served by the stable model, read from
  fal's documented mapping or confirmed with fal; the render response carries
  no model-version field, so it cannot be the evidence.
- **K4 is a deployed-state check, not a mechanism.** `openai-general`
  already declares `kind: llm, isDefault: true, isActive: true`; increment
  1's post-merge verification reads the deployed `engines` table and repairs
  the row if boot reconciliation did not.
- **K13 is scoped**: the pricing warm-up filters to fal-hosted endpoints by
  endpoint-id shape, not by `provider` (fal hosts OpenAI's image endpoints
  under `openai/…`, and the direct OpenAI LLM ids are the ones to skip), and
  paces its requests; it does not become a request pricer.
- **The legacy AI-background producer is retired with FLUX Pro v1.1**
  (ledger C4): `POST /admin/facts/backfill-ai-memes`, `aiMemeBackfillJobs`
  and `generateAiMemeBackgrounds` go, because removing the catalogue entry
  alone leaves a reachable producer that defaults to
  `fal-ai/flux-pro/v1.1` with the legacy scene-prompt path. Two more
  things are part of the same removal: Taxonomy Health's bulk "Backfill AI
  memes" control and its hook go with the route, and the FLUX rows in the
  `engines` table are marked **retired** by migration, a code-owned state
  distinct from soft-deleted: a retired engine cannot be restored from the
  archived card, cannot be loaded by the bench's test route, and cannot be
  selected by the resolver, while its row stays for attribution.
  Soft-deletion alone would not do, because the archived card offers Restore
  and the bench loads any row by id (`adminEngines.ts:456` and `:782`). The `facts.ai_meme_images` column and its readers
  stay for Phase 7's asset model to dispose of.
- **The three styles are look-style rows**, with `anime` as it is and two
  new rows, `3d-cartoon` and `caricature`, each with a prompt suffix within
  the compiler's 180-character RENDER STYLE bound and no preview image yet
  (Phase 7's picker owns previews).

## Repo Context Inspected

- `artifacts/api-server/src/lib/imagePromptJobs.ts` (the worker; engine
  chosen at 327; `pickRenderResolution` at 83), `lib/factRenderScenarios.ts`
  (`actualImageEngineIdForGenerationMode` at 73; the scenario hash inputs),
  `lib/reviewRenderScenarios.ts`, `lib/defaultReferenceResolver.ts` (the four
  default reference assets, all present on disk), `lib/engineInterpreter.ts`
  (`loadDefaultEngine(kind)`), `lib/engines/*` (the code-first catalogue,
  `reconcile.ts`, the Nano Banana 2 definition's `paramSchema`),
  `lib/eval/evalRunJobs.ts`, `lib/eval/signature.ts`, `lib/eval/dashboard.ts`,
  `routes/eval.ts`, `lib/falPricing.ts` and `index.ts:117-135`,
  `lib/imagePrompt/generator.ts` (temperature), `lib/imagePrompt/styleResolution.ts`
  (the 180-character bound), `lib/imagePrompt/compilers/nanoBanana2.ts`,
  `lib/aiMemePipeline.ts`, `lib/aiMemeBackfillJobs.ts`, `routes/admin.ts:2179`.
- `lib/api-zod/src/eval.ts` (`evalRunCreateSchema = { label }`),
  `lib/api-zod/src/renderScenarios.ts` (the five keys),
  `lib/api-zod/src/imagePromptGeneration.ts` (subject render modes).
- `lib/db/src/schema/engines.ts`, `imagePromptAttempts.ts`, `evalRuns.ts`,
  `lookStyles.ts`; migration `0057` (the seeded look styles; nineteen active
  on the test database).
- `artifacts/overhype-me/src/pages/admin/evalDashboard.tsx` (301 lines;
  shows `actualImageEngineId` beside each image).
- `docs/ai-context/visual-pipeline.md`, `moderation-workflow.md`
  (*Test renders, the hero gate*), `overlay-declarations.md`,
  `known-failure-patterns.md`, `decisions.md` (2026-10-17 paid runs,
  reference faces, image checks), `docs/tests/uat-doc-format.md` (*Lanes*),
  `docs/engineering/migrations-and-backfills.md`.
- The two surveys on Issue #887 (engines; styles), and the fal and Google
  pages re-read on 2026-11-06 for the prices and the deprecation table.

## Current Behavior

- The worker picks the engine by string in two places; the catalogue's
  `isDefault` is read for `llm` and `utility` and not for image generation.
- An eval run re-renders every active golden fact across the approval-required
  scenarios with no style, through the planner each time; its request body is
  a label. Attempts carry no engine; the dashboard and signatures derive one
  from the generation mode at read time.
- The compiler is Nano Banana 2's labeled contract; the look style's suffix is
  its RENDER STYLE section.
- Ephemeral moderation and eval renders are forced to 0.5K.
- The pricing warm-up fetches a price for every catalogue endpoint, OpenAI
  model ids included, one request each, at boot and hourly.
- `POST /admin/facts/backfill-ai-memes` still runs the legacy FLUX Pro v1.1
  scene-prompt pipeline.
- The default reference assets for all four identity types exist on disk;
  the male one is David's photo.

## Source-of-Truth Analysis

- **Which engine draws a render:** today, two string literals. After: the two
  admin-config keys for the product, an explicit engine per evaluation cell,
  and the attempt row for history. No other place answers it.
- **What was asked of the engine:** the panel's frozen compiled prompt, which
  is the same `compileForSubjectRenderMode` output the runtime produces; no
  second prompt channel.
- **The Visual Concept:** stays authoritative; the planner realises it and
  the compiler owns the operational sections, unchanged.
- **The style:** the look-style row's suffix, resolved once per panel and
  frozen into it (the existing resolved-style snapshot).
- **Prices:** the fal pricing cache, as today, read for the estimate; the
  billed amount per cell is what fal reports.
- **The pick:** one row per panel in the picks table; the winner per mode is
  derived from picks in the results view and written to `decisions.md` by
  hand with the tallies. The app never computes a "winner" field.

## Proposed Design

**A. Engine routing.** `resolveImageEngine(mode, override?)` returns an
active `image` engine whose `imageMode` is the mode: the override when a
caller names one (the evaluation), else the admin-config key's engine. The
worker and the scenario hash call it; the two literals go. Candidate
definitions are added as pairs sharing a `family`; they are `isActive: true`
for the resolver and the admin engines screen but carry
`tierRequirement: legendary` and are never offered to users by anything
outside the evaluation, which is the same posture the current non-default
engines already have.

**A2. Request construction.** The request builder above sits between the
compiled prompt and the interpreter: purpose, aspect ratio and engine in,
supported endpoint settings out, recorded on the attempt.

**B. Attribution.** The attempt row records `actualImageEngineId` at
construction. Signatures and moderation diagnostics read it; the attempt's
own input hash is computed from it at construction. The backfill is a forward-only migration that sets the column from
`generation_mode` and then makes it `NOT NULL`.

**C. The comparison set.** A `comparison set` names its facts, scenarios,
styles and engines; `panels` are prepared from it (planner + compiler once per
fact–scenario–style, frozen); `cells` are panel × engine with a state
(`expected`, `enqueued`, `rendered`, `failed`, `skipped` with reason); a
`pick` is one per panel. A cell that fails keeps its panel inputs and can be
re-run once, through admission; a cell skipped before dispatch (missing
reference, invalid enrichment) stays visible in the denominator. A panel is
judgeable only when all six of its cells have a stored image; an incomplete
panel stays visibly outstanding, and a candidate that cannot be rendered at
all is a scope question for David, never a silently smaller comparison. Each cell renders through the
ordinary worker path with the panel's compiled prompt supplied as-is (no
re-planning) and the cell's engine as the override, at that engine's 1K and
the frozen request settings.

**D. Admission and cost.** Starting a run computes the estimate from the
pricing cache and the frozen settings and refuses above the per-run budget
with the figure shown; the run records estimate, per-cell billed cost where
reported, and the total. The results view shows cost per engine beside the
picks, so the price is part of what David sees.

**E. Blind judging.** A separate admin page: one panel at a time, the six
images in a persisted shuffled order under opaque cell ids, "best" plus a
per-image "not the person" mark on human-reference panels, progress across
the round, and no engine-identifying text, filename or tooltip. The results
page reveals engines, tallies per mode (text-to-image panels; reference
panels), per style and per scenario, with the face marks and the costs.

**F. The look styles.** Two new rows seeded by migration; the stylisation
round reads them through the existing resolver.

**G. Adoption.** The admin-config keys set to the winners; the compiler
adapted to the winning family with the preview path unchanged; presets
re-reviewed against it (the suffixes of the styles kept); FLUX Pro v1.1,
FLUX.2 Pro and the legacy producer removed; `visual-pipeline.md`, the
`overhype-visual-pipeline` skill (which names Nano Banana 2 as the render
path) and `glossary.md` swept, never patched.

## Data Model and Migration Impact

Forward-only, numbered after the last merged migration at build time.

1. `image_prompt_attempts.actual_image_engine_id varchar(64)`: add nullable;
   backfill `nano-banana-2-edit` where `generation_mode = 'i2i'` else
   `nano-banana-2`; set `NOT NULL`. Idempotent (the update is keyed on
   `IS NULL`); forward-only, since after the first non-control render the
   column holds facts nothing else can reconstruct. Row states: old rows → backfilled; new rows → written
   at construction; no partial state because the backfill and the constraint
   are one migration.
2. `engines`: `image_mode varchar(4)` (`t2i` | `i2i` | null), `family
   varchar(64)`, `price_model jsonb` and `size_vocabulary jsonb`, plus
   `retired boolean`, all code-owned and reconciled from the catalogue at
   boot; no data migration beyond the column adds. The FLUX rows are marked
   retired in increment 4.
2b. `image_prompt_attempts.request_settings jsonb`: the effective endpoint
   settings the builder chose; null for rows older than the column.
2c. `comparison_reservations`: one row per permitted paid call (planner or
   fal) with its bound, its settled amount and its state, so admission and
   resume read rows.
3. `comparison_sets`, `comparison_panels`, `comparison_cells`,
   `comparison_picks`: new tables, admin-only writers, cascading from the set.
   A cell references its attempt; a pick references its panel and the picked
   cell, plus `face_mismatch_cell_ids`, `judged_by`, `judged_at`. A panel's
   shuffle seed is stored so the blind order is stable across reloads.
4. `look_styles`: insert `3d-cartoon` and `caricature`, `ON CONFLICT DO
   NOTHING`, suffixes under 180 characters (the seeded-catalogue test
   asserts the bound).
5. The admin-config keys `image_engine_t2i` and `image_engine_i2i` seeded to
   `nano-banana-2` and `nano-banana-2-edit`, so behaviour is unchanged until
   David's pick is applied.

Observability: each migration logs its counts (rows backfilled, rows
inserted). The `backfill-ai-memes` route's removal is code, not schema.

## Runtime Behavior

- Production and dev render exactly as before until the keys change; the
  only behavioural change at increment 1 is that the engine is read from
  config and recorded on the attempt.
- An evaluation run prepares its panels (planner calls, paid), then
  dispatches cells per engine in bounded batches; the eval worker lane is the
  existing one. A fal failure marks the cell `failed` with the error; one
  manual re-run is allowed per cell and counted.
- Blind judging records a pick per panel; a panel may be re-judged, which
  replaces the pick and keeps the previous one in the row's history field.
- Adoption changes the two keys; the next render anywhere uses the winner.
  Moderation's would-render-now hash includes the current key for the
  scenario's mode, so a render made under the old engine reads as stale
  rather than as current, and keeps saying which engine drew it.

## Admin/User UX Impact

Admin-only. The eval dashboard gains: a comparison-set creator (facts,
scenarios, styles, engines, round label; shows the estimate and refuses over
budget with the figure); a run status view with per-cell state and cost (the
async status at both altitudes: per cell, and the run's aggregate); the blind
judging page; the results page. The admin engines screen shows `imageMode`
and `family` and the two keys as the current defaults. No user-facing surface
changes in this phase.

## Security, Permissions, and Validation

Every new route is `requireAdmin`. Request bodies are zod schemas in
`lib/api-zod` (the generated index is not hand-edited; the allowlist in
`lib/api-spec/patch-generated.mjs` is extended). The engine override and the
admin-config keys are validated against the catalogue server-side; an unknown
or inactive engine is refused, never defaulted. The blind page's payload
carries no engine id, endpoint id or storage path that names the engine; the
image is served through the existing eval image route by attempt id. Paid
dispatch is refused in `CI` as today and above the per-run estimate.

## Testing Plan

Automated (CI):

- The resolver: the keys select the engine per mode; an override wins; an
  unknown, inactive or wrong-mode engine is refused.
- Attribution: a new attempt records its engine; the migration's backfill
  maps every historical row by mode; signatures and diagnostics read the
  column and never call the old helper (the helper is deleted, which is the
  construct); the would-render-now hash changes when the mode's key changes
  and the stored attribution does not.
- Panels: two cells of one panel carry byte-identical compiled prompts and
  identical reference and style snapshots; preparing a panel calls the planner
  exactly once.
- Cells: a missing reference leaves an `expected`/`skipped` cell in the
  run's denominator after reload; a re-run reuses the frozen inputs.
- Admission: a bound over the per-run allowance refuses before any planner
  or fal call (both clients are fakes that fail the test if called); the
  bound covers planner preparation and one permitted attempt per cell; a
  token-priced endpoint is bounded from its price model and an engine
  without one is refused; a storage failure after generation re-downloads
  and does not call fal again; a manual re-run passes admission again;
  killing a run mid-way and resuming it leaves the committed reservations
  in place; estimates and billed amounts are distinct fields; a planner
  corrective call passes admission and a planner submission happens once
  under a synthetic retryable transport failure; a run's first GPT cell
  settles before its second dispatches, and a settled bill above its
  reservation halts the run; weekly admission subtracts unresolved
  reservations as well as settled charges.
- Request construction: for each candidate pair, the builder's `preview`,
  `comparison` and `final` settings are values the endpoint's schema accepts
  (asserted against the definition's vocabulary); ordinary moderation renders
  succeed with different winners set for text-to-image and editing, both
  non-human scenarios included.
- Routing and staleness: an attempt queued under engine A, a key change to
  B, and a later attempt: the first renders through A and reads stale, the
  second uses B; the admin "set default" writes the key.
- The blind page itself, driven in a browser: pick, face mark, reload, and
  the pick survives; a panel with a missing cell cannot be picked.
- Blind view: the payload for a panel contains none of the set's engine ids,
  endpoint ids or labels (asserted against every string in the response);
  the shuffle is stable across two reads; a pick is recorded against the
  hidden cell and the results view reveals it.
- Look styles: the two rows resolve and their suffixes are under the bound.
- The legacy producer: the route and job are gone (a route-table test); a
  retired engine row cannot be restored, cannot be loaded by the bench's
  test route and is never returned by the resolver (the fal fake fails the
  test if reached); a comparison call submits exactly once under a synthetic
  retryable failure.
- Pricing warm-up: only fal endpoints are fetched; the fetches are paced.

UAT residue (David's judgement, by the lane rules):

1. The three facts are set up and read right in the panels' compiled prompts
   (human: whether each fact's scene is the one he meant).
2. Round 1 judging, fifteen panels (human: the pick, and the face marks).
3. Round 2 judging, eighteen panels (human).
4. The representative renders of the adopted winner(s) after compiler and
   preset tuning (human: whether they look the way the panels promised).

Everything else is `ci` or `scripted` (the deployed-state check for K4; the
price re-read before each run; fal's `nano-banana-2` model mapping).

## Implementation Steps

Four increments, each a PR in the standard loop; the schema increments take
the migration review; every increment is read against `visual-pipeline.md`.

1. **The engine becomes a parameter.** A (routing), A2 (the request
   builder), B (attribution), F (look styles), K13, K4's check, the
   candidate engine definitions as pairs with their price models and size
   vocabularies. No behaviour change for users. Post-merge verification: the
   deployed `engines` table shows one active default `llm` engine and the
   two keys at their seeded values.
2. **The comparison set and its runs.** C and D: tables, routes, the eval
   worker path with the engine override, the admission check, the run status
   view. Post-merge: a dry run with the fal fake on dev shows 33 panels and
   198 expected cells and a refused over-budget estimate.
3. **Blind judging and results.** E. Then the execution waits on David: he
   names and sets up the three facts; the pre-run checks (prices re-read,
   the nano-banana-2 mapping, the weekly ledger, and whether a 2.6
   reasoning ceiling has been published); round 1; round 2;
   the optional round 3; the winner(s) recorded in `decisions.md`.
4. **Adoption.** G: the keys, the compiler for the winning family, presets,
   the removals (definitions, retired rows, the legacy producer, the
   Taxonomy Health control), the prose sweep. Post-merge: a
   representative render per scenario on dev through the ordinary moderation
   path, for David's eyes.

## Risks and Mitigations

- **A candidate's parameter shape needs a new interpreter primitive** (GPT
  Image sizes are pixel dimensions, not ratios; Seedream and Muse differ
  again). Mitigation: each definition is written against fal's schema page
  and a definition test renders its mapping; a primitive is added where
  needed, which the engines schema comment already anticipates.
- **Prices move before the runs.** Mitigation: the estimate is computed at
  run start from the cache refreshed that hour, and the refusal is on the
  estimate, not on the plan's figures.
- **A frozen prompt written for Nano Banana 2 reads worse on another engine.**
  This is the judging rule by design: look now, fidelity after; the plan
  names it so a surprising result is read correctly.
- **Reference faces at 1K are small in frame**, and both identity papers note
  likeness degrades as the face shrinks. Mitigation: the face mark is per
  image, so David records it; the winner's Phase 7 renders are at 2K.
- **The weekly budget is read by an agent, not the app.** Mitigation: each
  run's cost is posted to the ledger in the same turn it finishes, and the
  per-run refusal is mechanical.

## Questions for David

1. **D1 — When does the dev catalogue receive its final hero renders?**
   Astra's view and mine agree: Phase 8 selects and adopts the engines,
   tunes the compiler and presets and verifies representative renders;
   the catalogue-wide hero re-render moves into Phase 7, after its hero-set,
   approval-minimum and aspect-ratio decisions, so the asset set is rendered
   once in the shape Phase 7 decides. Alternative: bring those three Phase 7
   decisions forward and keep the re-render here. This changes an explicit
   item of the agreed scope (increment 4), so it is yours.
   **Recommendation:** move it to Phase 7. Phase 7 follows immediately, so
   the finished background reaches you no later.

2. **D2 — The GPT candidate, and the one cost figure that is measured
   rather than guaranteed.** Two parts, one decision.
   - *Which GPT.* The oracle lets 2.6 replace 2.5 once its fal price
     settles. Fal does publish 2.6's rates, but it bills reasoning as text
     output with no documented ceiling, so no complete per-call bound
     exists and the admission rule would refuse every 2.6 call. Astra and I
     both recommend judging 2.5 Sunburst, with 2.6 admitted only if a
     reasoning ceiling is published before the runs. The consequence is to
     the shortlist, not the harness.
   - *The edit allowance.* GPT 2.5's text-to-image cost is fully bounded,
     from OpenAI's own calculator. Its edit cost adds the reference photo,
     and OpenAI publishes no rule for that charge on the GPT Image models;
     fal measures it at about $0.008 after we resize the photo, and the plan
     reserves twice that, checked on each run's first GPT edit before the
     rest dispatch, with a halt on any overrun. That is a limited empirical
     allowance for the comparison, not a guarantee that the charge stays
     inside the reservation or the budget; the realistic exposure is cents.
     Approving the plan accepts that one uncertainty in words. Without that
     acceptance the GPT edit cells wait for a documented bound, and the GPT
     family is judged on text-to-image only.
   **Recommendation:** 2.5 as the GPT candidate, and accept the edit
   allowance as described.

## Definition of Done

- The worker, the scenario hash and the evaluation read the engine from one
  resolver; no string literal names a render engine outside the engine
  definitions.
- Every attempt row carries the engine that drew it, history included.
- A comparison set of David's three facts has 33 panels and 198 cells, each
  panel's cells sharing one compiled prompt, and a run whose bound exceeds
  the allowance is refused before any planner or fal call.
- Ordinary moderation renders work with any candidate set as a mode's
  default, at a size that engine accepts.
- Thirty-three blind picks are recorded; the results view shows tallies per
  mode, style and scenario with face marks and cost per engine.
- The winner per mode is in `decisions.md` with the tallies and the costs,
  and the two keys point at it. The GPT candidate judged is the one D2
  settles.
- The compiler and presets are tuned to the winning family; FLUX Pro v1.1,
  FLUX.2 Pro and the legacy producer are gone; the docs and the skill name
  the new engine.
- D1 and D2 answered, D1's consequence carried into Phase 7's scope.
