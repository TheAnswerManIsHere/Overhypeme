# Engine Management — Automated test run

This is the engineering-side checklist for the engine management system
landed in PR #51 + the admin-panel cleanup follow-up. It exercises the
typed engine catalogue, the boot reconciliation, the `/admin/engines`
write endpoints, the synthetic-fal "Test" harness (now an async
submit + poll pair), and the legacy admin_config retirement. Hand it to
Replit (or run locally) to confirm everything came across correctly.

**What's changed since the last revision of this doc:**

- New engine **Nano Banana Pro** (`nano-banana-pro`, Google Gemini 3
  Pro Image, kind=`image`). It is now the catalogue's default image
  engine in place of PuLID. **Caveat**: the production video pipeline
  Stage 1 still hardcodes PuLID; the catalogue default only affects
  the workbench until Stage 1 is refactored. Engine count: **8**, not
  7.
- The fal audit (PRs #57/#58) added new params on every existing
  engine (`auto_fix`, `safety_tolerance`, `enhance_prompt`,
  `negative_prompt`, `seed` on the Veo engines; `end_image_url`,
  `seed`, `generate_audio` on Kling; `seed`, `end_image_url` on
  Seedance; `video_preset` enum + `seed` on Grok; expanded PuLID knobs
  `id_weight`, `true_cfg`, `enable_safety_checker`, `num_images`).
- **The interpreter regression guard for Veo + `generate_audio` was
  FLIPPED**: the May 2026 fal docs list `generate_audio` as accepted
  on both Veo 3.1 endpoints. `engineInterpreter.test.ts` now asserts
  the param IS emitted; if a workbench run starts 422-ing on
  `no_media_generated` again, flip the guard back.
- `POST /api/admin/engines/:id/test` is **asynchronous**. It now
  returns `202` with `{ status: "submitted", requestId, falInput,
  testFixtures }` immediately. A new `GET
  /api/admin/engines/:id/test/poll/:requestId` endpoint exposes the
  fal queue status; the workbench polls it every 3 s. This replaces
  the previous `fal.subscribe` blocking call, which timed out behind
  the production reverse proxy on long video jobs.
- Workbench UI surfaces every param: humanized labels (`autoFix` →
  "Auto fix"), `{type}` + `default: {value}` chips per input, a
  `{N} params` badge on each engine card, and a `stringArray` field
  type for Nano Banana Pro's `image_urls`.

The User Acceptance Test is in [`ENGINE_MANAGEMENT_UAT.md`](./ENGINE_MANAGEMENT_UAT.md)
— that one is for the product owner to walk through in a browser.

Prior session equivalents (MBFO scope):
- [`MBFO_4_TEST_RUN.md`](./MBFO_4_TEST_RUN.md) / [`MBFO_4_UAT.md`](./MBFO_4_UAT.md)

---

## TL;DR

```bash
# 1. Apply the new migrations (0059 deletedAt, 0060 retire legacy keys,
#    0061 retire style_suffix_* keys).
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck — covers cycles + no-console linting too.
pnpm run typecheck

# 4. Server tests for the engine management surface
# (engineInterpreter 38 + engineAudio 10 + engineReconcile 7 +
#  adminEngines 31 + legacyKeyRetirement 5 + videoJobs +
#  routes.memes ≈ 135 tests).
cd artifacts/api-server && \
  DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
  TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/engineInterpreter.test.ts \
    src/__tests__/engineAudio.test.ts \
    src/__tests__/engineReconcile.test.ts \
    src/__tests__/adminEngines.test.ts \
    src/__tests__/legacyKeyRetirement.test.ts \
    src/__tests__/videoJobs.test.ts \
    src/__tests__/routes.memes.test.ts

# 5. Frontend tests (492 — admin/engines page + the rest of the wizard).
cd ../overhype-me && pnpm exec vitest run

# 6. Production build still emits cleanly.
pnpm exec vite build

# 7. Boot smoke: confirm reconciliation logs at startup.
PORT=5180 BASE_PATH=/ pnpm --filter @workspace/api-server exec tsx src/index.ts
#  Look for: [engines/reconcile] boot reconciliation complete {...}
```

If everything above is green, you can stop. Sections below break each
step out in case anything fails.

---

## A — Setup gate

### A1. Test DB is up

The session-start hook brings up Postgres on `:5432`. Confirm with:

> `Test DB ready at postgres://overhype:overhype@localhost:5432/overhype_test`

### A2. New migrations apply cleanly

Three new migrations beyond the MBFO-4 baseline:

- `0059_superb_lady_bullseye.sql` — DDL: adds `deleted_at timestamptz` to
  the `engines` table + partial index `IDX_engines_live` (covers the
  soft-delete + archived-engines tab in the admin UI).
- `0060_retire_legacy_model_config_keys.sql` — Pure DML. Deletes ~26
  `ai_std_*`, `ai_ref_pulid_*`, `ai_image_model_*`, `ai_scene_prompt_*`,
  `video_*` rows from admin_config.
- `0061_retire_style_suffix_admin_config_keys.sql` — Pure DML. Deletes
  ~38 `style_suffix_*` rows. Visual-style prompt content now lives on
  the `look_styles` table.

```bash
pnpm --filter @workspace/db run migrate
```

Pass criterion: `Done: 3 applied, ... already up-to-date` (or whatever
the delta is) — no SQL errors.

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db check-snapshots
```

Pass criterion:

> `✓ All 62 journal entries have snapshot files (or are explicitly exempt).`
> `✓ Snapshot chain is valid (48 snapshots, all prevId links correct).`

### A4. Engine rows present after boot

The first time the API server boots, `reconcileEngines()` runs and
upserts the 8 code-defined engines into the table.

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, kind, is_default, is_active, deleted_at \
   FROM engines ORDER BY sort_order;"
```

Pass criteria:
- 8 rows present: `veo-3.1-lite` (kind=video, is_default=t, is_active=t),
  `veo-3.1-fast`, `kling-v3-standard`, `seedance-2.0-fast`,
  `grok-imagine`, `nano-banana-pro` (kind=image, is_default=t),
  `pulid-flux` (kind=image, is_default=f — superseded by Nano Banana
  Pro at the catalogue level),
  `fal-auto-subtitle` (kind=utility, is_default=t).
- All have `deleted_at = NULL`.

### A5. Legacy keys gone

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT count(*) FROM admin_config \
   WHERE key LIKE 'ai_std_%' OR key LIKE 'ai_ref_pulid_%' \
      OR key LIKE 'ai_image_model_%' OR key LIKE 'ai_scene_prompt_%' \
      OR key LIKE 'video_%' OR key LIKE 'style_suffix_%';"
```

Pass criterion: count = **0**.

---

## B — Server tests

Run from `artifacts/api-server`:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test \
  src/__tests__/engineInterpreter.test.ts \
  src/__tests__/engineAudio.test.ts \
  src/__tests__/engineReconcile.test.ts \
  src/__tests__/adminEngines.test.ts \
  src/__tests__/legacyKeyRetirement.test.ts \
  src/__tests__/videoJobs.test.ts \
  src/__tests__/routes.memes.test.ts
```

Pass criterion: **all suites pass, 0 fail** (~135 tests across the
7 files; counts per file in B1–B5 below).

### B1. engineInterpreter (38 tests)

Validates the param-mapping interpreter:
- 5 primitives (`string`, `int`, `stringInt`, `boolean`, `float`),
  plus the new `stringArray` primitive (wraps a single string into
  `[string]`, passes arrays through unchanged — used by Nano Banana
  Pro's `image_urls`).
- `map` substitution (wizard "landscape" → fal "16:9")
- `enum` validation (rejects values not in the declared set)
- `range` (clamp or throw policy)
- `includeWhen` predicates (equals, oneOf, present, greaterThan,
  lessThan, `any` for OR)
- Required params + defaults
- **Regression guard FLIPPED**: Veo 3.1 Lite paramSchema **DOES** emit
  `generate_audio` per the May 2026 fal docs. (Previously this guard
  required the param to be absent, after the migration-0058 422 bug;
  fal subsequently published `generate_audio` as a supported toggle
  controlling the $0.05/s vs $0.03/s pricing tier.) If a workbench
  run starts returning 422 `no_media_generated` again, flip the guard
  back — that's the cleanest rollback signal.

### B2. engineAudio (10 tests)

Per-engine `audioHandling` routing:
- `native_lipsync` — Veo
- `prompt_cue` — Grok
- `voice_control` — Kling
- `native_audio_boolean` — Seedance
- `none` — utility engines

### B3. engineReconcile (7 tests)

- Inserts every code-defined engine on a fresh DB.
- Preserves admin-edited `isActive` / `defaultResolution` across boots.
- Overwrites `paramSchema` (code-owned) even when admin tunables stay.
- Preserves the `deletedAt` tombstone — re-running reconciliation does
  not resurrect a soft-deleted row.
- Refreshes the paramSchema on a soft-deleted row (so an un-archive
  lands on an up-to-date row).
- Idempotent — running twice changes nothing.

### B4. adminEngines (31 tests)

Auth + write surface:
- 401 unauthenticated.
- 403 non-admin authenticated.
- 200 admin GET — returns archived rows too.
- PATCH respects the `ADMIN_EDITABLE_FIELDS` allowlist; any disallowed
  key → 400.
- DELETE sets `deletedAt`; row still queryable.
- POST `/restore` clears `deletedAt`.
- POST `/set-default` flips `isDefault` atomically across same-kind.
- POST `/test` (async submit half):
  - Happy path with mocked `fal.queue.submit`: returns **202** with
    `{ status: "submitted", requestId, falInput, testFixtures }`.
    Captures the falInput so we can assert the param shape matches
    the engine's `paramSchema`.
  - Failure path: when `fal.queue.submit` throws, body captures
    `error.{message,body,status}` and returns `{ ok: false }`.
  - Utility engines (auto-subtitle) refuse the synthetic test
    (`test_not_supported`) because they expect a video URL, not the
    bundled face placeholder. Admin can supply `sampleImageUrl` to test
    explicitly.
  - Custom `sampleImageUrl` passes through unchanged (no upload call).
  - 404 on non-existent engine id.
- GET `/test/poll/:requestId` (new poll half):
  - `done: true, ok: true, falResult, durationMs` when the poll
    override signals COMPLETED.
  - `done: false, phase` when the poll override signals IN_QUEUE /
    IN_PROGRESS.
  - `done: true, ok: false` with error body when the poll override
    throws.
  - 404 on non-existent engine id.

Test helpers: `__setFalSubmitForTest` and `__setFalPollForTest` (in
`routes/adminEngines.ts`) replace the old `__setFalSubscribeForTest`.

### B5. legacyKeyRetirement (5 tests)

Pins the migration shape so the cleanup can't silently drift back:
- Migration 0060 file exists at the expected path.
- Its DELETE statement targets exactly the 26 retired keys.
- The journal lists it and `check-snapshots` marks it exempt.
- Against a live DB, zero admin_config rows for the retired keys.

### B6. videoJobs + routes.memes (rest)

Regression checks — the video pipeline + meme save endpoint both run
through the engine catalogue now. If anything in the cleanup broke
those paths it'll show up here.

---

## C — Admin Engines API smoke (curl)

Once the server is running, hit the endpoints directly to confirm the
wiring is correct. You'll need an admin session cookie.

### C1. List all engines

```bash
curl -s -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines | jq '.[] | { id, kind, isDefault, deletedAt }'
```

Pass criterion: returns 8 rows; each row has `paramSchema`,
`allowedDurationsSec`, etc. The default image engine is
`nano-banana-pro`; `pulid-flux` is still present but no longer
`isDefault`.

### C2. Submit a synthetic test (async — submit returns 202)

This is the most important diagnostic — it bypasses the meme builder
entirely and proves that the engine's `paramSchema` produces a valid
fal call. Default test image is bundled; for utility engines you must
supply `sampleImageUrl`.

The endpoint accepts a full tuning body — every field is optional and
falls back to the engine's defaults when omitted. Empty body = the
synthetic baseline (full motion + dialogue + engine defaults).

**The endpoint is now async**: submit returns immediately with a
`requestId`, then you poll C2b until done. The previous blocking
`fal.subscribe` call was timing out behind the production reverse
proxy on long video jobs (Veo / Kling can run 30–60 s, longer than the
default 30 s idle window).

```bash
# Baseline — engine defaults (returns 202 with requestId)
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines/veo-3.1-lite/test \
  -H "Content-Type: application/json" -d '{}'

# Full tuning surface — every field optional
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines/veo-3.1-lite/test \
  -H "Content-Type: application/json" -d '{
    "sampleImageUrl": "https://…/face.jpg",
    "motionPrompt":   "Subject turns head slowly to the left, then back.",
    "dialogueText":   "This is a synthetic engine test.",
    "durationSec":    8,
    "aspectRatio":    "16:9",
    "resolution":     "720p",
    "mode":           "normal",
    "generateAudio":  true,
    "extraParams":    { "autoFix": false, "safetyTolerance": "5", "negativePrompt": "blurry, distorted" }
  }'
```

Pass criterion: the submit response is **HTTP 202** with body
`{ status: "submitted", requestId, engineId, endpointId, falInput,
testFixtures }`. `falInput` is the exact JSON sent to fal — confirm:

- `image_url` is present and is a fal-CDN URL.
- `prompt` matches the motion prompt + the audio cue routed via
  `applyAudioHandling` (e.g. for Veo, `\nVoiceover should say, "…"`).
- `duration` matches what you sent (defaults to engine's
  `defaultDurationSec`).
- `aspect_ratio` matches the engine's fal format (the interpreter maps
  the wizard format `landscape` → `16:9` etc.).
- `resolution` matches.
- For **Veo Lite / Veo Fast**, expect `generate_audio: true` in
  `falInput` (the May 2026 fal docs accept the param; the previous
  migration-0058 regression guard was flipped — see B1).
- For **Nano Banana Pro**, expect `image_urls` to be an **array**
  (e.g. `["https://…/face.jpg"]`), not a string — the new
  `stringArray` interpreter type wraps a single referenceImageUrl into
  a one-element array; the API accepts up to 14.

If `fal.queue.submit` itself throws (e.g. malformed payload), the
endpoint returns 200 with `{ ok: false, error: { message, body,
status } }` — note that's a 200 status code even on failure, which
is a known asymmetry with the 202 happy path.

### C2b. Poll the submitted request (every 3 s until done)

```bash
curl -s -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines/veo-3.1-lite/test/poll/<requestId> | jq
```

Pass criteria:

- While the job is queued or running:
  `{ done: false, phase: "IN_QUEUE" | "IN_PROGRESS", queuePosition? }`.
- On success:
  `{ done: true, ok: true, falResult, durationMs, requestId }` where
  `falResult.data.video.url` is a real generated video URL.
- On fal error:
  `{ done: true, ok: false, error: { message, body, status } }`.

**Known caveat**: `durationMs` measures the time spent fetching the
result blob from fal storage, not the actual job runtime. The
`submit` timestamp isn't persisted server-side. If you need real
runtime, compute it client-side from the submit→done round-trip.

The workbench currently polls only the `COMPLETED` terminal state. If
fal returns `FAILED` or `CANCELED` the loop never terminates; a fix
is tracked separately. For curl, terminate manually after a few
minutes if `done` never goes true.

#### C2a. Audio-experiment shapes (A / B / C)

The test workbench supports three named experiment shapes for
validating each engine's audio behavior. The UI's experiment radio
auto-fills the `dialogueText` field; the same shapes can be exercised
directly via curl by varying `dialogueText`:

- **A · Baseline** — full dialogue matched to clip duration:
  ```json
  { "dialogueText": "This is a synthetic engine test. The quick brown fox jumps over the lazy dog." }
  ```
  Pass criterion: audio plays the cue cleanly start to finish; subject
  does not mouth the words (we want voiceover, not lipsync).

- **B · Padding test** — short dialogue, ~half the clip duration:
  ```json
  { "dialogueText": "This is a synthetic engine test." }
  ```
  Pass criterion: audio plays the short phrase; remaining clip time is
  silent (or ambient). **Fail signal**: engine invents extra
  lipsync-synced dialogue to fill the silence (the documented Grok
  Imagine quirk).

- **C · Silence** — no dialogue at all:
  ```json
  { "dialogueText": null }
  ```
  Pass criterion: video has no spoken content. **Fail signal**: engine
  produces uninvited speech.

Run all three against each engine when validating its audio
contract. Outcomes feed back into the engine's `audioHandling`
classification (see `lib/engines/<id>.ts`).

### C3. PATCH an engine

```bash
curl -s -X PATCH -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" \
  -d '{ "expectedRunMs": 25000 }' \
  http://localhost:<api-port>/api/admin/engines/veo-3.1-lite | jq
```

Pass criterion: 200, returned row has `expectedRunMs: 25000`. PATCH
with an unallowed key (e.g. `paramSchema`) should 400 with
`error: "field_not_editable"` and the offending key listed.

### C4. Soft-delete + restore

```bash
# Archive Grok.
curl -s -X DELETE -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines/grok-imagine | jq

# Confirm it's no longer in the wizard catalogue (deletedAt != null).
curl -s -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines | jq '.[] | select(.id=="grok-imagine") | { id, deletedAt }'

# Restore it.
curl -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines/grok-imagine/restore | jq
```

### C5. Set default

```bash
curl -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/engines/veo-3.1-fast/set-default | jq
```

Pass criterion: `veo-3.1-fast` becomes the default for kind=video, and
the previous default (`veo-3.1-lite`) is no longer default.

### C6. Public catalogue endpoint reflects admin edits

```bash
# Should NOT include archived engines, regardless of feature flag.
curl -s "http://localhost:<api-port>/api/engines?kind=video" | jq
```

Pass criterion: archived engines absent. Engines list reflects the
current is_default + isActive state.

---

## D — Wizard end-to-end (a single engine getting all the way through)

The goal here is to get **one engine** (Veo 3.1 Lite) producing a real
meme through the wizard before debugging the others. Once Veo Lite
works, swap defaults and repeat.

### D1. Pre-flight checklist for Veo Lite

- `is_active = true`, `is_default = true`, `tier_requirement =
  'legendary'` in the `engines` table.
- `/api/admin/engines/veo-3.1-lite/test` returns `ok: true` (Section C2
  above). If THAT fails, the engine's `paramSchema` is wrong — fix it
  in `artifacts/api-server/src/lib/engines/veo-3.1-lite.ts` and
  restart. The boot reconciliation refreshes the DB row.

### D2. Generate one video meme end-to-end

1. Browser, logged in as a Legendary user.
2. Open the wizard, pick `video` in Step 1.
3. Upload a selfie.
4. Tap "Make my meme."
5. God Mode takeover mounts. Watch for:
   - Stage 1 copy: "Forging your likeness…"
   - Progress bar climbs 0→25% over ~18s.
   - Checkpoint screen with the stylized still.
6. Tap "Animate it."
7. Bar climbs 25→100% over ~45s.
8. Detail page mounts, video plays with captions.

### D3. Engine-id audit on the resulting meme

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, artifact_type, video_engine_id, image_engine_id, subtitle_engine_id \
   FROM video_jobs ORDER BY id DESC LIMIT 1;"
```

Pass criterion: `video_engine_id = 'veo-3.1-lite'`,
`image_engine_id = 'pulid-flux'` **(still PuLID even though Nano
Banana Pro is the catalogue default — Stage 1 in `videoPipelineRunner`
hardcodes `aiMemePipeline.generateAiMemeBackgroundFromReference`,
which calls PuLID directly. Until Stage 1 is refactored to route
through `loadDefaultEngine("image")`, the production pipeline ignores
the catalogue default for image kind.)**,
`subtitle_engine_id = 'fal-auto-subtitle'`. The video_jobs row
preserves the engine that actually ran (not just the default at
meme-detail-load time).

### D4. Cost ledger has 3 rows (1 per stage)

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT endpoint_id, job_type, computed_cost_usd \
   FROM user_generation_costs \
   WHERE job_reference_id LIKE 'videoJob_<jobId>_%' \
   ORDER BY created_at;"
```

Pass criterion: three rows, one each for PuLID, Veo Lite endpoint,
auto-subtitle endpoint. Sum approximates $0.45.

---

## E — Switch engines one at a time (the troubleshooting harness)

Once Veo Lite is working end-to-end, repeat the cycle for each
remaining engine.

For each candidate engine `<id>` in
`{veo-3.1-fast, kling-v3-standard, seedance-2.0-fast, grok-imagine}`:

1. Run `/api/admin/engines/<id>/test` (Section C2 above).
2. If `ok: true`, set it default with `/set-default` and repeat the
   wizard run (Section D2) to confirm the wizard path is clean for
   that engine too.
3. If `ok: false`:
   - Read `falInput` — it shows exactly what we sent to fal.
   - Read `error.body` — fal's response usually says which param is
     wrong.
   - Edit the engine's TypeScript definition in
     `artifacts/api-server/src/lib/engines/<id>.ts`.
   - Restart server — reconciliation refreshes the DB row.
   - Re-run the test.
4. When done, set Veo Lite back as the default with `/set-default` so
   the test users don't get an unintended engine.

---

## F — Feature flag off-state (regression)

Removing the engines table or breaking reconciliation should not crash
the existing routes:

| #  | Check                                  | Pass criterion                                                       |
|----|----------------------------------------|----------------------------------------------------------------------|
| F1 | Production path unchanged              | `FactDetail` mounts the Phase-3 `MemeStudio`, not the wizard         |
| F2 | `GET /api/engines?kind=video`          | Returns the active default engine even if reconciliation hasn't run  |
| F3 | `/api/memes` save endpoint             | Video variant validates and persists with engine ids                 |
| F4 | Legacy `/api/videos/generate`          | Uses the engines table (no admin_config reads); still works          |
| F5 | Static `FAL_VIDEO_MODELS*` lists are gone | `grep -r 'FAL_VIDEO_MODELS' artifacts/overhype-me/src/` returns nothing (the legacy MemeStudio admin override block was deleted in the cleanup) |
| F6 | `style_suffix_*` keys are gone         | `SELECT count(*) FROM admin_config WHERE key LIKE 'style_suffix_%'` = 0 |

---

## G — Adjacent feature regression smoke

| #  | Area                              | Check                                                                                       |
|----|-----------------------------------|---------------------------------------------------------------------------------------------|
| G1 | Engine interpreter regression     | `vitest run src/components/meme-builder/wizard` — passes                                    |
| G2 | Image meme builder                | `routes.memes.test.ts` — passes                                                              |
| G3 | Wizard video flow                 | `videoJobs.test.ts` — passes                                                                 |
| G4 | Reconciler is idempotent          | `engineReconcile.test.ts` covers; boot the server twice and confirm no errors                |
| G5 | Pricing cache auto-includes       | After boot, every engine's `endpointId` appears in `fal_pricing_cache` (live fal key needed) |
| G6 | Admin panel free of legacy fields | `/admin/config` and `/admin/ai` show only the callouts + non-engine sections (Section H)     |

---

## H — Admin panel surface audit

After the cleanup, the admin pages should look like:

### `/admin/ai`
- Debug Mode toggle (kept — not engine-config)
- Callout: "AI engine configuration has moved → /admin/engines"
- Callout: "Image style suffixes moved to look_styles"
- AI Generation Limits (just `ai_gallery_display_limit` +
  `ai_max_images_per_fact_per_gender`)
- **No** Image Style Suffixes section
- **No** AI Image Generation section
- **No** AI Scene Prompt section
- **No** Video Generation section

### `/admin/config`
- Debug Mode toggle
- AI Settings group (just the two callouts + AI Generation Limits)
- Budget section
- Limits section
- Email section
- Zazzle section
- Catch-all generic config rows (everything not in a named section)
- **No** model parameter table (MODEL_PARAMS / ModelConfigSection)
- **No** FAL_VIDEO_MODELS dropdown
- **No** Image Style Suffixes section

### `/admin/engines`
- Live tab: 8 engines visible (Veo Lite, Veo Fast, Kling v3,
  Seedance 2.0 Fast, Grok, Nano Banana Pro [image, ★ default], PuLID
  [image], auto-subtitle [utility]).
- Each engine card row shows a `{N} params` badge next to the id chip
  so the param-schema breadth is visible at a glance (Nano Banana
  Pro: 7, Veo engines: 9, Kling: 8, Seedance: 7, Grok: 6, PuLID: 10,
  auto-subtitle: 13).
- Archived tab: empty unless you've archived something.
- Each engine row has a "Test" button that opens the workbench, which
  submits the synthetic fal call asynchronously (202 → poll). The
  button cycles "Submitting…" → "In queue…" → "Running…" while
  polling fal every 3 s, then shows the final result.

---

## What's deliberately NOT shipped

These are deferred — flag them as expected gaps, not failures:

- **`/admin/look-styles` editor** — visual-style prompt content lives
  on the `look_styles` DB table now, but there's no admin UI to edit
  it yet. Edits happen via the typed `lib/engines/` files or a SQL
  migration.
- **Per-user `engine_experiments` feature flag** — the flag exists in
  the DB but there's no per-user grants table. Admins see all
  engines; non-admin Legendary users see only the default.
- **Per-engine wizard UI hooks** (Kling voice control textarea,
  Seedance multi-shot toggle) — infrastructure is in place via the
  typed engine files; the actual UI components are a follow-up once
  we have real UX needs.
- **Non-PuLID FLUX image generators in the engines table** — the
  standard FLUX models (Pro / Schnell / Dev / Ultra) still use
  baked-in defaults in `aiMemePipeline.ts`. PuLID and Nano Banana
  Pro are the only image-kind rows in the engines table today.
- **Nano Banana Pro is catalogue-default but not pipeline-default
  for image kind.** Stage 1 of the video pipeline
  (`videoPipelineRunner.runStage1`) calls
  `generateAiMemeBackgroundFromReference` from `aiMemePipeline.ts`,
  which hardcodes PuLID. The catalogue default flip currently only
  affects the workbench and `/api/engines?kind=image` consumers. A
  follow-up needs to route Stage 1 through `loadDefaultEngine("image")`
  + `buildEngineInput` to honor the catalogue default in production.
- **Async test endpoint polish.** The workbench polls only the
  `COMPLETED` terminal state — `FAILED` / `CANCELED` from
  `fal.queue.status` leave the loop spinning. A maximum poll bound
  (~3 min for video, ~30 s for image) and explicit handling for the
  failed-terminal states is a follow-up. `durationMs` from the poll
  endpoint also currently measures only the result-fetch step, not
  the submit→done window.

---

## Known divergences from the original plan

- Reconciliation **does not** un-archive engines that have been
  soft-deleted, even if the code file still exists. Set `is_active`
  back to true via the admin panel or via `POST /restore`.
- `ADMIN_EDITABLE_FIELDS` is the single source of truth for both the
  reconciler (skips these fields on update) and the PATCH allowlist.
  Live in `lib/engines/types.ts`.
- The `style_suffix_*` admin_config keys (38 rows) are deleted
  via migration 0061; their content lives on the `look_styles` table
  (seeded by migration 0057). The legacy code path in `memes.ts` now
  reads from `look_styles` directly.
- Migration 0059 (deletedAt) clashed with a Replit-side migration
  also numbered 0059 in an agent worktree — the legacy-keys retirement
  was renumbered to 0060 during the merge, and the style_suffix
  retirement is 0061.
