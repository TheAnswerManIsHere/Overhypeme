# PR163 — Candidate Visual concepts (Slice 2A, backend) · TEST_RUN

> **Companion UAT:** none in this PR — PR-A1 is backend-only (no UI surface).
> The click-through UAT for the 3-card picker ships with **PR-A2** (the
> frontend). Run this automated checklist; it should be fully green.
>
> **Replit owns the database connection.** Don't set `DATABASE_URL` or any
> test-DB env here — just run the suite; the harness stands up its own DB and
> applies migrations.

---

## 1. What this PR changes (engineering summary)

The frontier visual planner now auto-drafts **three distinct "describe the
picture" concepts** while a fact sits in `production_review`. A moderator picks /
edits / ignores one into the existing **Visual concept** field
(`enrichment.visualPromptStrategyOverride.coreSceneOverride`) — **no new write
surface**. Backend only in this PR.

1. **Migration `0079_facts_visual_concepts.sql`** — adds to `facts`:
   `visual_concept_candidates jsonb`, `visual_concept_status varchar(16)`.
   Idempotent `ADD COLUMN IF NOT EXISTS`; journal idx 79; tag added to
   `SNAPSHOT_EXEMPT_TAGS` (drizzle-kit generate is broken on the malformed 0063
   snapshot). Source of truth: `lib/db/src/schema/facts.ts`. These are
   **transient, latest-only prep metadata** mirroring `pexels_status` — regen
   overwrites; not provenance / history.
2. **`lib/api-zod/src/visualConcepts.ts`** — wire schema (loose arrays; the
   exactly-3 rule is enforced in `validateCandidateConcepts`, matching how strict
   OpenAI structured outputs reject `minItems`/`maxItems`);
   `sanitizeCandidateSceneText` canonicalizes name tokens + token-validates each
   candidate **at store time using the exact rules the `coreSceneOverride` save
   superRefine applies** (so a picked candidate can never fail the save), and caps
   to the 1500-char `coreSceneOverride` budget; the stored blob + normalized
   response types.
3. **`lib/imagePrompt/generator.ts`** — extracted
   `buildImagePromptContextBlocks(input, opts)` with granular per-block include
   flags. **Behavior-preserving**: the render planner passes `PLANNER_CONTEXT_OPTS`
   (all-true) → the emitted message is byte-identical to before. Candidate gen
   passes the **mode-agnostic subset** (fact text, taxonomy, render policy,
   authored strategy, examples, cultural refs, semantic entities) and **omits** the
   runtime blocks (source-image, subjectRenderMode, identity, render controls,
   style, target engine).
4. **`lib/visualConcepts/generator.ts`** — one frontier structured-outputs call
   returns all 3; engine resolved via `fact_visual_concepts_engine_id` (default
   `openai-visual-planner`) with fallback provenance.
5. **`lib/visualConceptsConfig.ts`** — `fact_visual_concepts_system` +
   `fact_visual_concepts_engine_id`, seeded idempotently at boot.
6. **`lib/visualConceptJobs.ts`** — durable `fact_visual_concepts` queue.
   Review-aware `{text, enrichment}` via `resolveReviewCycleEnrichment`
   (first-time → staging enrichment; refresh → candidate-version enrichment).
   Cost-guarded no-op once the review is resolved; `onAbandon` → `failed`. The
   **server computes** whether stored candidates are current for the review.
7. Best-effort **non-blocking** enqueue on the `production_review` transition
   (`advanceReviewForStagingFactEnrichment`), inlined with the literal queue name
   to avoid a module cycle.
8. **`POST /admin/reviews/:id/visual-concepts/regenerate`** (optional
   `coreSceneDraft` body → `existing_draft_context`; never persisted) and a
   normalized `visualConcepts` block on **`GET /admin/reviews/:id`**.
9. Registered the barrel export in `lib/api-spec/patch-generated.mjs` so it
   survives the `pretest` / `post-merge` codegen that rewrites the api-zod index.

## 2. What is deliberately NOT shipped

- **No picker UI** — the 3-card component, prep pill, and Regenerate button are
  PR-A2. This PR ships nothing a moderator can click; verify it via the checks
  below (and the API by hand if desired).
- **No eval harness** — golden set / ratings / eval runs are PR-B1/B2.
- **No change to the render planner's output** — the generator refactor is
  behavior-preserving (see §4).
- **Refresh-review candidates stay on the live fact row** as admin-transient prep
  metadata (documented `TODO(versioning-integration)` to move them review-side);
  a rejected refresh may leave stale candidate metadata, which is harmless and
  hidden by the server `current` flag.

