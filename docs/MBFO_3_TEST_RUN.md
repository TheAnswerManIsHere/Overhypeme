# MBFO-3 — Automated test run

This is the engineering-side checklist for the Meme Builder Flow
Overhaul, Session 3 (Step 2 image flow — locked preview with drag-to-
reposition, tier-aware source segmented control, gender-filtered stock
picker, self-upload + AI tabs, aspect ratio toggle, text/typography
drawers, "Make my meme" save flow, and the new PuLID job/poll endpoints
that drive the realistic loading takeover). Hand it to Replit (or run
it locally) to confirm everything MBFO-3 introduced is wired correctly.

The User Acceptance Test is in [`MBFO_3_UAT.md`](./MBFO_3_UAT.md) — that
one is for the product owner to walk through in a browser.

Prior session equivalents:
- [`MBFO_2_TEST_RUN.md`](./MBFO_2_TEST_RUN.md) / [`MBFO_2_UAT.md`](./MBFO_2_UAT.md)
- [`MBFO_1_TEST_RUN.md`](./MBFO_1_TEST_RUN.md) / [`MBFO_1_UAT.md`](./MBFO_1_UAT.md)

---

## TL;DR

```bash
# 1. No new migrations in MBFO-3 — the only schema touch is a runtime
#    admin_config upsert for the EMA (key: pulid_expected_run_ms_ema).
#    Still re-apply to be safe so the test DB is at chain head.
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck.
pnpm typecheck

# 4. Frontend tests (28 new + 428 existing).
cd artifacts/overhype-me && pnpm exec vitest run

# 5. Server unit tests for the new PuLID job endpoints.
cd artifacts/api-server && \
  DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test src/__tests__/pulidJobs.test.ts

# 6. DB package tests (snapshot integrity + journal).
pnpm --filter @workspace/db test

# 7. Production build still emits cleanly.
cd artifacts/overhype-me && pnpm exec vite build

# 8. Boot smoke: dev server starts with the wizard flag on.
PORT=5180 BASE_PATH=/ VITE_MBFO_WIZARD=1 \
  pnpm --filter overhype-me exec vite --config vite.config.ts --host 127.0.0.1
```

If everything above is green, you can stop. Sections below break each
step out in case anything fails.

---

## A — Setup gate

Run before each pass. Environment checks, not behavior checks.

### A1. Test DB is up

The session-start hook brings up Postgres on `:5432` and applies the
schema. Confirm with:

> `Test DB ready at postgres://overhype:overhype@localhost:5432/overhype_test`

### A2. No new migration to verify

MBFO-3 ships **zero new SQL migration files**. The PuLID expected-run
EMA is held in the existing `admin_config` table (key
`pulid_expected_run_ms_ema`) and is upserted lazily by the route the
first time a generation completes. Sanity check:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
  -c "\d admin_config"
```

Pass criterion: `admin_config` table exists with `key` PK + `value`
column (matches MBFO-1's schema; no shape change).

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db check-snapshots
```

Pass criterion:

> `✓ All 55 journal entries have snapshot files (or are explicitly exempt).`
> `✓ Snapshot chain is valid (46 snapshots, all prevId links correct).`

(Counts identical to MBFO-2 — no new migrations.)

### A4. DB unit tests

```bash
pnpm --filter @workspace/db test
```

Pass criterion: 5 tests pass, 0 fail.

### A5. Production build

```bash
cd artifacts/overhype-me && pnpm exec vite build
```

Pass criterion: exits 0 in ~10 seconds. The Vite chunk-size warning is
pre-existing and unrelated to MBFO-3.

---

## B — Vitest suite (frontend)

```bash
cd artifacts/overhype-me && pnpm exec vitest run
```

Expected: **32 files / 456 tests pass, 0 fail** (was 27 / 428 after
MBFO-2; +28 new tests in 5 new files).

### B1. Source segmented control

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-image/__tests__/SourceSegmentedControl
```

Pass criterion: **12 tests pass**. Matrix:

- Three tabs render
- Anonymous → tapping `Your photo` triggers signup callback (not select)
- Free → tapping `AI you` triggers upgrade callback (not select)
- Legendary → all three tabs unlocked, no callbacks fire
- Locked AI tab renders the `LEGEND` typeset badge (no 👑 emoji)
- Locked Your photo tab renders the `SIGN UP` typeset badge
- `pickDefaultSourceTab(tier, hasPrimaryPhoto)` returns the right tab
  for all 6 cells of the matrix

### B2. Aspect ratio toggle

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-image/__tests__/AspectRatioToggle
```

Pass criterion: **2 tests pass**. Covers `aria-checked` on the active
button and `onChange` callback firing with the new ratio.

