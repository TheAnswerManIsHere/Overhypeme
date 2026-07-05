# Glossary

> Fast lookup for Overhype.me's product-specific terms — two sentences each, with
> a pointer to the deep doc. When a term's meaning changes, fix it here **and** in
> the deep doc.

- **Fact** — the core content entity: an exaggerated, personalizable statement
  stored once as a **tokenized template** (`facts` table, `text` column) and
  rendered on demand for any name/pronoun set. Not stored per-name.
  → [product-brief](./product-brief.md), [token-rendering](./token-rendering-and-grammar.md)

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

- **Processing signature** — intended stamp of the engine/prompt/code revision an
  enrichment was generated under (for staleness). **Currently a TODO** — columns
  exist, nothing computes one yet.
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

- **Membership tier** — user entitlement level: `unregistered | registered |
  legendary`. Legendary unlocks paid per-render surfaces; separate from the
  `is_admin` flag. There are no consumer "credits" (server-side budget gate).
  → [product-brief](./product-brief.md)

- **Wilson score / leaderboard** — ranking is driven by `facts.wilsonScore` (a
  confidence bound on up/down votes) plus score/comment/share counts.
  → [architecture-map](./architecture-map.md)
