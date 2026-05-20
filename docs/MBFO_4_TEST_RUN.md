# MBFO-4 — Automated test run

This is the engineering-side checklist for the Meme Builder Flow
Overhaul, Session 4 (Step 2 video flow — full video pipeline behind
the wizard, look/motion style decoupling, data-driven engine
interpreter, async multi-stage video job route, stylize-then-video
checkpoint, image-mode no-face explicit choice). Hand it to Replit
(or run it locally) to confirm everything MBFO-4 introduced is wired
correctly.

The User Acceptance Test is in [`MBFO_4_UAT.md`](./MBFO_4_UAT.md) —
that one is for the product owner to walk through in a browser.

Prior session equivalents:

- [`MBFO_3_TEST_RUN.md`](./MBFO_3_TEST_RUN.md) / [`MBFO_3_UAT.md`](./MBFO_3_UAT.md)
- [`MBFO_2_TEST_RUN.md`](./MBFO_2_TEST_RUN.md) / [`MBFO_2_UAT.md`](./MBFO_2_UAT.md)
- [`MBFO_1_TEST_RUN.md`](./MBFO_1_TEST_RUN.md) / [`MBFO_1_UAT.md`](./MBFO_1_UAT.md)

---

## TL;DR

```bash
# 1. Apply the two new migrations (DDL in 0056, seed in 0057).
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck.
pnpm typecheck

# 4. Frontend tests (46 new + 441 existing = 487 total).
cd artifacts/overhype-me && pnpm exec vitest run

# 5. Server unit tests for MBFO-4 (49 new across 4 files).
cd artifacts/api-server && \
  DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/engineInterpreter.test.ts \
    src/__tests__/engineAudio.test.ts \
    src/__tests__/videoJobs.test.ts \
    src/__tests__/createMemeRecord.test.ts

# 6. Regression sweep on the surfaces MBFO-4 refactored.
cd artifacts/api-server && \
  DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/routes.memes.test.ts \
    src/__tests__/phase4.memes.save.test.ts \
    src/__tests__/phase4.validators.test.ts \
    src/__tests__/phase4.composite.test.ts \
    src/__tests__/budgetGate.test.ts \
    src/__tests__/pulidJobs.test.ts

# 7. DB package tests (snapshot integrity + journal).
pnpm --filter @workspace/db test

# 8. Production build still emits cleanly.
cd artifacts/overhype-me && pnpm exec vite build

# 9. Boot smoke: dev server starts with the wizard flag on.
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

### A2. New migrations apply cleanly

MBFO-4 ships **two** new SQL migration files:

- `0056_steady_mongoose.sql` — DDL for the `engines` and `look_styles`
  tables; renames `video_styles → motion_presets`; adds
  `artifact_type`, `video_object_path`, `video_job_id`,
  `look_style_id`, `motion_preset_id` to `memes`; adds engine-id +
  stage-cost + checkpoint columns to `video_jobs`.
- `0057_mbfo4_seed_engines_and_look_styles.sql` — pure DML: seeds 7
  engine rows and the 19 look-style rows. Registered as
  snapshot-exempt in `scripts/check-migration-snapshots.ts`.

```bash
pnpm --filter @workspace/db run migrate
```

Pass criterion: `Done: 58 applied, 0 already up-to-date`.

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db check-snapshots
```

Pass criterion:

> `✓ All 58 journal entries have snapshot files (or are explicitly exempt).`
> `✓ Snapshot chain is valid (47 snapshots, all prevId links correct).`

(Counts: +3 journal entries since MBFO-3, +1 snapshot — 0057 is
exempt.)