### B3. Split logic + collision constraints

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-image/__tests__/splitLogic
```

Pass criterion: **5 tests pass**. Covers:

- `getWords` drops empties + splits on whitespace
- `intelligentSplit` returns the word count for very short texts
- `intelligentSplit` prefers punctuation-anchored breaks near the middle
- `intelligentSplit` falls back to the middle when nothing is nearby
- `computeTextCollisionConstraints` keeps `maxTopY` / `minBottomY` in
  range and away from the opposite text block

### B4. Pronouns → stock gender

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-image/__tests__/pronounsToStockGender
```

Pass criterion: **3 tests pass**. `he/* → male`, `she/* → female`,
everything else (including null/undefined/empty string) → `neutral`.

### B5. Save payload mapper

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-image/__tests__/saveMemePayload
```

Pass criterion: **5 tests pass**. The wizard-state → POST-body
discriminated-union mapping:

| Wizard input                                                  | Expected `imageSource`         | `imageTransform` |
|---------------------------------------------------------------|--------------------------------|------------------|
| no source                                                     | (returns null)                 | —                |
| `source.kind=stock`, stockImageId=999                         | `{ type:"stock", pexelsPhotoId:999 }` | undefined |
| `source=self-upload + primary + stylize=false`                | `{ type:"identity" }`          | undefined        |
| `source=self-upload + library + stylize=false`                | `{ type:"upload", uploadKey:"/objects/foo.jpg" }` | undefined |
| `source=self-upload + stylize=true`, no PuLID key             | (returns null)                 | —                |
| `source=self-upload + stylize=true`, PuLID key provided       | `{ type:"upload", uploadKey:"/objects/pulid-result.jpg" }` | `"pulid"` |

### B6. Wizard shell regression

```bash
pnpm exec vitest run src/components/meme-builder/wizard/__tests__/MemeBuilderWizard
```

Pass criterion: **9 tests pass**. Note that the wizard no longer
renders its own `WizardPrimaryAction` button on Step 2 — Step 2 owns
the button internally because the PuLID branch needs to swap it for
the loading takeover. The `wizard-primary-action` test ID now belongs
to the button rendered by `Step2Image`.

### B7. Existing meme-builder suite (regression)

```bash
pnpm exec vitest run src/components/meme-builder
```

Pass criterion: 80+ tests pass. MBFO-3 modifies one shipped file
(`parts/LivePreview.tsx` got two optional props: `framingOffset` and
`canvasRef`) — neither is required, so all existing call sites
compile and behave unchanged.

---

## C — API server tests

Run from `artifacts/api-server`:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test src/__tests__/pulidJobs.test.ts
```

Pass criterion: **10 tests pass**. The matrix:

| #  | Surface                                            | Check                                                      |
|----|----------------------------------------------------|------------------------------------------------------------|
| C1 | `GET /memes/pulid-jobs/:jobId` — unauthenticated    | 401                                                        |
| C2 | `GET /memes/pulid-jobs/:jobId` — wrong owner        | 403                                                        |
| C3 | `GET /memes/pulid-jobs/:jobId` — unknown jobId     | 404                                                        |
| C4 | `GET /memes/pulid-jobs/:jobId` — happy path        | 200, progress ∈ [0.3, 1) for in-progress phase             |
| C5 | `POST /memes/pulid-jobs` — non-legendary tier      | 403 (`requireLegendary` middleware)                        |
| C6 | `POST /memes/pulid-jobs` — missing factId          | 400                                                        |
| C7 | `POST /memes/pulid-jobs` — invalid referencePath   | 400 (must start with `/objects/`)                          |
| C8 | `computeProgress` — queued phase                   | 0.05 ≤ progress ≤ 0.30                                     |
| C9 | `computeProgress` — completed                      | 1.0 exactly                                                |
| C10| `computeProgress` — climbs with elapsed time       | late tick > early tick, both < 1                           |

Cleanup is automatic — tests use the `__testHooks.jobs` map and clean
up in `before`/`after`.

**The full fal.subscribe end-to-end path is intentionally NOT
exercised by automated tests** because each call costs real money. The
happy-path completion (job → save → permalink) is in the UAT.

### C2. Pre-existing failures that are NOT MBFO-3 regressions

If you run the broader phase3 lineage tests
(`src/__tests__/phase3.lineage.integration.test.ts`), two subtests
fail:

- `rejects an invalid transform value via CHECK constraint`
- `accepts NULL, 'pulid', and 'pulid_fallback_text' but rejects garbage`

