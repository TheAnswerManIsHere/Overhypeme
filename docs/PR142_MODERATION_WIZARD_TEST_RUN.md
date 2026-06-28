# PR142 — Moderation Wizard + Multi-Scenario Test Renders — Test Run (Replit)

Engineering/automated checklist for the technical safety net. David's
click-through lives in `PR142_MODERATION_WIZARD_UAT.md`.

## Scope

PR 1 of the moderation redesign: two-step review wizard, durable server-side
render-scenario orchestration, i2i unlock, and an admin-waivable approval gate.

## Database

Apply migrations (Replit owns the DB connection). New migration:
`0076_moderation_render_scenarios`.

Confirm after migrate:

```sql
-- image_prompt_attempts gains 6 nullable scenario columns
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'image_prompt_attempts'
   AND column_name LIKE 'review%';
-- expect: review_id, review_reference_asset_version, review_reference_identity_type,
--         review_render_batch_id, review_render_input_hash, review_render_scenario_key

-- pending_reviews gains the waiver column
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'pending_reviews' AND column_name = 'visual_render_approval_waiver';
-- expect: visual_render_approval_waiver

-- indexes present
SELECT indexname FROM pg_indexes
 WHERE tablename = 'image_prompt_attempts'
   AND indexname IN ('IDX_ipa_review_scenario_created','IDX_ipa_review_input_hash','IDX_ipa_review_only');
```

- Migration is idempotent (`IF NOT EXISTS` + the hash-based runner) and adds only
  **nullable** columns — existing `image_prompt_attempts` rows are unaffected
  (no backfill). The migration is hand-authored and registered in
  `SNAPSHOT_EXEMPT_TAGS`; `pnpm --filter @workspace/db check-snapshots` passes.

## Commands + expected results

```bash
# Snapshot chain integrity
pnpm --filter @workspace/db check-snapshots          # ✓ all journal entries OK

# Typecheck (both packages)
pnpm --filter @workspace/db typecheck                # exit 0
( cd artifacts/api-server && pnpm typecheck )        # tsc -b + cycles + no-console, exit 0
( cd artifacts/overhype-me && pnpm typecheck )       # tsc -b, exit 0

# New unit + integration tests
( cd artifacts/api-server && node --import tsx/esm --test src/__tests__/factRenderScenarios.test.ts )
#   -> 14 pass / 0 fail
( cd artifacts/api-server && node --import tsx/esm --test src/__tests__/reviewRenderScenarios.routes.test.ts )
#   -> 9 pass / 0 fail
( cd artifacts/api-server && node --import tsx/esm --test src/__tests__/routes.reviews.test.ts )
#   -> 51 pass / 0 fail  (existing approval tests now waive; see below)

# Frontend suite
( cd artifacts/overhype-me && npx vitest run )       # 574 pass / 51 files
```

### Known PRE-EXISTING failures (NOT introduced by this PR)

A full `node --test 'src/**/*.test.ts'` reports ~47 failures in this sandbox,
all environmental and unrelated to this PR:

- `routes.facts.hero` — asserts `"DB must have at least one real active fact"`
  (seed-data precondition; the local test DB has no active facts).
- `csrf.integration`, Resend auth-failure, and the Stripe webhook / dispute /
  invoice "Task #230" suites — require external config (CSRF origins, Resend
  keys, Stripe fixtures) not present here.

None of these import the modules this PR touches. Verify by confirming the same
set fails on `origin/main`.

## What to verify functionally (no worker runs in unit tests)

1. **Auto-trigger:** when `advanceReviewForStagingFactEnrichment` transitions a
   review `prep_pending → production_review`, exactly one
   `review_render_scenarios_prepare` job is enqueued (deduped by
   `review_render_prep:<reviewId>`); stale outcomes / `terminal_failed` do not
   enqueue. The job calls `ensureDefaultReviewRenders` which enqueues the default
   batch idempotently (re-run enqueues nothing for the same input hash).
2. **i2i path:** i2i scenarios route through `nano-banana-2-edit` (the derived
   `actualImageEngineId`, not the legacy `target_engine` literal). A missing
   default reference produces a **failed attempt before any paid fal work**
   (`error LIKE 'reference_asset_unavailable%'`).
3. **Stale detection (server-side):** editing a render-affecting field
   (modifier / override / look style / reference asset version) changes the
   scenario input hash → prior attempts read as `stale`; editing an admin-only
   field (adminReviewNotes / hashtags / taxonomyConfidence) does **not**.
4. **Approval gate:** `POST /admin/reviews/:id/approve-for-production` returns
   `409 { error: "visual_render_incomplete", problems: [...] }` when a required
   scenario (generic_t2i / i2i_male_default / i2i_female_default) is
   missing/failed/blocked/stale, unless the body waives the **exact** named
   problems (`waiveVisualRenderIssues: true`, `waivedScenarioKeys: [...]`); the
   waiver persists to `pending_reviews.visual_render_approval_waiver`.
5. **No production pollution:** moderation test renders carry
   `renderControls.mirrorToLegacyStorage = false` — they never mirror into
   `facts.aiMemeImages` / `user_ai_images`.

## Routes added

- `GET  /api/admin/reviews/:id/render-scenarios`
- `POST /api/admin/reviews/:id/render-scenarios` `{ scenarios, force? }`
- `GET  /api/admin/reviews/:id/render-scenarios/:scenarioKey/attempts/:attemptId`
- `GET  /api/admin/render-references/health`
- `POST /api/admin/reviews/:id/approve-for-production` — now enforces the gate.

The legacy `POST /admin/reviews/:id/render` route remains as a compat shim (its
UI use is removed); its tests still pass.

## Deliberately NOT shipped in PR 1

- **Female / non-human default reference images** — David provides these (see
  `artifacts/api-server/src/assets/render-references/README.md`). i2i male + t2i
  work now; female/non-human render once the assets land.
- **Non-human auto-run** — conservative: manual-force only this PR (no
  subject-identity classifier yet).
- **Exhaustive per-field tooltips + naming pass** — PR 2.
- **Edit Fact back-port** — PR 3 (the Step-2 components are entity-agnostic so
  it's wiring, not a rebuild).
- **Video test render** — future.
