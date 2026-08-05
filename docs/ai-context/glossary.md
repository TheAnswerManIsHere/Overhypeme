# Glossary

> Fast lookup for Overhype.me's product-specific terms — two sentences each, with
> a pointer to the deep doc. When a term's meaning changes, fix it here **and** in
> the deep doc.

- **Fact** — the core content entity: an exaggerated, personalizable statement
  stored once as a **tokenized template** (`facts` table, `text` column) and
  rendered on demand for any name/pronoun set. Not stored per-name.
  → [product-brief](./product-brief.md), [token-rendering](./token-rendering-and-grammar.md)

- **Variant (of a fact)** — a fact that expresses **the same concept** as another
  fact in slightly different words, linked by `facts.parent_id` to the **root**
  (the primary example of that concept). The link exists for exactly two
  purposes: recording that kinship, and letting the UI show or hide variants.
  **A variant is otherwise a fully independent fact** — it owns its own memes,
  taxonomy/enrichment, Visual Concept, and stock/AI images, and it inherits
  **no** metadata from its root.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md#variants-are-independent-facts)

- **Personalization tokens** — the closed set a template may use: `{NAME}`,
  `{NAME_POSSESSIVE}`, the pronoun tokens (`{SUBJ}`/`{OBJ}`/`{POSS}`/`{POSS_PRO}`/
  `{REFL}` + capitalized variants), and conjugation pairs like `{laughs|laugh}`.
  → [token-rendering](./token-rendering-and-grammar.md)

- **Rendering (a fact)** — substituting tokens with a name + pronoun set to produce
  natural text (the name highlighted orange). Distinct from *image* rendering.
  → [token-rendering](./token-rendering-and-grammar.md)

- **Staging fact** — a `facts` row with `isActive = false`: prepped but not
  published. Production approval flips it `isActive = true` (live); published =
  an active row exists (no status enum on `facts`).
  → [moderation-workflow](./moderation-workflow.md)

- **Moderation / review** — the staged, cost-gated approval workflow for
  submissions, living in `pending_reviews` with a `review_workflow_stage`. Three
  human gates: `triage_pending → prep_pending/prep_failed → concept_review
  (Step 2: Visual Concept) → production_review (Step 3: Test Renders) →
  production_approved/production_rejected`. Renders fire only at Step 3.
  → [moderation-workflow](./moderation-workflow.md)

- **Enrichment** — the AI **classification** layer: durable structured taxonomy
  metadata for a fact (archetype, subtype, entities, references, adult
  suitability, hashtags). It is **not** an image prompt.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

- **Archetype (joke mechanism)** — the single most important classification: one of
  11 values (e.g. `superhuman_physical_feat`) describing *how the joke works*, not
  its topic. Each selects a hand-authored visual strategy.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

- **Enrichment override / baseline** — `enrichmentAiDerived` is the immutable AI
  baseline; `enrichmentOverrides` are path-keyed manual edits; `enrichment` is the
  merged effective blob runtime reads. Human overrides survive re-enrichment.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

- **Visual Concept (core scene)** — the moderator-authored (or AI-drafted-then-
  picked) scene description that is the **authoritative** picture for a render.
  Stored at `enrichment.visualPromptStrategyOverride.coreSceneOverride`.
  → [visual-pipeline](./visual-pipeline.md)

- **Candidate Visual Concepts** — 3 AI-drafted `{title, whyItWorks,
  sceneDescription}` options shown to a moderator to avoid blank-page authoring; a
  pick becomes the Visual Concept.
  → [visual-pipeline](./visual-pipeline.md)

- **Visual planner** — the frontier-model (`gpt-5.5`) step
  (`generateImagePromptPlan`) that realizes the Visual Concept into a structured
  plan. It never throws — it falls back with a recorded reason.
  → [visual-pipeline](./visual-pipeline.md)

