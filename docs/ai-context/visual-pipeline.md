# Visual Pipeline

> How a fact becomes a rendered image. This is the subsystem most prone to
> agents reintroducing old mistakes — read this and the failure patterns before
> touching it. Primary code: `artifacts/api-server/src/lib/imagePrompt/` (planner
> + compiler), `imagePromptJobs.ts` (production), and `lib/api-zod/src/` schemas.
>
> **One image pipeline plans renders:** `imagePrompt/` + `imagePromptJobs.ts`.
> The Pexels stock-photo seeding path (`factImagePipeline.ts`) that used to be
> confused with it was deleted with Pexels in launch Phase 4, removal 6
> ([`docs/retired/pexels.md`](../retired/pexels.md)).

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
   (`generator.ts`'s `buildImagePromptUserMessage()`) and the **system** prompt
   (`imagePromptConfig.ts`'s `FACT_IMAGE_PROMPT_SYSTEM_DEFAULT`, key
   `fact_image_prompt_system`). Since Launch Phase 3's amendment 1 the six AI system
   prompts are **set in code** (`codeOwnedPrompts.ts`): every reader returns the
   constant, boot no longer seeds them, and the admin screen shows them read-only.
   Changing the copy is an edit to the constant in a reviewed PR; an `admin_config`
   row an older database still holds is ignored. This is one case of the general
   rule that AI call settings live in code ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)). (Before that, the rows were seeded
   `ON CONFLICT DO NOTHING` and a constant edit needed a DML migration too, which is
   why `0082` and `0084` exist.)
3. **Compiler** (`compileForSubjectRenderMode()`, Nano Banana 2) → the
   engine-specific `compiledPrompt`.
4. **Production** (`imagePromptJobs.ts`) renders via fal.ai through the engine
   recorded on the attempt, at the size the request builder chose, and persists
   the result (`imagePromptAttempts.ts`). See *Which engine draws a render*.

## The engine comparison (launch Phase 8)