### A4. Seeded data is present

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, kind, is_default FROM engines ORDER BY sort_order;" && \
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT COUNT(*) AS look_style_count FROM look_styles;"
```

Pass criteria:

- Engines table contains exactly **7 rows**: `veo-3.1-lite` (kind=video,
  is_default=t), `veo-3.1-fast`, `kling-v3-standard`, `seedance-2.0-fast`,
  `grok-imagine` (all video, is_default=f), `pulid-flux` (image,
  is_default=t), `fal-auto-subtitle` (utility, is_default=t).
- look_styles has **19 rows**.

### A5. DB unit tests

```bash
pnpm --filter @workspace/db test
```

Pass criterion: 5 tests pass, 0 fail.

### A6. Production build

```bash
cd artifacts/overhype-me && pnpm exec vite build
```

Pass criterion: exits 0 in ~13 seconds. The Vite chunk-size warning is
pre-existing and unrelated to MBFO-4.

---

## B — Vitest suite (frontend)

```bash
cd artifacts/overhype-me && pnpm exec vitest run
```

Expected: **40 files / 487 tests pass, 0 fail** (was 32 / 456 after
MBFO-3; +46 new tests in 5 new files across the step2-video tree,
minus net by ~15 tests reorganized — final delta is +31).

### B1. Step 2 video orchestrator

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-video/__tests__/Step2Video
```

Pass criterion: **5 tests pass**. Covers:

- Component mounts with no source → primary action disabled
- With a self-upload source selected → primary action enabled
- Tapping primary action calls the kickoff API with the right payload
- 429 BUDGET_EXCEEDED on kickoff → shows the locked budget screen
- Source-mode default is `stylize-then-video`

### B2. Video advanced options sheet

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-video/__tests__/VideoAdvancedOptionsSheet
```

Pass criterion: **12 tests pass**. Matrix:

- Source-mode radios render and switch state
- Look-style picker reads from `/api/look-styles` mock
- Apply button on look style: disabled when no change pending; enabled
  on uncommitted change; committed once tapped
- Motion preset picker has no Apply button
- Length radios are populated from the selected engine's
  `allowedDurationsSec`
- Quality radios are populated from the selected engine's
  `allowedResolutions`
- Engine mode UI renders only when the engine declares
  `supportedModes`
- Custom mode reveals a multiline text input
- Engine selector renders only when /api/engines returns > 1 engine
- For source mode `use-existing-ai-image`, the look-style is shown
  read-only until the "Use a different style for the video" toggle
  flips on

### B3. God Mode loading takeover

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-video/__tests__/GodModeLoadingTakeover
```

Pass criterion: **12 tests pass**. Phase transitions:

- `queued` / `stage1_pulid` → stage 1 copy ("Forging your likeness…")
- Bar pauses at 25% when phase is `stage1_review`; the checkpoint
  screen mounts