Both fail on `main` at the parent commit (`166c217`) too — they expect
a Postgres CHECK constraint that `drizzle-kit push` does not install
in the test DB. Not introduced by MBFO-3; do not flag.

### C3. Sharded test runner mismatch

`pnpm --filter @workspace/api-server test` invokes
`scripts/run-tests-sharded.sh`, which uses `--test-isolation=none`.
That flag was promoted out of `--experimental-test-isolation` in a
node release later than what this sandbox runs. Workaround: invoke
individual test files via `node --import tsx/esm --test <path>` as in
the C-block command above. Not introduced by MBFO-3.

---

## D — Dev server smoke (Replit-specific)

```bash
cd artifacts/overhype-me && VITE_MBFO_WIZARD=1 pnpm dev
```

### D1. Dev server boots cleanly

Watch the boot log for `ready in <1s` (typical on Replit hardware:
~430-520ms). No `[vite] error` lines.

### D2. Step 2 mounts when image is selected

In a separate shell, hit a fact route and confirm the SPA shell HTML
loads:

```bash
curl -s http://localhost:5180/f/<fact-slug> | grep -c "<div id=\"root\""
```

Pass criterion: prints `1`. The wizard hydration tree is browser-side;
the visual confirmation is in [`MBFO_3_UAT.md`](./MBFO_3_UAT.md).

### D3. Stock photos endpoint reachable

```bash
curl -s "http://localhost:<api-port>/api/facts/<fact-id>/pexels-images?gender=neutral"
```

Pass criterion: returns `{"photos":[...]}`. This is the data source
the Step 2 stock picker reads.

### D4. PuLID job endpoint structure check

Confirm the new endpoints are mounted (without actually invoking
fal.ai):

```bash
# Unauthenticated GET — should be 401, not 404.
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:<api-port>/api/memes/pulid-jobs/nonexistent
```

Pass criterion: `401`. (`404` would mean the route is not mounted.)

```bash
# Unauthenticated POST — should be 401, not 404.
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost:<api-port>/api/memes/pulid-jobs \
  -H "Content-Type: application/json" -d '{}'
```

Pass criterion: `401`. The tier-gate (`requireLegendary`) is layered
on top of auth, so the response is auth-first.

---

## E — End-to-end happy paths (manual)

These touch real `/api/memes` saves and read the DB. Run against the
test DB or a throwaway dev account.

### E1. Stock save round-trip

In a browser (or via curl with a valid session):

1. Open the wizard, pick `image` in Step 1.
2. In Step 2, pick a stock thumbnail.
3. Tap `Make my meme`.
4. Confirm: HTTP 200 from `POST /api/memes`; response includes
   `permalinkSlug` (10-char nanoid); page navigates to `/m/<slug>`;
   the meme is visible.
5. Confirm row in DB:
   ```bash
   PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
     -c "SELECT id, fact_id, image_transform FROM memes \
         WHERE permalink_slug='<slug>';"
   ```
   `image_transform` should be **NULL** (stock saves are not PuLID).

### E2. Self-upload save (no AI)

1. Open wizard, image → Step 2.
2. Source = `Your photo` tab → `Upload new` → drag-drop a JPG.
3. Wait for moderation to clear (state moves to `ready`).
4. Tap `Make my meme`.
5. Confirm 200, `imageTransform` field is NULL, the upload object_path
   is referenced as `imageSource.uploadKey`.

### E3. AI you save (Legendary; expensive — only run when you're ready
to spend ~$0.04 of fal credits)

1. As Legendary, open wizard, image → Step 2.
2. Source = `AI you` tab → select Primary (or any uploaded photo).
3. Tap `Make my meme`. The PuLID loading takeover mounts.
4. The progress bar should advance to ~30% within a few seconds
   (queue), then climb asymptotically toward 95% over the next ~18s
   (in-progress), then jump to 100% on completion.
5. The page navigates to `/m/<slug>`. The meme row has
   `image_transform = 'pulid'`.

---

## F — Feature flag off-state (regression)

```bash
cd artifacts/overhype-me && pnpm dev   # NO VITE_MBFO_WIZARD
```

| #  | Check                              | Pass criterion                                                      |
|----|------------------------------------|---------------------------------------------------------------------|
| F1 | Production path unchanged          | `FactDetail` mounts the Phase-3 `MemeStudio`, not the wizard        |
| F2 | `/api/memes/pulid-jobs` reachable  | Endpoint is independent of the flag — responds 401 to unauth GET   |
| F3 | `/api/memes` save path unaffected  | The MBFO-3 endpoints are sidecars; existing save endpoint untouched |

The detailed in-browser regression walk-through is the flag-OFF half
of [`MBFO_3_UAT.md`](./MBFO_3_UAT.md), section A.