The comparison that informs the launch engines is its own small model (its
outcome, GPT Image 2.6 for photoreal and Nano Banana 2.1 for styles,
provisional, is the [product strategy](./product-strategy.md#pictures-and-engines)),
beside the eval run rather than inside it (plan
`docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`, *Proposed Design* C and D).

- **A set is frozen at creation**: facts × scenarios × styles (`"none"` is no
  style) × engine families (`comparison_sets`). Each fact × scenario × style is
  a **panel** whose mode is its scenario's; each panel has one **cell** per
  family, the family's engine of that mode (`artifacts/api-server/src/lib/comparison/layout.ts`). A
  family that is not exactly one active, priced, sized engine per mode refuses
  the whole set with the reason; it is never dropped, since a silently smaller
  comparison is what the plan forbids. Round 1 is 15 panels and 90 cells,
  round 2 18 and 108 (`COMPARISON_ROUND_PRESETS`).
- **Pricing does not gate a comparison run** (David, 2026-11-07, *"Ignore
  pricing entirely. Doesn't matter right now."*; `decisions.md`). A run takes
  every pending item of its kind: no per-run allowance, no week figure, no
  reading of fal's bills, no first-edit gate. Each call is still priced at its
  worst case, as a record (`artifacts/api-server/src/lib/comparison/admission.ts`):
  a panel's preparation at two planner calls, each at the completion ceiling
  its request would send — taken from the planner call's own resolution
  (`resolveImagePromptLLMSettings`) and request-shaping rule
  (`chatModelTuningParams`) — plus 12,000 input tokens ($0.768 a panel on the
  shipped gpt-5.5 at 2,800 tokens); a cell at its engine's `perCallBoundUsd`.
  A planner fallback still refuses preparation, since it would be a different
  experiment.
- **Planning writes nothing**: `POST /api/admin/comparison/sets/:id/plan`
  returns the next run's items and their worst case, or "nothing left to do".
- **Starting a run is the one action that spends**
  (`POST /api/admin/comparison/sets/:id/runs`,
  `artifacts/api-server/src/lib/comparison/runs.ts`). Admission takes one
  advisory lock — so two starts can never both take the same pending item —
  re-reads the set, and writes one reservation row per call (the call's
  record: its worst case and, once submitted, its fal request id), marks each
  item in flight and queues it, all in one transaction. Paid comparison runs never run in CI, refused at
  admission and again at the transport's submission. The two queues
  (`comparison_prepare`, `comparison_render`) run each job at one attempt, on
  the bulk lane so a long run never holds up moderation or member renders.
- **Preparation** goes through the Runtime Compiled Prompt preview's own
  path (`resolveRenderReviewInput` → `assembleImagePromptForPreview`) with
  the scenario's default reference resized to 1024 pixels on the long edge
  (`resolveDefaultReferenceUrl(type, { maxEdgePx })`), and freezes the plan,
  the compiled prompt, the reference and the style on the panel. Its planner
  calls run inside `withoutLlmRetries` (`artifacts/api-server/src/lib/utilityLLM.ts`),
  so each permitted call, the corrective one included, is one submission. A
  planner that fell back to another model fails the panel: it is a different
  experiment. A failed panel can be prepared again; the next preparation run
  admits it.
- **A cell submits once** (`artifacts/api-server/src/lib/comparison/transport.ts`):
  one POST to fal's queue of our own — the SDK retries submission — with the
  request id stored before polling, so a resumed job polls and never
  resubmits. It does not go through the ordinary `image_generation` worker,
  whose `fal.subscribe` retries — but it builds its parameters and reads the
  vendor's answer with the worker's own functions
  (`artifacts/api-server/src/lib/imageEngineRequest.ts`), so it measures what
  production sends.
- **The record of each call**: a call that never reached a vendor is
  released. A completed call, planner or fal, is settled at its bound — no
  bill is read; fal's dashboard has what was actually billed. A call that
  failed after submission stays reserved, since it may have been billed. Each
  reservation records the fal request it was for, written with the cell's at
  submission; a re-run replaces the cell's id and never the reservation's. A
  storage failure keeps the vendor's URL and its retry stores that image
  again; a render failure gets one re-run, which the next render run takes.
- **A restart never repeats a paid call.** A panel is marked `planning`
  before its planner call, and a cell's request settings are written before
  its submission; a job that resumes to find the marker without a result
  fails as ambiguous and keeps its reservation, rather than calling again.
- **The Eval page** (`/admin/eval`; plan `docs/plans/PLAN_EVAL_PAGE.md`,
  approved 2026-11-13) has two tabs, *Evaluate Models* and *Evaluate
  Prompts* (`?tab=models|prompts`), each a wizard (`EvaluationWizard.tsx`):
  facts found by keyword among eligible ones (active, enrichment validates —
  `searchEligibleFacts`, the same predicate creation re-checks), the
  candidate engines (`EVALUATION_CANDIDATE_FAMILIES`: GPT Image 2.6, Nano
  Banana 2.1, Muse) or one engine's wording versions, photo types (male, pet,
  vehicle — `EVALUATION_PHOTO_TYPES`), looks, a description, then the image
  count, a typical cost beside the worst case (`estimateEvaluation`,
  read-only: scenes at the recorded planner token counts,
  `panelPreparationTypicalUsd`; pictures at the average fal billed per
  engine over its last 50 comparison pictures, its bound where none is
  billed), and one **Generate Images**. Every paid retry and Resume shows
  the most it could cost on its button (`NeedsAction.boundUsd`); Retry
  storage reads "free". `createEvaluation` (`artifacts/api-server/src/lib/comparison/evaluations.ts`) makes the
  set at comparison size and starts one `full` run; the wizard's request
  token makes a repeated press return the same evaluation. In a `full` run a
  picture is admitted and reserved with its scene and waits (cell state
  `waiting`); the transaction that records the scene prepared queues it, and
  a scene that fails or is skipped releases its waiting pictures back to
  `expected`. Retry scene and Retry picture start their work at once; Retry
  storage spends nothing. The evaluations list (`EvaluationsList.tsx`) shows
  each one's status derived from its rows (`progressOf`: generating, needs
  action with each retry, ready, judging, finished, nothing to judge), polls
  every 5 s while anything is in flight, and says "Connection lost" when a
  poll fails rather than that the server stopped. Judge results opens blind
  judging; its Finish button (server-checked: nothing in flight or
  retryable, every judgeable panel judged) opens the results. The old eval
  harness (golden set, eval runs, opportunistic ratings) is gone from the
  app; its tables wait for part 4's migration.
- **Blind judging** (`/admin/eval/judge/:setId`,
  `artifacts/api-server/src/lib/comparison/judging.ts`): one panel at a time,
  its images lettered A, B, C… in a shuffle that is stable across reloads. Each
  image is addressed by an opaque token — a hash of the panel's stored shuffle
  seed and the cell id, the seed never leaving the server — and served by
  `GET /api/admin/comparison/panels/:id/images/:token` with only its content
  type, so neither the payload nor the image names an engine, endpoint, cell
  or storage path. **Every image is scored 1 to 5** (David, 2026-11-10,
  `decisions.md`, in place of picking the best one). A reference panel shows
  its source photo beside the pictures (`BlindPanel.reference`, the panel's
  stored `reference_image_url`, the same for every engine), so a likeness is
  judged against the face each engine was given (David, 2026-11-10). Every
  prepared panel also shows, collapsed, the prompt every engine was sent word
  for word (`BlindPanel.prompt`, from the frozen `compiled_prompt`), so
  faithfulness to it can be judged too (David, 2026-11-10). A panel is judgeable once
  every cell is settled — it has a stored image or is lost for good (failed
  after its one re-run with nothing kept at the vendor, or skipped) — and at
  least one image exists; until then it shows how many are in and none of
  them, and says why it waits (`panelWait`): still rendering (the page polls
  every 5 s), or needing action on the comparison screen (a re-run or
  re-preparation left). A lost image does not hold its panel back: it is shown
  as missing, naming no engine, and the others are scored; a panel whose
  every image is lost has nothing to score, counts in every total and is
  never shown as work in progress. A panel skipped at preparation stays listed
  with its reason. Saving needs a score for every image shown; on panels with
  a person's reference photo David also marks any face that is not the person
  (`comparison_picks.ratings`, one row per panel); re-judging replaces the
  scores and keeps the previous ones in the row's `history`.
- **Results** (`/admin/eval/results?sets=…`, `GET
  /api/admin/comparison/results?setIds=…`) reveal the engines, across one or
  more sets so rounds 1 and 2 read together: each family's average score by
  mode (the leader of text-to-image and of reference edit, ties shown), by
  style and by scenario; how many of each engine's images were lost for good
  on judged panels, each counting as a 1 in its averages (David, 2026-11-10);
  each engine's median and slowest time per picture, from its request reaching
  fal to the picture coming back (`comparison_cells.submitted_at` and
  `completed_at`, migration 0128; shown only here, never on the blind page);
  the "not the person" marks against the
  human-reference panels judged; and each engine's calls with their worst
  case. It is stage 2 of judging (David, 2026-11-10, `decisions.md`): each
  mode's engines are ranked by average score, equal averages sharing a rank,
  with the price of one image beside them (`perImagePrice` in
  `artifacts/api-server/src/lib/engines/types.ts`) — exact for a flat price,
  "about" for a token price (`typicalUsdPerImage` on the definition, within
  about 10%), both at the comparison's size of about 1 megapixel. The judging
  page itself shows no price.
- **The second judging edition** (the prompt tuner, part 1; plan
  `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* B and C; migration
  0133). The two bullets above describe **edition 1**, which every set made
  before 2026-11-12 keeps (`comparison_sets.judging_edition` = 1); every set
  made since is edition 2. An edition-2 panel shows the fact's wording and its
  approved visual gag as they were **frozen at preparation**
  (`comparison_panels.frozen_fact_text`, `frozen_gag`), never the live fact row
  and **never the prompt**: it is judged against the gag, not the wording
  being tuned. Each picture is scored 1 to 5 on the categories the panel asks
  (`JUDGING_CATEGORIES` in `lib/api-zod/src/engineComparison.ts`, with David's
  words as help text): Visual quality, Gag fidelity and Realism always; Style
  interpretation on a styled panel; **Likeness** on any panel whose engines were
  given a photo, person, pet or object (David, 2026-11-12). Each panel also
  gets one overall pick ("which would you send to a friend?",
  `comparison_picks.picked_cell_id`) and any picture can be marked **broken**
  (`broken_cell_ids`), replacing the face mark. The server refuses a partial
  judgement, a category the panel does not ask, a pick or mark naming a picture
  it did not show, and a judgement of the other edition's shape. Results
  (`getJudgedResults`) are per mode and engine: the **pick share** (judged
  panels on which its picture was the one to send, a picture lost for good
  staying in the denominator) as the headline, each category's average with a
  lost picture counting 1 (David, 2026-11-10), broken and lost counts, billed
  cost and time. No blended score is computed, and the results route refuses
  to read sets of the two editions together.
- **Prompt comparisons** (the prompt tuner, part 2; plan
  `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed Design* B and D; migration
  0135). A set's `kind` is `engine` (every set before this) or `prompt`: one
  engine family and two to four recipe versions (`recipe_version_ids`, 0 for
  the baseline). Its cells are panel × engine × version, unique on
  `(panel, engine, coalesce(recipe_version_id, 0))`. Preparation freezes the
  scene once per panel (`comparison_panels.compile_args`: the planner's output
  and the compiler's inputs), and each cell compiles that same scene with its
  own wording at render (`cellPromptText`), storing the exact prompt it sent
  (`comparison_cells.prompt_text`), so only the wording differs between a
  panel's pictures. An engine set's cells take each family's live version,
  frozen when the set is made. Panels prepared before 0135 keep drawing their
  one `compiled_prompt`. The admin creates a prompt set from *Compare: prompt
  wording on one engine* (person photos, about 1 megapixel by default, the
  live version against the newest preselected). Second-edition results group
  rows by engine **and version** (`recipeLabel`), add the same rows **by look**
  (`byLook`) and every picture with its exact prompt (`pictures`); on a prompt
  set each version has a **Promote** button, with the same confirmations as the
  editor.
- **Read-only dry run**: `artifacts/api-server/scripts/comparison-dry-run.ts`
  derives rounds 1 and 2 against a database's real catalogue and checks 33
  panels and 198 cells, reporting the worst case.
- **FLUX 3 is judged at `safety_tolerance` 3**, not fal's default 2: the same
  rank (second-most permissive) as the Nano Banana engines' 5 of 1–6, so the
  comparison judges its drawing, not a stricter filter.

## Image provenance: every picture traceable to how it was made

Image tracing (plan `docs/plans/PLAN_IMAGE_TRACING.md`; #905, increment 1
#907, increment 2 #912). Any picture that leaves the system leads back to a record of how it
came to exist. The rules a change here must keep:

- **One finishing step.** Every producer calls
  `artifacts/api-server/src/lib/provenance/records.ts` `finishImage` with the bytes it is about to
  store or send. It settles the true format from the bytes, stamps the
  opaque id into the file, hashes the final bytes and commits the record —
  only then are the bytes stored or sent. A picture with no committed
  record never leaves; a failure there fails the request.
- **The request is captured before the vendor is called.**
  `recordGenerationRequest` persists the exact input, the producer and the
  person who started it into `image_generation_requests` before
  submission; the vendor's request id is added when it returns. A recovery
  or a storage-only retry reads that row and never rebuilds the request
  from today's configuration.
- **Producers today:** the render worker (`imagePromptJobs.ts`: product,
  moderation and eval renders), the engine comparison (`comparison/runs.ts`),
and member uploads (`userImageUpload.ts`,
  recorded unstamped), and every composed meme — the bake on save and the
  backfill bake (`memeBake.ts` `renderTracedMeme`), the live render of an
  unbaked meme, and the builder's preview and download (`memeComposite.ts`
  `composeTracedMeme`) — through `artifacts/api-server/src/lib/provenance/meme.ts` `finishMeme`, which
  chains the meme's record to the record of the photo it was drawn on. A new
  producer joins by calling `finishImage`; the inventory oracles are in the
  plan's Settled Decision 10, and `imageProvenance.test.ts` fails a file that
  stores or calls the vendor without recording, or that calls one of the
  untraced meme-drawing functions (`generateMemeBuffer`, `composeMeme`,
  `renderMemeRecipe`) outside the two traced wrappers.
- **Every meme carries an invisible watermark of its record id**
  (`artifacts/api-server/src/lib/provenance/watermark.ts`): Adobe's TrustMark Q, run in the API process with
  `onnxruntime-node` from Adobe's own ONNX exports, committed under
  `artifacts/api-server/src/assets/trustmark/` and refused unless they match their pinned hashes. The
  100-bit payload (`watermarkPayload.ts`) is TrustMark's BCH_5 packet bit for bit — a 9-bit tag and the
  52-bit id — so Adobe's reference decoder reads our marks too. The id is drawn before the meme
  (`finishImage` takes it), marked into the canvas pixels before the JPEG is encoded, and then stamped
  in the metadata like any other picture. Two renders of one recipe are therefore the same drawing
  with different marks; the live render of an unbaked meme reuses its earlier record when the bytes
  come out identical, so a meme viewed a thousand times has one record. Measured for #912: the mark
  is invisible (43.7 dB PSNR, largest change 20 of 255), costs about 0.2–0.5 s per meme, and survives
  recompression, resizing to a thumbnail, WebP, repeated forwarding, an 8% trim, losing a quarter of
  one side, a blur, and a screenshot (bars are cut away); it does not survive losing the bottom third.
  The marker loads at start-up (about 140 MB of memory); the reader loads on the first trace (about
  200 MB more), since only admins trace.
- **What a file carries:** one XMP packet with `ovh:ProvenanceId` and, for an
  AI render, `ovh:Engine` — never settings or prompts. It is spliced into
  the container (PNG iTXt, JPEG APP1, WebP XMP chunk), so decoded pixels
  are byte-identical. Comparison pictures carry the id only, so blind
  judging stays blind.
- **A record holds everything that shaped its picture, frozen in** (the completeness audit, #912),
  so the id a picture carries leads to its whole configuration after every live row it came from is
  gone. An AI picture: the vendor input exactly as sent (`image_generation_requests.request`); the
  whole planning attempt — visual plan, compiled prompt with the planner's model and engine, source
  analysis and its hash, enrichment, identity policy, render controls, the size settings computed for
  the run (`snapshot.attempt`; a comparison picture's panel in `snapshot.panel`); what the vendor
  returned, its seed and safety flags (`snapshot.vendorResponse`); and a content fingerprint of every
  reference picture the request named, since the request names one only by a link that expires
  (`snapshot.referenceImages`, `artifacts/api-server/src/lib/provenance/vendorContext.ts`; one that could not be read says why).
  A meme: the words drawn and which of them in the name's colour (`captionRuns`), the fact template
  they came from, the identity, the style options, the layout, and its photo as the source record.
  Everything else that shapes a picture is code at the recorded commit — fonts, the drawing, the
  JPEG quality, the watermark models (pinned by hash), the library versions (the lockfile). What no
  record can hold: a change a vendor makes behind an unchanged endpoint; the vendor request id and
  reply are the trail there.
- **Who made it** comes from named sources (`artifacts/api-server/src/lib/provenance/attemptActor.ts`):
  a moderation render's admin from its review audit — the approving admin
  rides the render-preparation job's payload — an eval render's from its
  eval run, a comparison cell's from its run, a product render's member
  from the attempt. `"system"` only for genuinely unattended work. The
  record keeps the account id and its email at the time (David,
  2026-11-10).
- **Records outlive everything else.** Neither table has a foreign key;
  only the retention purge (`image_provenance.retention_days`, 0 = kept
  indefinitely) removes a record.
- **The code version is the commit** (`artifacts/api-server/src/lib/codeVersion.ts`): baked into the
  production bundle by `build.mjs` with its date and subject, read from git
  in dev; an unversioned run says so.
- **Engine output is saved and served under its true format** — the
  `ai-bg-v2/` and `comparison/` keys take the sniffed extension, and
  `/memes/ai-user/image` serves the stored content type.
- **The trace:** admin **Trace an image** (`/admin/trace`, API
  `/api/admin/provenance/trace`, `/trace-image` and `/images/:id`, admin-only) reads only
  records (a live row only finds a record), resolves the image links the admin
  and member screens show, returns every match, and labels legacy FLUX backfill images
  "legacy path, settings not recorded". Given the picture itself (a file, dropped or pasted),
  it tries all three of the id stamped in the metadata, the exact hash of the bytes, and the
  watermark, and shows every record any of them found and what each said — so a stamp and a
  watermark that disagree are both on screen.

## Frozen render inputs: identity + style (reproducibility)

**A render's identity and style are frozen ONCE, at the moment the user clicks
generate — never re-resolved live by the async worker (PR #223).** No live
path runs this step now: its only callers were the legacy studio's user
generate paths, deleted in launch Phase 4 with the freeze helper
`prepareImagePromptAttemptInputs()`
([`decisions.md`](./decisions.md#2026-10-22--the-legacy-meme-studio-is-deleted-the-user-generate-route-survives-photo-only-until-pulid-goes)). What
remains is the worker side, for attempt rows that carry snapshots. The helper
resolved a `PromptIdentitySnapshot` (`promptIdentity.ts`) and a
`ResolvedRenderStyleSnapshot` (`styleResolution.ts`), renders the fact text
from that SAME identity (so the frozen fact text and the compiler's later
token gate can never diverge), and persists both snapshots onto
`render_controls`. The `image_prompt_generation` worker reads the frozen
snapshots (`isValidPromptIdentitySnapshot` / `isValidRenderStyleSnapshot`)
instead of re-querying the user/style tables, falling back to live resolution
only for attempt rows that predate this change. Moderation/eval renders use fixed sample identities and no live
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

**The prompt ceiling is 10150 chars** (`MAX_PROMPT_CHARS`,
`compilers/nanoBanana2.ts`; raised from 4000 — PR #224 — to 6000, to 6900 to
fund the dedicated bubble pool, and to 10150 on 2026-11-12 so the prompt
tuner's editable wording has room, all David-approved). It is our own
ceiling, not the engines': GPT Image 2.6 accepts 32,000 characters and Nano
Banana 2.1 50,000 (fal schemas, read 2026-11-12). The budget is
split into five reserves, derived from a **measurement of the real
compiler**, not invented numbers — `measureRequiredPromptBudget()`,
`measureModeratorAdditionsEmission()`, and `measureBubbleDirectivesEmission()`
(`imagePrompt/promptBudget.ts`) compile maximum-fixed-shape prompts through
the actual compiler and a proof test asserts the split still fits:

```
10150 = FIXED_REQUIRED_RESERVE_BUDGET (5000: today's wording measures 1704;
                                      the rest is room for tuner versions)
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

`tier2Heuristics.ts` suggests the mode from image analysis; the admin engine
bench sets it from the bench instead (`image-to-image` → `human_identity_i2i`,
otherwise `t2i_fallback`; `routes/adminEngines.ts`).
`generationModeFromSubjectRenderMode` maps
`t2i_fallback → "t2i"`, everything else → `"i2i"`.

## Which engine draws a render

Launch Phase 8, increment 1 (plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`,
*Proposed Design* A, A2 and B). Until it, the worker chose `nano-banana-2` or
`nano-banana-2-edit` by string. Now:

- **The engine per mode is set in code**, `IMAGE_ENGINE_IDS` in
  `lib/imageEngineRouting.ts` ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)): `nano-banana-2` and
  `nano-banana-2-edit`. The `image_engine_t2i` and `image_engine_i2i` rows
  migration 0123 seeded are no longer read, and the generic config route
  refuses them. No engine row's `isDefault` flag routes anything.
- **An attempt records its engine once, at construction**, in
  `image_prompt_attempts.actual_image_engine_id`, and the worker renders through
  that engine, never through today's default: an attempt queued before a
  default changed still renders through the engine it was made for. Signatures,
  the eval dashboard and moderation diagnostics read the column
  (`attemptImageEngineId`). A null appears only on a row an older release wrote
  after 0123 ran; such a release routed by mode alone, so the null reads as that
  release's engine. A later contract migration makes the column `NOT NULL`.
- **The moderation hash folds in the engine a render would use now**, read once
  per review context (`currentImageEngineIds`), so changing a mode's default
  makes that mode's older attempts read stale while each keeps saying which
  engine drew it.
- **Every selection is validated, never defaulted**: an engine that is unknown,
  inactive, archived, retired, not an image engine, of the other mode, or
  without a size vocabulary is refused (`ImageEngineRoutingError`).
- **The request builder** (`lib/imageRequestBuilder.ts`) maps a purpose, an
  aspect and the engine to a size the endpoint itself accepts, from the
  engine definition's `sizeVocabulary`: `preview` (moderation and eval test
  renders) is the engine's smallest size, `comparison` the option nearest one
  megapixel, and `final` (a member's render) the option nearest four. On Nano
  Banana 2 that is 0.5K and 2K, as before; Nano Banana 2.1 has no 0.5K, so its
  preview is 1K. The chosen settings are stored on the attempt
  (`request_settings`).
- **The catalogue holds the Phase 8 candidates as pairs** sharing a `family`
  (one text-to-image, one edit): GPT Image 2.6 Sunburst at high reasoning (in
  place of 2.5, whose pair stays in the catalogue unused; David, 2026-11-10),
  Nano Banana 2.1, FLUX 3 Image, Seedream 5.0 Pro and Meta Muse Image, beside
  the Nano Banana 2 control.
  Each carries a `priceModel`, a complete per-call bound at the comparison
  settings with each component's source, and nothing routes to one until it
  becomes a mode's engine in `IMAGE_ENGINE_IDS`, a code change. The compiler is still Nano Banana 2's for
  every engine; adapting it to the two chosen engines is increment 4's.

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

**Activation is presence-based — there is no `enabled` field.** The override
object no longer carries an `enabled` boolean (retired). Every sub-field applies
on its own whenever it is non-empty; an override whose fields are all empty
compiles byte-identically to having no override at all (the keystone invariant —
every consumer no-ops on empty, verified in `nanoBanana2Compiler.test.ts`). Both
compiler-side gates were converted from `ov?.enabled` to a plain presence check
(`activeOverride()` in `nanoBanana2.ts`, `resolveRenderPolicy()` in
`imagePromptGeneration.ts`). Stored rows that still have a legacy `enabled` key
parse cleanly — Zod strips the unknown field — so no migration was needed.

**The Visual Concept (core scene) is REQUIRED, and the card is its single
editing surface.** The core-scene field was removed from the Advanced Options
`VisualStrategyOverridePanel`; the prominent `VisualConceptCard` is now the only
place it is edited, on both the Moderation Step-2 flow and the Facts page. A
blank `coreSceneOverride` **blocks admin save** (the enrichment PATCH and the
review-candidate PATCH reject it `400 visual_concept_required`) **and blocks
production approval** (`CONCEPT_MISSING` on the approve-visual-concept and
first-time/refresh production-approval paths). Rationale: the image
engines need a concrete scene to make a meme, so a fact can't be released
without one.

## Candidate Visual Concepts

**The gag writer (prompt version 3, plan `docs/plans/PLAN_GAG_GENERATOR.md`,
approved by David 2026-11-13).**
- **Engine and prompt.** The candidates are drafted by the `openai-gag-writer`
  engine row (GPT-6 Astra, medium effort since 2026-11-14: high took 100–211 s a call), selected today by
  `fact_visual_concepts_engine_id` (an `admin_config` key, and the effort an engine-row field: both known
  exceptions being moved into code, [decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)); migration 0137 pointed that setting there
  and kept the previous value as `fact_visual_concepts_engine_id_before_0137`.
  The render planner keeps its own row. The system prompt is the text David
  locked (`docs/plans/gag-prompt-LOCKED.md`); `gagWriter.test.ts` pins its
  sha256.
- **No fallback model.** An unusable engine fails the job at once
  (`gag_writer_engine_unusable`). The review screen still loads and shows the
  reason. Approving the gag still needs a successful generation.
- **The request** is built by
  `artifacts/api-server/src/lib/visualConcepts/generator.ts`
  (`buildVisualConceptsUserMessage`), not from the render planner's context
  blocks. It carries:
  - the caption rendered with the stand-in name "Alex" and they/them;
  - the approved humor note;
  - what references mean, in plain lines;
  - the joke mechanism;
  - the violence and text limits from `resolveRenderPolicy`;
  - the live fact's saved gag (during a refresh too, never the candidate's);
  - the moderator's draft with its bubbles.
- **The stand-in name.** The model writes "Alex". Every scene and bubble line
  is then converted by `tokenizePlainTextToTemplate` (`visual_strategy`,
  subject "Alex") before the validation below. A conversion that leaves
  "Alex", or a scene without the subject token, stores the gag unpickable,
  never naming "Alex".
- **The joke read and the humor note.** Each generation also returns a
  `jokeRead`, stored in the blob with the note it was written under.
  `facts.humor_note` (with who approved it and when) is written only by a
  moderator, through `PUT /admin/reviews/:id/humor-note`: That's right, or a
  correction.
- **Freshness.** The note is kept out of the input hash. A saved note that
  matches neither the note the gags were written under nor their own read
  marks them `humor_note_changed`. So confirming a read keeps its gags
  usable, and a correction asks for Regenerate.

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
A pick only replaces the scene + bubbles fields — so an unsaved draft edit to
any *other* field (role bindings, required details, …) would let a pick land
on a VSO shape the candidate's own preflight (below) never accounted for. The
gate gives clear copy ("Save or discard your current Visual Strategy
changes…") rather than silently risking that mismatch. Scene/bubble-only
dirtiness (typing in the Concept box, a previous pick) stays pickable — only
*other*-field drift blocks.
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
candidate is preflighted at generation time through
`validateVisualStrategyOverridePersistence(withCandidateConceptDraft(undefined, c))`
— **an empty/pool-independent base**, not the moderator's actual current VSO
(Codex P2, PR #231 doc-review) — so "pickable" proves the candidate's own
scene+bubbles fit their own pools **in isolation**, never that the eventual
*combined* save will succeed. The real, authoritative gate is the **same**
validator running again at actual Save time (`admin.ts`/`reviews.ts`, against
the full submitted override) — one function, two call sites, so there's no
second formula to drift, but a candidate marked pickable can still fail Save
if the rest of the VSO is already near its own budget ceiling. Future work
should not read "pickable" as removing the need for that final save-time
check. (History: the deployed system prompt was once migrated, 0090, because it
was read from an `admin_config` row that a boot seed never overwrote. The prompt
has been read from code since Launch Phase 3's amendment 1, and the row is
ignored; see the planner item's note on code-owned prompts, above.)

## Frontier visual planner

`generateImagePromptPlan()` (`imagePrompt/generator.ts`) calls OpenAI with strict
Structured Outputs. The engine is set in code ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)):
**`openai-visual-planner`** (`engines/openai-visual-planner.ts`,
`endpointId: "gpt-5.5"`, `kind: llm`, `tierRequirement: legendary`, high reasoning
effort, 180 s timeout).
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

### Prompt recipes: the compiler's global wording, versioned per engine

A named exception to the guideline that AI call settings default to code ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)): wording versions are stored and promoted in the database by design.

(The prompt tuner, part 2; plan `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed
Design* A and D; migration 0134.) Every piece of wording the compiler owns that
is **the same for every fact** is a named template in
`artifacts/api-server/src/lib/imagePrompt/recipe.ts`: the section labels, the
identity paragraphs (person photo, pet or object photo, no photo, and the
gender clause), the binding sentences, the do-nots and failure-mode lines, the
composition and caption-space sentences, the photoreal style line, the text and
violence policy lines, the balloon wording, and an **engine notes** piece,
empty by default, emitted as its own ENGINE NOTES section before RENDER STYLE
only when it has text. Fact-specific content — the Concept, the moderator's
sections, the planner's scene, a look's own text — is never a recipe's. A
recipe changes a line's wording, never when the compiler emits it, nor the
section order. Slots (`{subject}`, `{side}`…) are filled once; a version that
drops a required slot or names an unknown one is refused. **Policy pieces**
(`text.overlay`, `text.incidental`, `violence.*`) can be reworded but not
emptied.

- **The baseline is today's wording, byte for byte**: compiling with no recipe
  or `BASELINE_RECIPE` reproduces the 121-input corpus captured before the
  refactor (`__tests__/fixtures/compilerBaseline.json`; never regenerate it from
  the refactored compiler).
- **Versions** (`prompt_recipe_versions`) are per engine family, numbered,
  saved once and never edited; **promotions** (`prompt_recipe_promotions`) make
  one live, the newest per family winning, a null version restoring the
  baseline. A promotion that changes a policy line against the live wording is
  refused without `confirmPolicy`.
- **One resolver** (`recipeStore.ts`) serves every path: a render attempt
  records the live version for its routed engine **when it is queued**
  (`image_prompt_attempts.recipe_version_id`, null = baseline) and the worker
  compiles with that version, so a promotion never changes queued work; the
  admin prompt preview compiles with the routed engine's live version.
  Promotion changes wording only, never routing.
- **Moderation freshness**: `currentImageEngineIds()` carries each mode's live
  version, folded into the scenario hash **only when set** — recipe support alone
  leaves every existing moderation render current; a promotion for the engine a
  mode renders with makes that mode's renders read out of date (nothing
  re-renders on its own).
- **Budget**: a version is saved only if `recipeBudgetProblems` passes — its
  fixed wording at its longest (with a chosen look and with none), plus, for
  each group of conditional lines, the most they grow beyond the baseline
  (`RECIPE_PROBE_GROUPS`: every additions field once; the most balloons of one
  kind; a moderator Concept's label; each text policy; each violence policy;
  one-of-the-subject binding; the crowd, cause-and-effect and reversal lines
  together), fits `FIXED_REQUIRED_RESERVE_BUDGET`. Groups that can appear
  together are summed; alternatives within a group take the largest. Growth,
  not absolute length, is charged, so the baseline keeps its measured 1,704
  and its own conditional lines stay in the outer margin as before. The
  probes fill each slot with one character, so `recipeProblems` also refuses a
  slot filled with a fact's own text (`{guidance}`, `{text}`, `{items}`…) used
  more often than today's wording uses it; `{subject}` and `{gender}` are
  measured at their longest and may repeat (Codex, PR #926 round 2). With both,
  every Concept, addition and balloon already valid to save still fits. A
  per-piece sweep test (`promptRecipeBaseline.test.ts`) refuses a 1,000-character
  growth in every piece outside the trimmable sections, so a new piece no probe
  reaches fails CI (Codex, PR #926). The render-time overflow refusal stays.
- **Editor**: Admin → Eval → *Prompt wording* (`PromptRecipes.tsx`;
  `routes/adminPromptRecipes.ts`): per family, every piece editable, save with a
  note, preview the whole prompt on a fact's latest stored render plan without
  a planner call (`recompileStoredAttempt`), promote or restore the baseline.
  The preview highlights the recipe's wording against the fact's own text
  (`imagePrompt/recipeHighlight.ts`): each piece is wrapped in private-use
  marker characters, the same plan is compiled a second time with the marked
  recipe, and the markers are read back out of each section; a slot's filled
  value stays unmarked. A test requires every captured baseline prompt to read
  back unchanged, and the markers never reach an engine.

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

**PuLID was never on the still-image render path** — it was Stage 1 of the
*video* pipeline and then the remix builder's photo stylise, and both went in
launch Phase 4 (ledger `docs/retired/README.md`; lessons
`docs/retired/pulid.md`). Nano Banana 2 edit is the recommended successor.

## Admin preview/debug surfaces (Runtime Compiled Prompt)

The admin **"Runtime Compiled Prompt Preview" must match runtime.** Parity comes
from all three surfaces going through the **same core path** —
`generateImagePromptPlan()` + `compileForSubjectRenderMode()` — not from a shared
wrapper. The **admin preview surface** (the admin fact-page RCP preview,
`POST /admin/image-prompt/preview`; the i2i/t2i engine workbench went with the
Engines page on 2026-11-14) calls those two functions via `assembleImagePromptForPreview()` (`imagePrompt/preview.ts`) and
nothing else; **production** (`imagePromptJobs.ts`) calls the same two functions
**directly** (it does *not* route through the preview helper). Both preview surfaces
must feed the canonical test identity `RUNTIME_PREVIEW_DEFAULT_NAME = "David
Franklin"` / he/him; production uses the real user identity
(`resolveAttemptIdentity`).

**Preview ≠ byte-identical to production** because two live calls to a reasoning
model word differently. No temperature is sent: the planner runs `gpt-5.5` at high
effort, which takes none (the parameter audit, 2026-11-14,
`engineParameterAudit.test.ts`). Divergence is **sampling, not caching** —
previews don't cache and don't read the `aiScenePrompts` blob (that cache serves
only the AI background backfill). Making outputs identical needs result-reuse
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
  path is the **frontier planner (`gpt-5.5`) + the image engine per mode**
  (today the `image_engine_t2i` / `image_engine_i2i` keys, being moved into code
  per [decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows); Nano Banana 2 and its edit engine until
  launch Phase 8 adopts GPT Image 2.6 and Nano Banana 2.1, per the
  [product strategy](./product-strategy.md#pictures-and-engines)). (The utility LLM — `gpt-6-luna` since it
  replaced `gpt-4o-mini` on 2026-10-13, named in code by `UTILITY_LLM_ENGINE_ID` — serves utility calls only; FLUX Pro only
  on the AI background backfill.)
- **Choosing a render engine by string in the worker, or deriving a stored
  attempt's engine from the mode** — retired in launch Phase 8; the engine comes
  from `imageEngineRouting.ts` and the attempt's own column (see *Which engine
  draws a render*).
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
- `engines/openai-visual-planner.ts`, `engines/nano-banana-2*.ts`, `catalogue.ts`
  (and the Phase 8 candidates beside them); `imageEngineRouting.ts`,
  `imageRequestBuilder.ts`;
  `sourceImageAnalysis/`; `factRenderScenarios.ts` (render-input hash).
- `.agents/memory/image-prompt-preview-parity.md`, `docs/ADMIN_FIELD_REFERENCE.md`.