- `stage1_no_face_review` shows the no-face screen with two CTAs
- `stage2_video` / `stage2_subtitle` → stage 2 copy ("Setting you in
  motion…"); bar continues 25→100%
- When source mode bypasses Stage 1: bar resets to 0% and Stage 2
  fills the full bar
- Back/X during Stage 1 shows soft confirm
- Back/X during Stage 2 is disabled with tooltip
- `completed` → triggers `onComplete(permalinkUrl)`
- `failed` with `errorCode = "moderation"` shows locked NSFW reject
  copy
- `failed` with `errorCode = "budget_exceeded"` shows the locked
  budget screen
- `failed` with any other code shows the generic service-unavailable
  copy with retry

### B4. Video checkpoint screen

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-video/__tests__/VideoCheckpointScreen
```

Pass criterion: **10 tests pass**. Buttons fire the right API calls:

- `Animate it` → POST `/proceed`
- `Try a different style` → reveals inline picker of all 19 look
  styles → on selection + confirm, POST `/regenerate` with new id
- `Regenerate this style` → POST `/regenerate` with same id
- `Cancel` → DELETE the job; on response, shows toast confirming
  the still was saved to library
- "Stylizations: N" counter shows when `stage1Attempts >= 2`
- Soft warning appears when `stage1Attempts >= 5`

### B5. Save payload mapper (video)

```bash
pnpm exec vitest run src/components/meme-builder/wizard/step2-video/__tests__/saveVideoMemePayload
```

Pass criterion: **7 tests pass**. Maps wizard state → kickoff body
per source mode (stylize-then-video / use-photo-as-is /
use-existing-ai-image); confirms required fields and that
`engineMode`/`customModePrompt` are stripped when the engine has no
supportedModes.

### B6. Existing wizard suite (regression)

```bash
pnpm exec vitest run src/components/meme-builder/wizard
```

Pass criterion: **128 tests pass** (was 82 after MBFO-3; +46 from
MBFO-4). The MBFO-3 SourceSegmentedControl / aspect-ratio / split
logic / pronouns / save-payload tests are all still green.

### B7. Existing meme-builder suite (regression)

```bash
pnpm exec vitest run src/components/meme-builder
```

Pass criterion: ≥260 tests pass. MBFO-4 added `NoFaceFallbackModal`
and altered `SelfUploadZone` copy + `PulidLoadingTakeover` props (new
optional `onNoFaceReview` callback) — none of those break call sites.

---

## C — API server tests

Run from `artifacts/api-server`:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test \
  src/__tests__/engineInterpreter.test.ts \
  src/__tests__/engineAudio.test.ts \
  src/__tests__/videoJobs.test.ts \
  src/__tests__/createMemeRecord.test.ts
```

Pass criterion: **49 tests pass, 0 fail** across the four new files.

### C1. Engine interpreter

```bash
node --import tsx/esm --test src/__tests__/engineInterpreter.test.ts
```

Pass criterion: **25 tests pass**. Covers per-engine param shape for
Veo Lite / Veo Fast / Kling v3 / Seedance / Grok; required-param
failure modes; default-value fallback; map / string / int / stringInt
/ boolean coercion; static-param merge (including override); unknown
type detection; malformed schema detection.

### C2. Engine audio handling

```bash
node --import tsx/esm --test src/__tests__/engineAudio.test.ts
```

Pass criterion: **10 tests pass**. Each `audioHandling` branch
(`native_lipsync`, `prompt_cue`, `voice_control`,
`native_audio_boolean`, `none`); null/empty/whitespace dialogue
inputs; non-mutation of the caller's params object.

### C3. Video jobs route + pipeline runner

```bash
node --import tsx/esm --test src/__tests__/videoJobs.test.ts
```

Pass criterion: **11 tests pass**.

| #   | Surface                                                       | Check                                                                       |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C3a | `POST /api/memes/video-jobs` — unauthenticated                | 401                                                                         |
| C3b | `POST /api/memes/video-jobs` — non-legendary tier             | 403 (`requireLegendary`)                                                    |
| C3c | `POST /api/memes/video-jobs` — happy path                     | 200 `{ jobId }`; pipeline transitions queued → stage1_pulid → stage1_review |
| C3d | `POST /api/memes/video-jobs` — engine option out of range     | 400 (validation against engine's `allowedDurationsSec` etc.)                |
| C3e | `POST /api/memes/video-jobs` — over budget                    | 429 `BUDGET_EXCEEDED` with `currentSpend`, `limit`, `remainingBudget`       |
| C3f | `POST /api/memes/video-jobs` — sourceMode `use-photo-as-is`   | skips stage1_pulid; lands directly at `stage1_review`                       |
| C3g | `POST /api/memes/video-jobs` — no-face during Stage 1         | parks at `stage1_no_face_review` (NOT silent fallback)                      |
| C3h | `POST /api/memes/video-jobs` — NSFW classifier hit on still   | terminal `failed` with `errorCode = "moderation"`                           |
| C3i | `GET /api/memes/video-jobs/:jobId` — non-owner                | 404 (owner-only)                                                            |
| C3j | `POST /api/memes/video-jobs/:jobId/proceed` at stage1_review  | advances to `stage2_video`                                                  |
| C3k | `POST /api/memes/video-jobs/:jobId/regenerate` + new lookStyle| reruns Stage 1; `stage1Attempts` bumps                                      |
| C3l | `DELETE /api/memes/video-jobs/:jobId`                         | terminal `canceled`; stylized still preserved in user library               |

**The full fal.subscribe end-to-end path is intentionally NOT
exercised by automated tests** because each call costs real money. The
real fal.ai happy path is in the UAT (Section E in
[`MBFO_4_UAT.md`](./MBFO_4_UAT.md)).

### C4. createMemeRecord helper

```bash
node --import tsx/esm --test src/__tests__/createMemeRecord.test.ts
```

Pass criterion: **3 tests pass**.

- Image variant: existing happy path preserved
- Idempotency: same body → same `permalinkSlug`
- Video variant: `artifactType="video"`, `videoObjectPath`,
  `videoJobId`, `lookStyleId`, `motionPresetId` all persisted

### C5. Regression sweep

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test \
  src/__tests__/routes.memes.test.ts \
  src/__tests__/phase4.memes.save.test.ts \
  src/__tests__/phase4.validators.test.ts \
  src/__tests__/phase4.composite.test.ts \
  src/__tests__/budgetGate.test.ts \
  src/__tests__/pulidJobs.test.ts
```

Pass criterion: **120 tests pass**, 0 fail. The MBFO-4 refactor of
`POST /api/memes` to delegate to `createMemeRecord` preserves the
wire shape 1:1. The pulidJobs route gained a new `no_face_review`
phase but its previously-passing tests still pass.

### C6. Pre-existing failures that are NOT MBFO-4 regressions

If you run the entire `--test` suite at once
(`find src/__tests__ -name '*.test.ts' -print0 | xargs -0 node --import tsx/esm --test`),
the totals look like **1160 pass / 42 fail / 1202 total**. Those 42
failures are pre-existing — MBFO-3 already documented two phase-3
lineage tests that fail on `main` due to a CHECK-constraint mismatch
under `drizzle-kit push`, plus several `authMiddleware.fresh.test.ts`
suites that reference removed `User` type properties. None of the
failures are in the MBFO-4 surfaces. If you want a deterministic full
run, pipe the output to a file (`node --test ... > /tmp/run.log 2>&1`).

### C7. Sharded test runner mismatch

`pnpm --filter @workspace/api-server test` invokes
`scripts/run-tests-sharded.sh`, which uses `--test-isolation=none`.
That flag was promoted out of `--experimental-test-isolation` in a
node release later than what this sandbox runs. Workaround: invoke
individual test files via `node --import tsx/esm --test <path>` as in
the C-block command above. **Not introduced by MBFO-4** — flagged in
MBFO-3 too.

---

## D — Dev server smoke (Replit-specific)

```bash
cd artifacts/overhype-me && VITE_MBFO_WIZARD=1 pnpm dev
```

### D1. Dev server boots cleanly

Watch the boot log for `ready in <1s` (typical on Replit hardware:
~430-520ms). No `[vite] error` lines.

### D2. New catalogue endpoints reachable

```bash
# Engines — anonymous gets 401, admin sees all rows.
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:<api-port>/api/engines?kind=video

# Look styles — public.
curl -s http://localhost:<api-port>/api/look-styles | jq '. | length'

# Motion presets — public.
curl -s http://localhost:<api-port>/api/motion-presets | jq '. | length'
```

Pass criteria:

- `/api/engines?kind=video` returns `401` unauthenticated.
- `/api/look-styles` returns an array of **19** look-style rows, each
  with `id`, `label`, `description`, `previewImagePath`, `sortOrder`.
  The `promptSuffix` / `promptSuffixReference` fields are stripped
  (server-only).
- `/api/motion-presets` returns the active motion presets without
  `motionPrompt` (also server-only).

### D3. Video jobs route structure check

```bash
# Unauthenticated GET — should be 401, not 404.
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:<api-port>/api/memes/video-jobs/nonexistent

# Unauthenticated POST — should be 401, not 404.
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost:<api-port>/api/memes/video-jobs \
  -H "Content-Type: application/json" -d '{}'

# Unauthenticated DELETE — should be 401, not 404.
curl -s -o /dev/null -w "%{http_code}\n" \
  -X DELETE http://localhost:<api-port>/api/memes/video-jobs/nonexistent
```

Pass criterion: all three return `401`. A `404` would mean the route
is not mounted at `src/routes/index.ts`.

### D4. Legacy admin endpoints still work

```bash
# These should still return the same data they did pre-MBFO-4.
curl -s http://localhost:<api-port>/api/video-styles | jq '. | length'
```

Pass criterion: returns the active motion presets (the data moved
when the table was renamed, but the legacy admin route still points
at it).

### D5. /api/memes save endpoint accepts the new variant

```bash
# As a logged-in legendary user, POST a video variant body to verify
# the schema accepts it (the actual videoJobId / videoObjectPath need
# to come from a real pipeline run — see E1 in the UAT).
curl -s -X POST http://localhost:<api-port>/api/memes \
  -H "Cookie: <session>" -H "Content-Type: application/json" \
  -d '{
    "factId": 1,
    "imageSource": {
      "type": "video",
      "videoJobId": 1,
      "videoObjectPath": "/objects/videos/test.mp4",
      "stillObjectPath": "/objects/stills/test.jpg",
      "lookStyleId": "cinematic",
      "motionPresetId": "natural"
    },
    "textOptions": {}
  }' | jq '.'
```

Pass criterion: response either succeeds with a permalink OR returns
a clear error citing the missing video_jobs row (i.e. validation
passes, business logic fails as expected). Either way confirms the
schema accepts the new variant.

---

## E — End-to-end happy paths (manual, fal credits)

These touch the real fal.ai endpoints. Each video meme run costs
roughly **$0.45 of fal credits** (Veo 3.1 Lite at ~$0.40 + PuLID at
~$0.03 + auto-subtitle at ~$0.02). Only run these when you're ready
to spend it.

### E1. Default video path — stylize-then-video

In a browser as a Legendary user:

1. Open the wizard, pick `video` in Step 1.
2. Step 2 mounts. Upload a selfie via the source picker.
3. Tap `Make my meme`. The God Mode takeover mounts. Stage 1 copy:
   *Forging your likeness. Standard mortals take days. This takes
   seconds.* Bar climbs 0→25% over ~18s.
4. The checkpoint screen mounts. Verify the stylized still is
   displayed and the cost preview line shows a non-zero value.
5. Tap `Animate it`. Bar climbs 25→100% over ~45s.
6. Page navigates to `/m/<slug>` and the video plays with captions:
   white text, orange highlight on current word, 3px black stroke,
   captions at the bottom.
7. Database checks:
   ```bash
   PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
     "SELECT id, artifact_type, video_object_path, look_style_id, \
             motion_preset_id, video_job_id \
      FROM memes WHERE permalink_slug='<slug>';"
   ```
   Pass criterion: `artifact_type = 'video'`, `video_object_path`
   populated, `look_style_id` matches what you picked,
   `video_job_id` references a row in `video_jobs`.

### E2. Cost ledger records three rows

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT endpoint_id, job_type, computed_cost_usd, job_reference_id \
   FROM user_generation_costs \
   WHERE job_reference_id LIKE 'videoJob_<jobId>_%' \
   ORDER BY created_at;"
```

Pass criterion: exactly **3 rows** for the one video meme:

- `endpoint_id = fal-ai/flux-pulid`, `job_type = image`
- `endpoint_id = fal-ai/veo3.1/lite/image-to-video`, `job_type = video`
- `endpoint_id = fal-ai/workflow-utilities/auto-subtitle`, `job_type = video`

If sourceMode bypassed Stage 1, expect 2 rows (no PuLID).

### E3. No-face checkpoint (cheaper — only burns one PuLID call)

1. Upload a photo with no face (landscape, object, etc.).
2. Tap `Make my meme`.
3. After Stage 1 completes, the God Mode takeover should mount the
   no-face screen — NOT silently fall through to text-to-image.
4. Tap `Try a different photo` → toast `"Stylized image saved to your
   library"`; you're returned to Step 2 with the source picker reset.
5. Repeat the upload. This time tap `Use an abstract image based on
   the fact`. The pipeline proceeds to Stage 2.

### E4. Image-mode no-face explicit choice

The same explicit-choice behavior now applies to the **image** flow
(deliberate change in MBFO-4 — the prior silent fallback is gone).

1. Open the wizard, pick `image` in Step 1.
2. Source = `AI you`, upload a faceless photo, tap `Create`.
3. PuLID runs, returns no-face, the `NoFaceFallbackModal` mounts.
4. Two CTAs: `Try a different photo` (cancels job) /
   `Use an abstract image` (calls
   `/proceed-with-no-face-fallback`).

---

## F — Feature flag off-state (regression)

```bash
cd artifacts/overhype-me && pnpm dev   # NO VITE_MBFO_WIZARD
```

| #   | Check                                | Pass criterion                                                                                            |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| F1  | Production path unchanged            | `FactDetail` mounts the Phase-3 `MemeStudio`, not the wizard                                              |
| F2  | `/api/memes/video-jobs/*` reachable  | Independent of the flag — responds 401 unauthenticated                                                    |
| F3  | `/api/memes` save path unaffected    | The new video variant is additive on `SaveMemeBody`; image variants still validate exactly as before     |
| F4  | Legacy `/api/videos/generate`        | Still synchronous, still works as the admin/MemeStudio path uses it                                      |
| F5  | Legacy `/api/video-styles` admin     | Reads from the renamed `motion_presets` table; admin tooling sees the same rows it did before            |

The detailed in-browser regression walk-through is the flag-OFF half
of [`MBFO_4_UAT.md`](./MBFO_4_UAT.md), section A.

---

## G — Adjacent feature regression smoke

| #   | Area                              | Check                                                                                              |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------- |
| G1  | Share modal                       | `pnpm exec vitest run src/components/share` — all pass                                             |
| G2  | Existing meme builder (Phase 3)   | `pnpm exec vitest run src/components/meme-builder/__tests__` — all pass                            |
| G3  | Wizard shell from MBFO-1          | `pnpm exec vitest run src/components/meme-builder/wizard/__tests__` — all pass                     |
| G4  | Step 1 from MBFO-2                | `pnpm exec vitest run src/components/meme-builder/wizard/steps/Step1ArtifactType` — all pass       |
| G5  | Step 2 image flow from MBFO-3     | `pnpm exec vitest run src/components/meme-builder/wizard/step2-image` — all pass                   |
| G6  | Engine interpreter regression     | Existing admin `/api/videos/generate` route still produces valid fal input for Veo Lite (no admin override needed) |
| G7  | PuLID job no-face is now explicit | `pulidJobs.test.ts` updated to expect the new `no_face_review` phase; old test for silent fallback removed |

---

## H — Performance + observability spot-checks

### H1. Video job in-memory map garbage collection

The in-memory `jobs` Map in `videoPipelineRunner.ts` runs `gc()` on
every poll and mutation. Stale jobs (older than 60 min — longer than
the PuLID 10 min because checkpoint state can park a long time) get
cleaned up automatically. To verify without waiting, run the targeted
test file in C3 — the in-process map is cleared between test contexts
via the `__setPipelineTestHooks` export.

### H2. Stage EMAs

After E1 completes, EMA rows should exist on `admin_config`:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT key, value, updated_at FROM admin_config \
   WHERE key LIKE 'video_expected_run_ms_ema%' \
      OR key = 'pulid_expected_run_ms_ema' \
      OR key = 'subtitle_expected_run_ms_ema';"
```

Pass criterion: rows for each stage that ran, all within sensible
ranges (`stage1` ≈ 18s, `stage2` ≈ 45s, `stage3` ≈ 8s), `updated_at`
recent.

### H3. Pre-flight budget gate

In a fresh test user with a known budget cap, trigger the kickoff:

```bash
curl -i -X POST http://localhost:<api-port>/api/memes/video-jobs \
  -H "Cookie: <session>" -H "Content-Type: application/json" \
  -d '{
    "factId": <id>,
    "sourceMode": "stylize-then-video",
    "sourceImagePath": "/objects/uploads/your-photo.jpg",
    "lookStyleId": "cinematic",
    "lengthSeconds": 8,
    "resolution": "720p",
    "aspectRatio": "portrait"
  }'
