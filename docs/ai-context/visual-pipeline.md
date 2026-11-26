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

**A picture is drawn from one selected [gag](./glossary.md#gag) and wording
that is the same for every fact, and nothing else fact-specific** (plan
`docs/plans/PLAN_GAG_DIRECT_RENDER.md`, increment 3, the switch; Issue #982).
The gag's content — its scene (`coreSceneOverride`), its bubbles and its cast
— is stored in `fact_gags` since migration 0139 (plan
`docs/plans/PLAN_THREE_GAGS.md`; schema `lib/api-zod/src/visualStrategyOverride.ts`).
The scene is capped at 3000 chars, carries `{NAME}`/pronoun tokens, and is
canonicalized and token-validated on save. The compiler (`compileDirect`)
emits it **verbatim** as CORE SCENE (token-rendered, otherwise unmodified;
compiler-owned language in it is warned about, never stripped).

There is **no render planner** since the switch: no AI call per picture, and
no classification field (archetype, modifiers, references, characters…)
reaches a prompt. Enrichment is the gag writer's input, not the picture's (see
[`taxonomy-and-enrichment.md`](./taxonomy-and-enrichment.md)). The planner's
useful jobs were re-homed: a pet's photo gets a fixed instruction
(`DIRECT_PET_INSTRUCTION`), bubble speakers are bound from the gag's cast, and
detail the gag leaves unstated is left to the engine under one fixed line
(`DIRECT_FILL_INSTRUCTION`). Violence is one sentence on every picture
(`VIOLENCE_RULE`, `imagePrompt/violenceRule.ts`), sent word for word to the
gag writer too.

## End-to-end render flow

1. **Source-image analysis** (`sourceImageAnalysis/`) picks a `subjectRenderMode`.
2. **The selected gag**, frozen on the attempt when it was queued (`gagId` and
   its content in `factEnrichmentSnapshot.visualPromptStrategyOverride`,
   built by `gagRenderInput`), is read by `directGagInput`
   (`imagePrompt/directInput.ts`): a gag with no scene, or whose cast was not
   read from its scene as it stands, ends the render terminal
   (`gag_scene_missing`, `gag_cast_not_current`). *Until the switch this step
   was the frontier planner (`generateImagePromptPlan()`) → `visualPlan` +
   `subjectFactCompatibility` via OpenAI Structured Outputs; attempts it made
   keep their stored plan, readable but never compiled again. The rest of this
   item is that history.* `subjectFactCompatibility`
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
   constant, boot no longer seeds them, and the read-only `/admin/ai` page shows
   them. Changing the copy is an edit to the constant in a reviewed PR; migration
   0138 deleted their old `admin_config` rows ([decisions.md](./decisions.md#2026-11-14--the-stored-ai-settings-and-the-engines-table-are-deleted-a-read-only-page-shows-the-values)). This is one case of the general
   rule that AI call settings live in code ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)). (Before that, the rows were seeded
   `ON CONFLICT DO NOTHING` and a constant edit needed a DML migration too, which is
   why `0082` and `0084` exist.)
3. **Compiler** (`compileDirect()`) → the `compiledPrompt`, in the wording and
   shape of the routed engine's family (*Prompt recipes*). The worker, the
   admin preview (`assembleImagePromptForPreview`), the prompt-wording
   preview and the photoreal fallback (`recompileStoredAttempt`) and
   comparison preparation all compile the same way, so a preview is the
   prompt a render sends.
4. **Production** (`imagePromptJobs.ts`) renders via fal.ai through the engine
   recorded on the attempt, at the size the request builder chose, and persists
   the result (`imagePromptAttempts.ts`). See *Which engine draws a render*.

## The engine comparison (launch Phase 8)

The comparison that informed the launch engines is its own small model (its
outcome, GPT Image 2.6 for photoreal and Nano Banana 2.1 for styles, is
settled with no further engine rounds:
[decisions.md](./decisions.md#2026-11-11--the-engines-are-settled-prompts-are-tuned-not-engines-re-run)),
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
  Banana 2.1, Muse) or one engine's wording versions, photo types (male, pet —
  `EVALUATION_PHOTO_TYPES`), looks, a description, then the image
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
  or storage path. **In the first judging edition (sets made before
  2026-11-12; see below), every image is scored 1 to 5** (David, 2026-11-10,
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
  mode (the leader of text-to-image, from sets drawn before every picture
  started from a photo, and of reference edit, ties shown), by
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
  given a photo of a person or a pet (David, 2026-11-12). Each panel also
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
  derives rounds 1 and 2 against the code catalogue and checks 27 panels
  and 108 cells (four engine families), reporting the worst case.
- **FLUX 3 was judged at `safety_tolerance` 3**, not fal's default 2: the same
  rank (second-most permissive) as the Nano Banana engines' 5 of 1–6, so the
  comparison judged its drawing, not a stricter filter. FLUX 3 is now retired
  (below).

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
  watermark that disagree are both on screen. A record of a member's meme or
  upload offers **Take down**, the admin takedown described in
  `accounts-and-auth.md`, *Content a member deletes from My content*.

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
name** — `reducePromptName()`: the first whitespace-delimited token of the
validated `displayName` (the name the member chose wins, #709); else
`firstName`; else the canonical fallback (`"Alex"`) — grapheme-safe-bounded to
`RENDERED_IDENTITY_NAME_MAX` (20 chars, `promptIdentityBudget.ts`). It applies
to every identity the worker compiles with (`resolveAttemptIdentity`),
including a moderation render's stored `reviewRenderSubject`, which keeps the
full sample name ("David Franklin") and is reduced at compile; the admin
Runtime Compiled Prompt Preview reduces its sample name the same way, so it
shows the prompt a render sends (#693). The engine-comparison panels
(`comparison/runs.ts`) still compile with the full sample name. This is a **render-time reducer only**,
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

**Speaker bindings (bubble speakers, Issue #968).** For each non-subject bubble
speaker the compiler leads the bubble section with a short binding —
`mom: the older woman in the red coat.` — so the speaker's label stays tied
to a visible character even when the scene already describes her (ROLE
DETAILS drops an entry whose role the scene covers) and even when the gag's
Scene Role Assignments leave her out (they replace the planner's character
list wholesale; the binding is then taken from the plan). The planner is
told the fact's characters as naming context and must list every bubble
speaker in `secondaryCharacters` under its exact label. Each binding is
capped (`SPEAKER_BINDING_ROLE_MAX_CHARS` 80), four at most, so the total
(`SPEAKER_BINDINGS_RENDERED_MAX` 576) fits inside the outer margin with the
§10.4 minimum left — no other pool shrinks, and an arithmetic guard in
`promptBudget.ts` says so. `bubble_entity_unresolved` is judged on what was
emitted. The bubble directives themselves are unchanged
(`IMAGE_PROMPT_GENERATION_VERSION` v9).

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

`CORE_SCENE_RAW_MAX` (3000 since the fold; 1500 before) matches the frontend editor's
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

## The photoreal fallback: Nano Banana draws what GPT Image refuses

Plan `docs/plans/PLAN_NB_FALLBACK.md` (Issue #980; David, 2026-11-17: Q12
option 2, Q13 option 1, Q14 option 1). When the routed photoreal engine
(GPT Image 2.6) refuses a render on content grounds, the same attempt is
redrawn once on Nano Banana 2.1, photoreal, with the same photo and scene
(`lib/engineFallback.ts`, the `image_generation` worker in `imagePromptJobs.ts`).

- **A refusal is fal's own classification only**: a 422 whose detail carries
  `type: "content_policy_violation"` (`falContentRefusal`). Network errors,
  outages and bad input never fall back.
- **First refusal, no retry on the engine that refused.** The fallback engine
  and its live recipe are frozen on the attempt's render controls at queue
  time (`engineFallback`), so a recipe promotion never changes queued work; an
  attempt queued before that resolves them at the handover and says so.
- **Recorded before it happens.** `image_prompt_attempts.engine_fallback`
  (migration 0146) is written in state `preparing` with the routed engine, its
  refused request and fal's reason; the stored scene is recompiled with Nano
  Banana's recipe (no planner call, the same render-time gates); then one write
  switches the engine, recipe and prompt (state `switched`). Every run resumes
  from the persisted state, so no path returns to GPT. A success never clears it.
- **Both refuse: the render fails** with `vendor_content_refused`, naming both
  refusals. No third engine and no rewording (Q14). A fallback prompt that
  cannot be built fails with `fallback_compile_failed`, the refusal kept.
- **Styled renders have no fallback**: Nano Banana first. A content refusal
  there ends the render at once with `vendor_content_refused` and the refusal
  named, instead of retrying the same engine behind a "Drawing…" tile (David,
  Q17 option 1, 2026-11-17).
- **The picture names the engine that drew it**: its provenance record, its
  linked generation request, the visible engine stamp and the snapshot's prompt
  all name Nano Banana; the trace screen shows the refusal and the refused
  request from the record's frozen snapshot, after the attempt is deleted.
- **Freshness**: the scenario input hash is never rewritten by a fallback; for
  an attempt that fell back, diagnostics staleness also compares the fallback
  recipe it drew with against today's. The gag grid matches renders by content
  and ignores recipe changes for every engine, so a fallback is treated the same.
- **The moderation tile** says "GPT Image refused this picture; Nano Banana drew
  it" once the fallback's picture has arrived (`engineFallback` on the card).
- The engine comparison draws through its own path and never falls back: it
  measures each engine as itself.

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
`moderator_core_scene_unresolved_token`, `required_budget_overflow`. The
`image_generation` worker ends a render at once when its stored input cannot be
drawn, since every retry would fail the same way (`render_input_invalid`: no
prompt text, a photo-based render with no reference photo, an engine that
cannot draw the mode, or a request that cannot be built), and on a content
refusal with no fallback left (`vendor_content_refused`) (David, Q17 option 1,
2026-11-17). It writes a retryable failure to the attempt only when
the queue gives up (its `onAbandon` hook), so a render reads "rendering" while
it is still retrying and a picture that arrives on a retry is approvable; a
stored picture clears both fields (plan PLAN_NB_FALLBACK.md). Both
`error` (human-readable) and the typed `error_code` are cleared on a
successful later attempt and surfaced together in the render-poll payload
(`buildRenderStatusPayload`) so the UI never parses a "code: message" string.

**A render the server stopped is resumed, never paid for twice (Issue #1000,
increment 2; plan `docs/plans/PLAN_JOB_RESUME.md` §C, §D, §F).** The image
request's receipt (fal's request id) is stored the moment fal accepts it, so a
resumed render collects the picture fal is still drawing or has finished; a
lost receipt is looked for in fal's request history once the picture could have
finished, and the picture is drawn again (logged) only when no unambiguous
match exists (David, Q13: 1). A resumed planner reuses a plan already saved for
its attempt. The moderator's tile reads the render's real progress — Queued… /
Drawing… / Picking back up… / Saving… / Retrying shortly… — and "Drawing…"
means fal reports the picture in progress, not merely that a plan is saved.

## Every picture starts from a photo

The compiler review, Phase 2 (David, 2026-11-14; [`decisions.md`](./decisions.md)):
no part of the product draws a picture without a reference photo.
`SUBJECT_RENDER_MODE_VALUES` (`lib/api-zod/src/imagePromptGeneration.ts`)
still lists three values, because stored attempts carry all three:

- `human_identity_i2i` — preserve a recognizable human face (reference image).
- `nonhuman_subject_i2i` — preserve an uploaded pet. A subject is a person or a
  pet: classification treats a photo whose only subject is a vehicle, object or
  mascot as having no usable subject (the AI vision check's prompt,
  `FACT_SOURCE_CLASSIFIER_SYSTEM_DEFAULT` in `imagePromptConfig.ts`, analyzer v3;
  [the rule](./decisions.md#2026-11-15--a-pictures-subject-is-a-person-or-a-pet-vehicles-objects-and-mascots-are-not-subjects)).
- `t2i_fallback` — **retired**: no reference. Refused when an attempt is
  queued (`NoPhotoRenderRefusedError`, `no_photo_render_retired`) and again in
  the worker; the compiler's dispatch throws on it. Old attempts keep the
  value and their readers keep its label.

The AI vision check (`sourceImageAnalysis/`, `tier3AiVisionFallback.ts`)
suggests the mode from the photo; it is the whole analysis since the fal
object detector and the heuristics that read it were removed (David, Q9,
Issue #945: the detector's endpoint no longer existed, so every photo read as
"no subject" and the check was never reached). A skipped or failed check
returns the photo unclassified and uncached. A photo it cannot
use (no clear face or subject) is refused by the render-review path with
`NoUsablePhotoError` (`no_usable_photo`, the analysis's own reasons), asking
for a better photo, never drawn as an invented person. The planner's brief
and its output contract name the two photo modes only, and are engine-neutral:
the engine is chosen after planning, by look. Moderation's required renders
are David's photo (`i2i_male_default`) and his wife's (`i2i_female_default`,
rendered as Raena Franklin, she/her); the pet scenario (the cat) is the
third kind a gag's examples are drawn from, and there is no object scenario
(a subject is a person or a pet, [the rule](./decisions.md#2026-11-15--a-pictures-subject-is-a-person-or-a-pet-vehicles-objects-and-mascots-are-not-subjects)). `generic_t2i` is retired: never offered, run or
required, and a render it already made stays on the grid outside the tally.
The comparison's round 1 draws photo panels only (9 panels, 54 cells). The
legacy AI-background generator (`fact_ai_meme_backfill`) is removed: its
route, its queue, its handler and its scheduling lane are gone (fact lifecycle
3.2d), and migration 0169 (3.2e) deleted the jobs left on its queue and
dropped its scene prompts (`facts.ai_scene_prompts`) and status column. The
pictures it stored stay in `facts.ai_meme_images`, which nothing writes or
serves since launch Phase 7, increment 2: a member's AI picture is delivered as
their own `user_ai_images` row (`lib/memberPictures/settlement.ts`) and is
never added to a fact's gallery.

## Which engine draws a render

Launch Phase 8, increment 1 (plan `docs/plans/PLAN_PHASE8_ENGINE_EVALUATION.md`,
*Proposed Design* A, A2 and B), and the compiler review's Phase 1 (plan
`docs/plans/PLAN_COMPILER_REVIEW.md`, #950), which adopted the strategy's
photoreal and styled split. Until increment 1 the worker chose `nano-banana-2`
or `nano-banana-2-edit` by string. Now:

- **The engine per look class and mode is set in code**, `IMAGE_ENGINE_IDS` in
  `lib/imageEngineRouting.ts` ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)):
  a render with no look is **photoreal** and goes to `gpt-image-2-6` /
  `gpt-image-2-6-edit`; a render with a chosen look is **styled** and goes to
  `nano-banana-2-1` / `nano-banana-2-1-edit`
  ([product strategy](./product-strategy.md#pictures-and-engines)).
- **The look is resolved once, at queue time, and frozen.** The shared input
  resolver (`resolveRenderReviewInput.ts`) runs `resolveAndFreezeRenderStyle`
  and puts the snapshot on the render controls (`resolvedRenderStyle`);
  `buildAndEnqueueImagePromptAttempt` picks the engine from its look class
  (freezing one itself if a caller passed none). The worker reads the snapshot,
  never the look's row, so a look edited or deleted between queue and render
  changes neither the engine nor the RENDER STYLE. A look that cannot be used
  (missing, inactive, empty or over-long copy) throws
  `RenderStyleRefusedError` — a 400 from the preview and the admin render
  action — and is never treated as "no look". Moderation scenarios render
  with no look, through the photoreal engines. Nano Banana 2
  stays in the catalogue: an attempt recorded with it still renders through it.
- The `image_engine_t2i` and `image_engine_i2i` rows
  migration 0123 seeded were deleted by migration 0138, along with the engines
  table ([decisions.md](./decisions.md#2026-11-14--the-stored-ai-settings-and-the-engines-table-are-deleted-a-read-only-page-shows-the-values)).
- **An attempt records its engine at construction**, in
  `image_prompt_attempts.actual_image_engine_id`, and changes it at most once,
  on a recorded photoreal fallback (below); the worker renders through
  that engine, never through today's default: an attempt queued before a
  default changed still renders through the engine it was made for. Signatures
  and moderation diagnostics read the column
  (`attemptImageEngineId`). A null appears only on a row an older release wrote
  after 0123 ran; such a release routed by mode alone, so the null reads as that
  release's engine. A later contract migration makes the column `NOT NULL`.
- **A moderation render's input hash records the engine it used**
  (`currentImageEngineIds`, read once per review context) as provenance. It
  does not decide reuse: a gag's render is matched to its content (*Gags*,
  below), so changing a mode's default leaves existing renders shown and
  approvable, each still saying which engine drew it (2026-11-15).
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
  (one text-to-image, one edit; only the edit draws now, since every picture
  starts from a photo): GPT Image 2.6 Sunburst at high reasoning (in
  place of 2.5, whose pair stays in the catalogue unused; David, 2026-11-10),
  Nano Banana 2.1, FLUX 3 Image, Seedream 5.0 Pro and Meta Muse Image, beside
  the Nano Banana 2 control.
- **Retired engines** (prompt tuner plan, *E. Retirements*): FLUX 1.1 Pro,
  FLUX 2 Pro, FLUX 3, Seedream 5.0 Pro, Nano Banana Pro, GPT Image 2 and GPT
  Image 2.5, each with its edit or text-to-image twin, are `isActive: false`
  in code. They stay in the catalogue so old comparison results still name
  them; nothing can draw with one, the Eval page never offers one, and a test
  pins the active image set to Nano Banana 2, Nano Banana 2.1, GPT Image 2.6
  and Muse Image (each pair).
  Each carries a `priceModel`, a complete per-call bound at the comparison
  settings with each component's source, and nothing routes to one until it
  becomes an engine in `IMAGE_ENGINE_IDS`, a code change. The one compiler is
  adapted to the two chosen engines through their recipes' baselines
  (*Prompt recipes*), not by a second compiler.

## Gags: where the Visual Concept lives (migration 0139)

A fact has one to three [gags](./glossary.md#gag), each a `fact_gags` row in
slot 1-3 holding a whole Visual Strategy Override; every gag follows the same
rules whatever its slot (plan `docs/plans/PLAN_THREE_GAGS.md`, David
2026-11-14). The enrichment holds none: a CHECK on `facts.enrichment` and on an
open refresh candidate's enrichment refuses one, and a render's input is the
classification joined with one gag's content (`gagRenderInput`,
`lib/gags/resolver.ts`).

- **The rule:** [decision](./decisions.md#2026-11-15--a-gag-carries-a-male-a-female-and-a-pet-example-renders-are-drawn-as-the-moderator-iterates).
- **Versions.** A gag has an approved version (offered to users on a live fact)
  and may carry a pending change. Saving writes the pending change; it changes
  nothing users get until a moderator approves its **male, female and pet**
  test renders as the gag's **examples** (`approveGagRender`; plan
  `docs/plans/PLAN_GAG_EXAMPLES.md`, migration 0143). Each render must be
  finished, unstyled, drawn from exactly that content and of its kind's
  scenario. Outside a refresh the third approval applies the change and its set
  in one transaction (`applyPendingSetIfComplete`, `lib/gags/examples.ts`).
- **Examples.** `fact_gag_examples` holds one row per gag, kind (`male`,
  `female`, `pet`) and stage (`approved` for the version users get, `pending`
  for picks of the change). A deferred constraint trigger
  (`enforce_gag_example_set`) refuses at commit approved content without all
  three kinds, unless the gag is **grandfathered** (approved before example
  sets: `approved_before_example_sets`, or carried over by 0139), and pending
  picks without pending content. Grandfathering ends at a gag's first complete
  set. The old `approved_example_attempt_id` and `pending_example_attempt_id`
  columns are unread recovery snapshots, dropped by a later migration.
- **Renders belong to a gag, one per kind and content.** The three subject
  kinds are the scenarios `i2i_male_default`, `i2i_female_default` and
  `i2i_nonhuman_animal` (`SCENARIO_FOR_KIND`); generic text-to-image is no
  longer drawn, and the object/vehicle scenario is removed (a subject is a
  person or a pet, [the rule](./decisions.md#2026-11-15--a-pictures-subject-is-a-person-or-a-pet-vehicles-objects-and-mascots-are-not-subjects); migration 0145). `image_prompt_attempts.gag_id` names the
  gag each render drew, and a render is **reused** when its attempt's
  `fact_enrichment_snapshot` matches the gag's current render input in what
  shapes the picture: the gag's content and the classification fields the
  input hash reads, `renderAffectingEnrichment` (`attemptForContent`,
  `reviewRenderScenarios.ts`). The same content draws nothing, a discard back
  to earlier content shows that content's render, an admin note or a rating
  never unseats a render while a picture-shaping edit does, and the engine and
  recipe stay provenance rather than redefining reuse.
  `drawGagKinds` draws the kinds asked for under an advisory lock per gag and
  kind, so overlapping requests draw once; `redraw` asks for a new one anyway.
- **What draws.** Saving a gag (an edit, an idea, a discard, a new gag) enqueues
  one **iteration render**, male (`enqueueGagIterationRender`); nothing draws
  while the fact's review is on its Gags step, which shows no renders
  (`assertCanRunGagRenders` refuses with `GAGS_STEP`, 2026-11-21); approving the Gags step enqueues the
  iteration render of each surviving new or changed gag
  (`ensureReviewIterationRenders`) and clears nothing; **Render female and
  pet** draws the other two (`POST /admin/facts/:id/gags/:gagId/renders`,
  `{ kinds, redraw? }`). No paid render fires without a moderator's action.
- **The production gate is per gag.** Approve for Production asks whether every
  gag that will be offered has its three examples or is grandfathered, and
  names the missing kinds (`exampleSetGaps`, `describeExampleSetGaps`). The
  review-wide render grid, its routes and the render waiver are gone.
- **Refreshes.** While a refresh is open a fact's gags change only inside its
  review, as its last step: picks or a removal there wait on the gag
  (`pending_review_id`) and land at promotion (`applyReviewGagOps`; a change
  only with its three picks); declining discards them. The live fact's approved gags stay offered throughout. **Keep
  this gag** (`keepGag`) cancels a removal marked there and touches nothing
  else, whether the gag is approved with no change, approved with a change and
  picked examples, or never approved; **Discard the saved change** drops only
  the change and its picks, leaving a removal mark alone (increment 2; Codex,
  PR #956 round 4).
- **The rule the database holds.** A live fact always has an approved gag
  (deferred constraint triggers `facts_live_requires_approved_gag` and
  `fact_gags_live_fact_keeps_approved_gag`).
- **Default gag.** Anything that draws a fact's picture without a picker uses
  the lowest-slot approved gag (`primaryGag`). Where more than one gag is
  available, users choose with a picker: launch Phase 7 builds it with the user
  AI-picture flow (David, 2026-11-14, plan decisions 13 and 15).
- **The list Phase 7 reads.** `availableGags(factId)`: a live fact's approved
  versions, default first then slot order, never a new gag or a pending change,
  a refresh's picks and removals only after promotion, and never the
  backfilled stand-in scene ("{NAME} stands there confidently.", migration
  0092): a fact whose only approved gag is the stand-in offers none until a
  real one is approved (David, Q8, Issue #1014); and
  `resolveOfferedGag(factId, gagId | null)`, the one way a non-moderator caller
  picks a gag (no name: the default; a name not available: refused, never
  replaced). Stored content reaches both through `normaliseGagContent`, the one
  reader that fills an older stored shape's lists and never refuses (Codex,
  PR #956 round 3). Contract tests: `availableGags.test.ts`.
- **Unsaved edits are kept in the browser.** A gag card's unsaved edit is kept
  in `localStorage` with the server version it was typed against, restored
  only while that version is unchanged, and cleared on save, undo or cancel; a
  new gag's draft reopens its card.

A moderator authors a gag directly in the **Gags panel**
(`components/admin/gags/GagsPanel.tsx`, on the moderation review and the Facts
editor), or **uses a candidate** (next section) on a gag, via the same cap and
token rules.

## A gag's render history, roles and cost (Issue #1304)

Plan `docs/plans/PLAN_RENDER_HISTORY.md`; server side in increment B, screens in C.

- **Renders are kept.** "Draw again" adds a render beside the old one, and nothing deletes one except an admin's delete or a rejection's purge. The history is a view over stored renders: `artifacts/api-server/src/lib/gags/renderHistory.ts`, newest first, 50 a page, failed ones included. A removed gag keeps its history under its own id.
- **"A gag's renders" means its moderation renders**, `GAG_MODERATION_RENDER` in `lib/imagePromptAttempts.ts`: a moderation scenario key or the admin render audit, and never a member's picture, which also stores the gag it drew. The history, the removed-gag counts, the delete and the admin image route all read through it.
- **Roles are computed, never stored** (D1):
  - **live:** the published pick;
  - **approved, goes live when you publish changes:** the draft pick when it differs from the published one (#1324: the name says the pick waits for Publish changes);
  - **working:** the newest render of the picture, whatever its content. It is marked stale when drawn from another version of the gag.
  - The gag view carries them as `roles`. They replaced the content-matched `renders` tiles in increment C, and `buildGagKindCards` went with them; the working render is `buildGagWorkingCards`.
  - Every draw asked for from the Renders view sends `redraw`, so a click always makes a new render and the previous one stays in history. "Render female and pet" asks only for the pictures that need drawing.
- **Approval** (D4) reads "approved" from any evidence: a current pick, the gag's legacy `approved_/pending_example_attempt_id`, or a `gag_render_approval` record. Without evidence a render reads "not recorded" before `render_approval_audit_complete_since`, and "not approved" after it. That boundary is the first boot of the release that records approvals in the pick's own transaction, plus an hour.
- **Cost** (D5) is what fal billed: `image_generation_requests.billed_usd` and `billing_checked_at` (migration 0175).
  - An hourly task (`lib/renderBilling.ts`) fills them for review renders, using the comparison's billing reader and `FAL_BILLING_API_KEY`.
  - Lookups run in windows of at most 90 days. A failed lookup changes nothing.
  - Viewing calls nobody.
  - The states are `billed`, `not_checked`, `no_bill_found`, `billing_key_not_set`, `not_recorded` and `never_sent`. `billed` also counts the requests still unbilled and those whose receipt is unknown.
  - A request with no fal id is `never_sent` only when fal refused it at submission (`FAILED`). Any other request with no id may have been charged, so it counts against completeness. A render with only such requests, or a picture and no request records (drawn before tracing), is `not_recorded`, never guessed.
- **Delete** (D6) is `deleteGagRender` in `lib/gags/gagStore.ts`, under the fact lock.
  - It refuses a pick, a render still drawing, a render a member's picture names, and anything that is not this gag's moderation render, members' own pictures included.
  - It queues the render's files on `stored_file_deletions` in the same transaction, and records `render_delete`.
- **The screens** (increment C) are `components/admin/gags/GagsPanel.tsx` and `RenderHistory.tsx`, on moderation and the fact sheet alike.
  - **Gags view (D2):** each picture's official renders only, labelled "Live example" and "Approved, goes live when you publish changes" ("Approved for publishing" on an unpublished fact), or "No approved example yet".
  - **Renders view (D3):** per picture, the official renders locked (the live example adds "Members see this until you publish", #1324), then the working render with Approve and Draw. A render holding several roles shows once, under the working render, with its roles named.
  - **History:** below each gag, collapsed; it is read only when opened, and again when that gag's renders change. Each entry is a line that opens to its full record. "Load older" pages on the server's cursor. Delete is offered on any entry that is not official and not drawing, after a confirmation naming the picture and date. A "Removed gags" section appears only when the fact has some.

## A gag's cast, and the fold (PLAN_GAG_DIRECT_RENDER.md, increment 2)

**The cast** is who is in a gag's scene besides the subject: a list of
`{label, description}` in the gag's content (`cast`), with a marker written
only when an extraction succeeded (`castExtraction`: prompt version, time, and
`sourceKey`, the `castSourceKey` of the scene and bubble speakers it was read
from). Absent marker = never read; `[]` with a marker = read, nobody else
there. **One producer**: cast extraction (`lib/gags/castExtraction.ts`, the
utility model, prompt v2), which reads the scene under the stand-in name
"Alex", binds each bubble speaker under the bubble's exact string, never adds
a character the scene does not show, and strips "Alex" from any description
it returns ("the subject" instead).

- **Every save carries one.** The editor reads it on the draft before saving
  (`POST /api/admin/facts/:factId/gags/cast`, stores nothing): when a bubble is
  added or edited after the scene changed, and at Save if the scene or a
  speaker changed since. The server does not extract at save; it checks
  (`assertGagCast`): a cast is present (`CAST_MISSING`), was read from this
  content (`CAST_STALE`), and binds every bubble speaker
  (`SPEAKER_NOT_IN_SCENE`, naming them). A used gag idea is prepared the same
  way, so the locked gag-writer prompt is unchanged.
- **The speaker dropdown on a gag card** offers the subject and the draft's
  cast (`buildCastSpeakerOptions`); a saved speaker the cast lacks is shown as
  itself, marked "not in this scene", and stops the save.
- **Since the switch every picture reads it** (the speaker bindings). Render
  freshness, render reuse, the tile and approval all compare one projection
  of a gag (`renderedGagProjection`, `imagePrompt/directInput.ts`): its scene,
  complete bubbles and cast entries — never the extraction marker, so a cast
  read again with the same entries at a new time changes nothing, while a
  cast whose entries changed is a different picture. (Until increment 3 the
  cast was left out of all three, since no prompt read it; it went in with the
  `IMAGE_PROMPT_GENERATION_VERSION` bump to v11.) A save still compares the
  whole content, cast included.
- **The eleven "More art direction" fields left the accepted input** at the
  switch (`retiredArtDirectionFields`; a save carrying a value is refused,
  `RETIRED_FIELD`). Stored legacy keys still parse and nothing reads them.

**The fold** (`lib/gags/fold.ts`, job `lib/gags/foldJob.ts`, queue
`gag_fold`, panel on Taxonomy Health) is the one-off conversion of every gag
version's eleven extra fields into its scene, plus a cast for every version.
Deterministic: the moderator's words move, nothing is reworded. Roles become
"label: role." sentences (the subject's as `{NAME}`), required details "Also in
the picture: …", composition "Composition: …", extra details as sentences,
forbidden and do-not-render items "No …" sentences, allow-mode policy guidance
as sentences, and a depiction description as a sentence under a mode that
renders it; intent, notes and a depiction description under "use the AI plan"
(which the compiler ignores) never reached the engine and are kept only in the
archive. A violence
override other than allow-at-strong, a supporting-text override of forbid or
require, a depiction mode with no description to carry it, or a scene that
would no longer fit the budget is **listed for a moderator** and not
converted. Every write re-reads the version under the fact and gag locks and
retries when it changed; a refresh's pending operations and example picks are
untouched. Originals are kept in `fact_gag_fold_archive` (migration 0147), and
`revertGagFold` restores one while the version still holds what the fold wrote.
The report (`GET /api/admin/gag-fold`) is computed from the gags as they are,
so it is also the dry run; its two lists, versions for a moderator and
versions with no current cast, must both be empty before increment 3 is
published on a database (both were empty on the Repl; the live site's run is
in increment 3's post-merge verification).

**Budget.** The scene's raw cap is 3000 and its rendered cap is pooled with
the extra fields' (`SCENE_AND_ADDITIONS_RENDERED_MAX`, 3500): a scene may use
what the additions leave, so the reserves' sum and the compile-time proof are
unchanged and a gag that fitted before the fold fits after it.

## Visual Strategy Override authoring (auto-tokenize on Save)

Moderators author `coreSceneOverride` and the rest of `visualPromptStrategyOverride`
in **plain English** — naming the subject naturally ("David leans against the
bar"), not hand-typed `{NAME}`/pronoun tokens. Clicking **Save** runs every
changed rendered-text field through the shared tokenizer core (see
[`token-rendering-and-grammar.md`](./token-rendering-and-grammar.md#shared-core-fact-submission-and-admin-visual-concept-authoring-pr-206))
and **shows the tokenized result in the field** before it persists — not a
silent swap, mirroring the fact-submission write→preview→confirm pattern. This
is the ONE save path every gag save takes (`tokenizeGag` in
`components/admin/gags/gagApi.ts`, then the gag route); it sends only the
fields changed since the version the edit started from.

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
surfaces a field-specific red-bordered error on that field instead of
silently saving something wrong; the gag's card disables while its tokenize
and save round trip is in flight, so no edit can race it.

**Activation is presence-based — there is no `enabled` field.** The override
object no longer carries an `enabled` boolean (retired). Every sub-field applies
on its own whenever it is non-empty; an override whose fields are all empty
compiles byte-identically to having no override at all (the keystone invariant —
every consumer no-ops on empty, verified in `nanoBanana2Compiler.test.ts`). Both
compiler-side gates were converted from `ov?.enabled` to a plain presence check
(`activeOverride()` in `nanoBanana2.ts`, `resolveRenderPolicy()` in
`imagePromptGeneration.ts`). Stored rows that still have a legacy `enabled` key
parse cleanly — Zod strips the unknown field — so no migration was needed.

**The Visual Concept (core scene) is REQUIRED for every gag.** Each gag's card
is its `VisualConceptCard`, who is in the scene (its cast, read-only chips) and
its bubbles. "More art direction" (the `VisualStrategyOverridePanel`) left the
card in PLAN_GAG_DIRECT_RENDER.md increment 2 (David, Q1: 1); the component
stays in the code, mounted nowhere, until increment 3 takes the eleven fields
out of the schema. A gag with a blank scene can't be
saved (`fact_gags_*_scene_nonempty`), and a fact can't go live, or stay live,
without an approved gag (`CONCEPT_MISSING` on first-time production approval;
`GAG_REQUIRED` on a refresh promotion that would leave none). Rationale: the
image engines need a concrete scene to make a meme.

## Candidate Visual Concepts

**The gag writer (prompt version 4; plan `docs/plans/PLAN_GAG_GENERATOR.md`,
approved by David 2026-11-13, and `docs/plans/PLAN_THREE_GAGS.md` increment 2).**
- **Engine and prompt.** The candidates are drafted by the `openai-gag-writer`
  engine (GPT-6 Astra, medium effort since 2026-11-14: high took 100–211 s a call), chosen and
  configured in code ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)). Migration 0137 had pointed the retired
  `fact_visual_concepts_engine_id` key there and kept the previous value as
  `fact_visual_concepts_engine_id_before_0137`; migration 0138 deleted both.
  The render planner is a separate engine. The system prompt is the text David
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
  - every gag the fact already has, in slot order: each one's version being
    worked on (its pending change, else its approved version), a gag marked
    for removal left out (`contextGagsFor`). One gag keeps the v3 wording ("GAG
    THIS FACT ALREADY HAS"); several are listed together, numbered. The locked
    system prompt is unchanged;
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
- **Freshness.** The input hash covers the same frozen list of gags the
  request carried, so a change to any gag stales the candidates, as a saved
  gag edit did when the gag lived in the enrichment. The note is kept out of
  the input hash. A saved note that matches neither the note the gags were
  written under nor their own read marks them `humor_note_changed`. So
  confirming a read keeps its gags usable, and a correction asks for
  Regenerate.
- **Draft more gags on a live fact** (`POST /admin/facts/:id/gags/ideas`, the
  Facts editor's `LiveGagIdeas`): the same engine, prompt, validation and
  latest-only store, run outside a review, reading the live fact. Refused while
  a review is open (its own generation owns the fact's ideas), for a fact that
  is not live, and while a live draft is still working. A "working" status
  left by a closed review does not block it, and opening a review clears a
  live draft's ideas.
- **One owner per generation** (migration 0140, `lib/visualConceptOwner.ts`).
  `facts.visual_concept_owner` names the generation that may write the fact's
  candidates and their status: `review:<id>` or `live:<id>`. Every write of
  that state (working, ready, failed) goes through `ownedFact`, so it lands
  only while that owner holds the fact. Opening a review (a refresh, a
  resubmission) and enqueueing its generation take ownership and clear a live
  draft's leftovers, so a live draft that finishes afterwards writes nothing;
  a live draft takes ownership in one conditional write that also checks the
  fact is live, no review is open and nothing is drafting. The migration
  backfilled each fact with an open review to that review; a fact no
  generation has claimed (null) is written by none.

AI-drafted picks to avoid blank-page authoring (`lib/api-zod/src/visualConcepts.ts`,
Slice 2A / PRs #163, #166). The planner drafts exactly **3**
`{title, whyItWorks, sceneDescription, bubbles}` concepts during moderation prep,
stored on `facts.visual_concept_candidates`. They use a **render-mode-agnostic**
context so a pick works across all modes. A pick applies the WHOLE concept
via `withCandidateConceptDraft` (scene → `coreSceneOverride`, bubbles →
`bubbles`; unrelated VSO fields preserved; never merged; atomic — one invalid
bubble makes the whole concept unpickable).

**Using an idea waits while any gag card holds unsaved edits, or while an
idea is being saved.** Using one saves it at once onto a gag, replacing that
gag's saved scene and bubbles and keeping its other fields, and the card then
shows the new saved version, so typed edits would be lost. The idea cards show
"Save or undo your gag edits first", and the panel locks while the save is in
flight (Codex, PR #956 round 3). `candidatePickGate.ts`, which held this rule
when a pick only filled a browser draft, went with that draft in increment 1.

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
has been read from code since Launch Phase 3's amendment 1, and migration 0138
deleted the row; see the planner item's note on code-owned prompts, above.)

## Frontier visual planner (removed)

Removed at the switch (plan `PLAN_GAG_DIRECT_RENDER.md`, D; David,
2026-11-17): `imagePrompt/generator.ts`, its engine
`engines/openai-visual-planner.ts`, its system prompt
(`fact_image_prompt_system`, now a retired key in `codeOwnedPrompts.ts`), and
the compiler code that read the classification (age transform, no-clones,
modifier guards, sole-agent and active-action lines, the keyword violence
check). Keeping it as a fallback was ruled out.

## Prompt compiler

`compileDirect()` in `compilers/nanoBanana2.ts` — the **deterministic
compiler**, one for every engine (the file keeps its first engine's name). Its
input is explicit and holds no classification (`DirectCompileArgs`: the gag's
scene and bubbles, its cast, the photo's mode, the look, render controls, the
reference and the identity). Sections, in order, worded and shaped by the
routed engine family's recipe: CORE SCENE (the gag, verbatim) · IDENTITY &
REFERENCE (person or pet wording, plus `DIRECT_PET_INSTRUCTION` for a pet) ·
ADDITIONAL DETAILS (`DIRECT_FILL_INSTRUCTION`) · SPEECH & THOUGHT BUBBLES (a
speaker binding per non-subject speaker from the cast, then one directive per
balloon) · COMPOSITION (caption space, when asked) · ENGINE NOTES · RENDER
STYLE · STRICT CONSTRAINTS (overlay-text exclusion, incidental-text guard,
`VIOLENCE_RULE`). It is pinned by a captured corpus
(`__tests__/fixtures/directCompileBaseline.json`, cases in
`directCompileCases.ts`). None of the routed engines takes a negative-prompt
parameter — exclusions are scene language. *Before the switch this section
described the planned compile and its SUBJECT BINDING, ROLE DETAILS, SUBJECT
DETAILS, ENVIRONMENT and LIGHTING sections; see git history.*

### Prompt recipes: the compiler's global wording, versioned per engine

A named exception to the guideline that AI call settings default to code ([decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows)): wording versions are stored and promoted in the database by design.

(The prompt tuner, part 2; plan `docs/plans/PLAN_PROMPT_TUNER.md`, *Proposed
Design* A and D; migration 0134.) Every piece of wording the compiler owns that
is **the same for every fact** is a named template in
`artifacts/api-server/src/lib/imagePrompt/recipe.ts`: the section labels, the
identity paragraphs (person photo, pet photo, no photo, and the
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

**The shape is two pieces** (compiler review, Phase 1): `shape.section`, how
one section is written (`{label}: {body}` by default; `{label}` may be left
out, `{body}` may not), and `shape.join`, what sits between sections (spaces
and line breaks only). **Each engine family has its own baseline**
(`FAMILY_BASELINES` in `recipe.ts`; `baselineRecipeFor`): Nano Banana 2's is
`BASELINE_RECIPE`, today's wording byte for byte and every other family's
default; GPT Image 2.6's follows OpenAI's image prompting guide — labeled
sections one per paragraph, the reference named as "image 1", likeness
spelled out, photoreal asked for explicitly; Nano Banana 2.1's follows
Google's Gemini image guide — unlabeled narrative paragraphs, "remain
completely unchanged" for likeness, and the do-nots written as what the
picture is. Both drop the doubled `COMPOSITION: Composition:` label. A null
version resolves to the baseline of the family of the engine that draws the
render (`recipeById(versionId, family)`), and a stored version is laid over
its own family's baseline. The preview's highlighting never marks the shape
pieces, since they are the joins the sentence de-dupe reads.

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
- **Moderation renders**: `currentImageEngineIds()` carries each mode's live
  version into the scenario hash **only when set**, as provenance. Since
  2026-11-15 the hash no longer marks a render out of date: a gag's render is
  reused by content, so a promotion changes only what a new render is drawn
  with (nothing re-renders on its own).
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
  note, preview the whole prompt on the gag frozen on a fact's newest compiled
  render attempt for that photo type, with no model call
  (`recompileStoredAttempt`; an older planned attempt frozen before casts were
  read is passed over, never drawn with today's gag), promote or restore the
  baseline.
  The preview highlights the recipe's wording against the fact's own text
  (`imagePrompt/recipeHighlight.ts`): each piece is wrapped in private-use
  marker characters, the same gag is compiled a second time with the marked
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
- **UI**: ONE shared `BubbleEditor`. On a gag card its speakers are the
  subject and the gag's cast (see *A gag's cast, and the fold*); the embedded
  placement in the old Advanced VSO panel is mounted nowhere since increment 2
  of PLAN_GAG_DIRECT_RENDER.md.

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
Engines page on 2026-11-14; the read-only `/admin/ai` page now shows each
step's settings) calls those two functions via `assembleImagePromptForPreview()` (`imagePrompt/preview.ts`) and
nothing else; **production** (`imagePromptJobs.ts`) calls the same two functions
**directly** (it does *not* route through the preview helper). Both preview surfaces
must feed the canonical test identity `RUNTIME_PREVIEW_DEFAULT_NAME = "David
Franklin"` / he/him; production uses the real user identity
(`resolveAttemptIdentity`).

**Preview ≠ byte-identical to production** because two live calls to a reasoning
model word differently. No temperature is sent: the planner runs `gpt-5.5` at high
effort, which takes none (the parameter audit, 2026-11-14,
`engineParameterAudit.test.ts`). Divergence is **sampling, not caching** —
previews don't cache (the retired AI-background generator's scene-prompt cache,
`facts.ai_scene_prompts`, was dropped by migration 0169). Making outputs identical needs result-reuse
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
  path is the **frontier planner (`gpt-5.5`) + the image engine per look and
  mode** (set in code, `IMAGE_ENGINE_IDS`, per [decisions.md, 2026-11-14](./decisions.md#2026-11-14--ai-call-settings-live-in-code-never-in-database-rows): GPT Image 2.6 for
  photoreal and Nano Banana 2.1 for a chosen look, per the
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