- **Compiler (Nano Banana 2)** — the deterministic `compileForSubjectRenderMode`
  step that turns the plan into the engine prompt and owns identity/reference/
  text-policy language. The current image render path.
  → [visual-pipeline](./visual-pipeline.md)

- **Render scenario** — one required render variant a moderator approves at
  production review (e.g. `generic_t2i`, `i2i_male_default`); each attempt is a
  durable `image_prompt_attempts` row.
  → [visual-pipeline](./visual-pipeline.md)

- **Stale render / render-input hash** — render presentation state is derived at
  read time, never persisted: a `reviewRenderInputHash` is compared to an attempt's
  stored hash; a mismatch reads as "stale," prompting a re-run.
  → [visual-pipeline](./visual-pipeline.md)

- **Prompt-identity snapshot** — the render identity (name + pronouns, reduced
  to a short prompt-safe form) resolved ONCE at attempt-construction and
  frozen on `render_controls`, so the async worker never re-queries the live
  user. Distinct from the profile's own stored name/the meme caption, which
  are untouched.
  → [visual-pipeline](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility)

- **Resolved-style snapshot** — the selected look-style's suffix, frozen at
  attempt-construction alongside the prompt-identity snapshot, so a style
  edited/deactivated after a user clicks generate can't change the pending
  render.
  → [visual-pipeline](./visual-pipeline.md#frozen-render-inputs-identity--style-reproducibility)

- **Terminal vs retryable (async failure)** — how the async-jobs worker
  classifies a handler failure. Terminal = deterministic (re-running the same
  frozen inputs can't fix it) → the row fails on the first attempt with a
  typed `code`. Retryable = the historical default → backoff and retry up to
  `maxAttempts`.
  → [architecture-map](./architecture-map.md#async-jobs-and-queues)

- **Engine / engine catalogue** — any generative model the platform can call
  (`image | video | utility | llm`), defined **code-first** in
  `artifacts/api-server/src/lib/engines/` and reconciled into the `engines` table
  at boot. Admin owns `isActive`/`isDefault`/pricing.
  → [architecture-map](./architecture-map.md)

- **Taxonomy health** — data-quality monitoring for the enrichment layer
  (`evaluateFactTaxonomyHealth`, a pure function): flags missing/invalid/low-
  confidence/stale/projection-mismatch facts and recommends re-enrich vs
  repair-projections. Also the reference implementation for async status.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md), [async-ui-status](./async-ui-status.md)

- **Processing signature** — stamp of the engine/prompt/code revision an
  enrichment was generated under: `{engineRevision, taxonomyVersion,
  classificationVersion, imagePromptGenerationVersion, visualStrategyVersion}`.
  A fact whose stamp differs from the current one is **stale for reprocess**.
  Live since PR3 (#168).
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

- **Engine revision** — the manual, admin-bumped integer inside a Processing
  signature (`admin_config.engine_revision`). Doesn't move on its own; an admin
  bumps it via "Mark major update" (atomic, audited) after an engine/LLM swap
  that no code-version constant would otherwise capture.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

- **Stale for reprocess** — a Taxonomy Health dimension (PR3): a valid,
  enriched fact whose Processing signature is absent or behind current. Distinct
  from **stale enrichment version** (the older `classificationPromptVersion`
  lens) — they overlap heavily on legacy data but clear differently: only
  send-back → promote clears stale-for-reprocess; a direct re-enrich never
  stamps a signature.
  → [taxonomy-and-enrichment](./taxonomy-and-enrichment.md)

- **Meme / video meme** — the rendered artifact (`memes` table): a fact rendered to
  an image or video. Free tier = photo memes (your face composited); Legendary =
  AI image/video memes (video: PuLID → image-to-video → captions).
  → [product-brief](./product-brief.md), [visual-pipeline](./visual-pipeline.md)

- **Duplicate detection** — near-duplicate flagging via a 384-dim OpenAI embedding
  on `facts.embedding` (`pgvector`); a candidate match + similarity is recorded on
  the review and the moderator decides.
  → [architecture-map](./architecture-map.md)

- **Async job queue** — the durable `async_jobs` table (queue discriminator + JSON
  payload + dedupe key + retries; status `pending → processing → done | failed`),
  polled by a worker. Enqueue is not completion.
  → [architecture-map](./architecture-map.md), [async-ui-status](./async-ui-status.md)

- **Lane (async-jobs)** — one of five independent scheduling groups (`fast` /
  `render` / `bulk` / `pexels` / `ai_meme_backfill`) the async-jobs worker
  splits queues into, each with its own poll timer, re-entrancy guard, and
  concurrency bound, so slow work in one lane can never delay another's
  *scheduling*. Set per-queue via `registerJobHandler(queue, handler, {
  lane })`; defaults to `bulk`. This isolation is at the scheduling level
  only — all five lanes share one database connection pool, so a DB-heavy
  lane consuming most of `DB_POOL_MAX` can still make another lane's claim
  or heartbeat queries wait.
  → [architecture-map](./architecture-map.md#async-jobs-and-queues)

- **Worker lane heartbeat** — a `worker_lane_heartbeats` row, keyed
  `(instance_id, lane)`, that one worker instance publishes to say a lane is
  still ticking and how many jobs it has in flight. The basis for the Queue
  Health surface's per-lane liveness verdict and the `/api/health/queues`
  public probe — the queue table alone can't distinguish "about to be
  claimed" from "every worker died an hour ago."
  → [architecture-map](./architecture-map.md#worker-liveness-heartbeats--the-queue-health-surface-phase-1-pr-288)

- **Sentinel (`max_attempts`)** — the value `0` on an `async_jobs` row,
  meaning "resolve the retry ceiling from the queue's live `admin_config`
  setting" rather than a fixed per-row override. Replaced with the resolved
  number once a row finalizes to `failed`, so its `abandoned_no_retry`
  classification stays pinned to the ceiling that actually applied, not
  whatever the config says today.
  → [decisions.md](./decisions.md#2026-07-30--queue-health-classification-persists-the-retry-ceiling-at-finalization-instead-of-re-deriving-it-live)

- **Membership tier** — user entitlement level: `unregistered | registered |
  legendary`. Legendary unlocks paid per-render surfaces; separate from the
  `is_admin` flag. There are no consumer "credits" (server-side budget gate).
  → [product-brief](./product-brief.md)

- **Wilson score / leaderboard** — ranking is driven by `facts.wilsonScore` (a
  confidence bound on up/down votes) plus score/comment/share counts.
  → [architecture-map](./architecture-map.md)

- **Workstream** — one unit of work (a feature, a bugfix, a `/document`
  harvest) tracked end-to-end by a single GitHub issue — except
  sensitive/disclosure-carve-out work, which is a private draft Project item
  instead, never a public issue. Runs through the full lifecycle
  (Discovery→UAT) for product-visible work; a pure-docs/devops workstream
  has no product surface to verify and closes out at merge instead, per
  `pr-watch`'s merge rule. Deliberately **not** the same as a session or a
  PR: a workstream outlives both and can span several PRs, which is why it —
  not the PR number — is the stable thing to name and track against.
  → [workstream-tracking](./workstream-tracking.md)

- **State of Play block** — the standard block maintained in a workstream
  issue's body: current stage, whose turn it is, the open question in plain
  language, artifact links, and how to resume. It exists so a workstream can
  be picked up **cold in a fresh session**, which is what makes sessions
  disposable rather than something to keep alive for their scrollback.
  → [workstream-tracking](./workstream-tracking.md)

- **David-gate** — a lifecycle stage only David can move past, marked 🛑 in
  both the board's Status options and the chat interruption banner: Plan
  approval, Merge, and UAT. One glyph means "David" everywhere, so scanning
  for it finds exactly the blocking moments.
  → [workstream-tracking](./workstream-tracking.md)