```

Pass criterion: response includes `currentSpend`, `limit`,
`remainingBudget`, and `resetDate` when over budget. No job is
created in `video_jobs` when over budget.

---

## What MBFO-4 explicitly does NOT ship

These are deliberately out of scope and will appear in subsequent
sessions (MBFO-5 / future). If you hit them while testing, that's
expected — not a failure:

- **Stripe Embedded Checkout** inside the upgrade modal. Still a
  redirect to `/pricing`.
- **`MemeStudio` (Phase-3 builder) removal.** Stays in place behind
  `VITE_MBFO_WIZARD=0` until MBFO-5 cutover.
- **Engine selector visible to non-admins.** The
  `engine_experiments` feature flag exists in the DB but there's no
  per-user `user_feature_flags` table yet, so the route grants the
  flag to admins only. Per-user grants come later.
- **`generateAiMemeBackgroundStandalone` in the video no-face
  fallback.** The pipeline currently animates the user's source
  photo as-is when they pick "use an abstract image." Switching to
  text-to-image is a 3-line follow-up in
  `lib/videoPipelineRunner.ts`.
- **Frame-level NSFW classification on the final video.** Only the
  stylized still is classified pre-Stage 2 (defense in depth +
  cost-safety). Per-frame video classification would require new
  infrastructure and is unjustified for v1.
- **Style content tuning.** The 19 look styles have prompt suffixes
  mirrored from the legacy `imageStyles.ts`. Motion presets keep the
  prompts they had as `video_styles`. Future content pass.
- **`split_token_index` backfill pipeline.** Still pending from
  MBFO-1; not in MBFO-4 scope.

---

## Known divergences from the shared MBFO context

Re-stating what was flagged at PR-merge time so future sessions don't
re-litigate:

- **Look and motion styles split into two DB tables** (`look_styles`
  + `motion_presets`), not one. Modern video models bake visual
  aesthetic into the starting image and consume motion/camera as a
  separate prompt — the two concepts are genuinely orthogonal. See
  the planning thread for rationale.
- **`memes` table extended in place** with `artifact_type`,
  `video_object_path`, `video_job_id`, `look_style_id`,
  `motion_preset_id`. No separate `video_memes` table.
- **Engine identity never on the `memes` row.** The engine that
  produced a video is joined via `video_jobs.video_engine_id` so
  swapping defaults is pure config.
- **`engines` table with JSONB `paramSchema`.** Data-driven
  interpreter at `lib/engineInterpreter.ts` walks per-row param
  mappings. Adding a new engine that fits an existing param shape is
  a one-row INSERT.
- **12 unused engine adapters deleted** (luma, pixverse, wan, ltx,
  cogvideox, stablevideo, hunyuan, runway, hailuo, minimax, sora,
  pika). Their code paths are gone; the database has no row for them
  (the seeded engines are Veo Lite/Fast, Kling v3, Seedance Fast,
  Grok, plus PuLID + auto-subtitle).
- **Image-mode no-face is now an explicit user choice** (not a
  silent fallback). The platform expects every photo upload to
  contain a face; hiding that signal was confusing pre-MBFO-4.
- **Async video job route** lives at `/api/memes/video-jobs`
  (sibling to `/api/memes/pulid-jobs`). Legacy synchronous
  `/api/videos/generate` is preserved for admin tooling.
- **Branch this work shipped on** was `claude/start-mbfo-4-z87MQ`
  (per harness mandate), not `mbfo` or `mbfo/mbfo-4`.