---

## G — Adjacent feature regression smoke

| #  | Area                              | Check                                                       |
|----|-----------------------------------|-------------------------------------------------------------|
| G1 | Share modal (Phase 6)             | `pnpm exec vitest run src/components/share` — all pass      |
| G2 | Existing meme builder (Phase 3)   | `pnpm exec vitest run src/components/meme-builder/__tests__` — all pass |
| G3 | Wizard shell from MBFO-1          | `pnpm exec vitest run src/components/meme-builder/wizard/__tests__` — all pass |
| G4 | Step 1 from MBFO-2                | `pnpm exec vitest run src/components/meme-builder/wizard/steps/Step1ArtifactType` — all pass |
| G5 | Hero examples endpoint (MBFO-2)   | `curl /api/hero-examples` — still responds                  |
| G6 | `aiMemePipeline` callers          | The added `onProgress` parameter is optional; existing callers in `/memes/ai/:factId/generate`, `routes/admin.ts`, `routes/reviews.ts` still compile and behave unchanged |

---

## H — Performance + observability spot-checks

### H1. Live preview re-render debounce

In Chrome DevTools → Performance, record while dragging the framing
offset on Step 2. The `LivePreview` canvas should repaint at most
once per ~150ms (the debounce window). If you see 60fps repaints, the
debounce is broken.

### H2. PuLID job EMA persists

After E3 completes successfully, the EMA row should exist in
`admin_config`:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
  -c "SELECT key, value, updated_at FROM admin_config \
      WHERE key='pulid_expected_run_ms_ema';"
```

Pass criterion: one row, `value` between 3000 and 120000 (the clamped
range in `lib/pulidExpectedRunMs.ts`), `updated_at` recent.

### H3. Job map garbage collection

The in-memory `jobs` Map runs `gc()` on every POST and GET. Stale
jobs (older than 10 min) get cleaned up automatically. To verify
without waiting 10 minutes, run the targeted test file in C above —
the in-process map is cleared between test contexts via the
`__testHooks` export.

---

## What MBFO-3 explicitly does NOT ship

These are deliberately out of scope and will appear in subsequent
sessions. If you hit them while testing, that's expected — not a
failure:

- **The video flow.** Step 2 currently routes `artifactType="video"`
  to a placeholder panel ("Video flow coming in MBFO-4."). The full
  video pipeline (PuLID stylize → Grok Imagine → auto-subtitle) lands
  in MBFO-4.
- **`split_token_index` backfill pipeline.** The `facts.split_token_index`
  column exists (MBFO-1) but is not yet populated by the
  fact-creation route. Until the gpt-4o-mini backfill is wired up,
  the wizard's split slider defaults to the client-side
  `intelligentSplit` heuristic for every fact.
- **No-face → text fallback in the save flow.** When PuLID returns
  `no_face`, the server-side `pulid_fallback_text` path exists but
  isn't surfaced through the wizard's save call yet; the user sees
  an inline error message instead. Wiring lands in MBFO-4 alongside
  the video flow's similar fallback.
- **Stripe Embedded Checkout** inside the upgrade modal. Still a
  redirect to `/pricing`.
- **`MemeStudio` (Phase-3 builder) removal.** Stays in place behind
  `VITE_MBFO_WIZARD=0` until all of MBFO ships. Cleanup at the end of
  MBFO-5.
- **`fal-ai/workflow-utilities/auto-subtitle`.** Not wired (MBFO-4).

---

## Known divergences from the shared MBFO context

Re-stating what was flagged at PR-merge time so future sessions don't
re-litigate:

- **Show-all toggle** in the stock picker performs a **gender-grouped
  union** (male → female → neutral, deduped by photo id), not an
  interleaved or shuffled mix. Open question flagged for follow-up
  testing.
- **Split slider** is rebuilt on Radix `components/ui/slider.tsx`
  instead of cloning the raw `<input type="range">` from the legacy
  builder. The snap-to-word-boundary and collision-clamp logic was
  lifted verbatim into `step2-image/sliders/splitLogic.ts`.
- **EMA storage** lives in `admin_config` under
  `pulid_expected_run_ms_ema` (default 18000ms; clamped 3000-120000;
  α=0.2). No new table.
- **`UnifiedUpgradeModal` 👑 emoji** is still in the shipped copy
  even though the design doc tags emoji decoration as an
  anti-pattern. Per the doc's own "shipped code wins" rule, MBFO-3
  did not touch it. Flagged for a follow-up doc reconciliation.
- **Branch this work shipped on** was
  `claude/setup-mbfo-wizard-rTyMG` (per harness mandate), not
  `mbfo`.