## 3. Automated checks to run

```bash
# From repo root. Typecheck (also runs the module-cycle + no-console guards):
pnpm --filter @workspace/api-server run typecheck
pnpm run typecheck:libs

# Migration snapshot integrity (0079 exempt tag):
pnpm --filter @workspace/db check-snapshots

# Full api-server suite (sharded; stands up its own DB + applies migrations):
pnpm --filter @workspace/api-server test
```

**Expected:** typecheck + snapshot check clean. The api-server suite reports
`result=pass` **except** the pre-existing Stripe-webhook integration tests, which
fail only when `STRIPE_SECRET_KEY_TEST` is unset (they are unrelated to this PR —
confirm the failures all read `Stripe credentials not configured`). Every new
`visualConcept*` test must pass.

## 4. Targeted assertions to confirm

- **`imagePromptUserMessage.test.ts`** (the generator refactor's safety net) —
  all existing tests stay green, proving `buildImagePromptUserMessage` is
  **byte-identical** after the `buildImagePromptContextBlocks` extraction.
- **`visualConcepts.test.ts`**
  - `validateCandidateConcepts` accepts exactly 3, rejects 2/4 and empty
    title/scene.
  - `sanitizeCandidateSceneText` canonicalizes `{name}`/`{Name}` → `{NAME}`,
    flags an unknown token `tokenValid:false`, and caps at 1500 chars.
  - The candidate user message **INCLUDES** fact text / taxonomy / render policy /
    authored strategy / cultural refs / semantic entities and **OMITS**
    SOURCE-IMAGE ANALYSIS / RESOLVED subjectRenderMode / RESOLVED generationMode /
    IDENTITY POLICY / RENDER CONTROLS / TARGET ENGINE.
  - A blank field → no moderator-scene block; a draft → `existing_draft_context`
    ("distinct alternatives"), **never** the AUTHORITATIVE directive, and appears
    once (not echoed 3×).
  - `generateVisualConceptsWithModel` retries once on a bad count, then throws.
- **`visualConceptJobs.test.ts`** (DB-backed; generator stubbed off the network)
  - Handler writes 3 candidates + status `ok`, stamping `reviewId`, `source:
    "staging_fact"`, `candidateVersionId: null`, and a non-empty `inputHash`.
  - **No-op** (writes nothing; status stays `null`) when the review is resolved
    (`production_rejected`).
  - A generation throw returns a retryable failure and leaves status `pending`
    (`failed` is `onAbandon`-only).
  - `buildVisualConceptsResponse` → `current:true` right after a write, then
    `current:false` / `staleReason:"input_hash_mismatch"` once a render-affecting
    enrichment field changes; `review_mismatch` when the blob's `reviewId`
    differs; status-only (no candidates) when there's no blob.
  - `POST …/visual-concepts/regenerate` → `202` + status `pending` + a
    `fact_visual_concepts` job enqueued (dedupe key
    `fact_visual_concepts:review:<id>`); **401/403** for a non-admin; **409**
    off `production_review`.
  - `GET /admin/reviews/:id` surfaces the `visualConcepts` block once candidates
    exist.

## 5. Live model smoke (needs an OpenAI key — could not run in the build sandbox)

1. Confirm the `openai-visual-planner` engine row exists (boot reconciler) and
   the two `fact_visual_concepts_*` admin_config keys seeded.
2. Provisionally-approve a fact so it reaches `production_review`; after
   enrichment succeeds, confirm a `fact_visual_concepts` job runs and
   `facts.visual_concept_candidates` fills with **3** candidates + status `ok`.
   Spot-check each `sceneDescription` uses `{NAME}` (not a concrete name) and
   carries no reference-image / identity / style language.
3. `POST /admin/reviews/:id/visual-concepts/regenerate` with a `coreSceneDraft`
   → status flips to `pending`, then a fresh set of 3 distinct candidates lands.
   Confirm the draft is **not** persisted to the fact's `coreSceneOverride`.

## 6. Gotchas

- **Migration order:** if `0079` collides on `main` (a parallel branch also added
  a migration), it must be renumbered before merge — confirm `0079_facts_visual_concepts`
  is the next free index against current `main`.
- If the api-zod `visualConcepts` export goes missing after a codegen/merge run,
  the fix is the allowlist entry in `lib/api-spec/patch-generated.mjs` (the
  codegen rewrites `lib/api-zod/src/index.ts` from a hardcoded list).
- The candidate job **never gates** the workflow: a concept failure leaves the
  review in `production_review` with `visual_concept_status:"failed"` — the
  moderator writes the Visual concept by hand, exactly as today.
