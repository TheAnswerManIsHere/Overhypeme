# Phase 2 — render-time image prompt generation pipeline (Test Run)

Engineering-side checklist for the Phase 2 work shipped on
`claude/visual-taxonomy-prompt-arch-cb8up`. Covers:

1. **Shared schema + business validator** — `lib/api-zod/src/imagePromptGeneration.ts`.
2. **DB migrations** — `0065_image_prompt_attempts.sql` + `0066_upload_image_metadata_source_analysis.sql`.
3. **Detector engine + classifier bench** — `fal-yolo-world` catalogued; `engineBenchType` recognizes `"image-classifier"`.
4. **Source-image analyzer** — Tier-1 (fal) → Tier-2 (heuristics) → Tier-3 (OpenAI Vision fallback) with cache.
5. **Prompt-generation service + 3 compilers** — Nano Banana 2 (human i2i / non-human i2i / t2i fallback).
6. **Two chained async-job queues** — `image_prompt_generation` → `image_generation`.
7. **User-facing routes** — `/memes/ai/:factId/analyze-source`, `/generate-v2`, `/renders/:renderJobId`.
8. **Admin routes** — `/admin/image-prompt/preview`, `/admin/image-prompt/attempts`, `/admin/source-image/analyze`.
9. **Wizard modal** — `SourceImageConfirmModal` with AiBgPicker wire-up behind `enable_image_prompt_v2`.

The User Acceptance Test for David is in [`PHASE_2_UAT.md`](./PHASE_2_UAT.md).

---

## TL;DR

```bash
# 0. Test DB is up (session-start hook).
export DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test"

# 1. Apply the new migrations (0065 + 0066).
pnpm --filter @workspace/db run migrate

# 2. Snapshot chain check.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck (libs + api-server + frontend).
pnpm -w typecheck

# 4. Validator unit tests.
cd artifacts/api-server
DATABASE_URL=$DATABASE_URL TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/imagePromptGeneration.validate.test.ts \
    src/__tests__/visualPromptStrategies.test.ts \
    src/__tests__/factEnrichment.test.ts \
    src/__tests__/asyncJobs.test.ts
```

Expected: typecheck clean, snapshot check `✓ All 67 journal entries`, 53/53
tests pass across the four files.

---

## 1. Schema + validator (`lib/api-zod/src/imagePromptGeneration.ts`)

Verify:

- `SOURCE_SUBJECT_KIND_VALUES` includes the new `human_subject_no_usable_face`.
- `CLASSIFICATION_METHOD_VALUES` distinguishes `fal_detector` (used today) from
  the reserved `local_detector` (future in-process model).
- `nonhumanSubjectTreatment` carries an `applicable: boolean` flag — no
  sentinel abuse on the `subjectKind` enum.
- `supportingTextElements` is `Array<{ content, purpose, placement }>`.
- `MANDATORY_FORBIDDEN_TEXT_TYPES` lists all 7 entries enforced as a
  case-insensitive subset.

Validator tests (in `imagePromptGeneration.validate.test.ts`):
- 19 cases covering per-mode regex (human face / no-likeness / non-human
  visual identity + "do not replace with human"), forbidden-text floor,
  structured supporting-text shape, non-human treatment coherence (applicable
  + subjectKind + preserveTraits + doNotTransformIntoHuman invariants),
  compatibility coherence (rating="poor" cannot be "none" fallback), fact-text
  substring guard, correctableHint population.

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/imagePromptGeneration.validate.test.ts
# Expected: # tests 19 # pass 19
```

## 2. Migrations

Apply locally and inspect:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c '\d image_prompt_attempts'
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
  -c '\d upload_image_metadata' | grep source_image_analysis
```

Expected:
- `image_prompt_attempts` has 22 columns including `render_job_id`, `subject_render_mode`,
  `source_image_analysis JSONB`, `visual_plan JSONB`, `compiled_prompt JSONB`,
  `subject_fact_compatibility JSONB`, `generated_image_object_path TEXT`.
- `upload_image_metadata` has new `source_image_analysis JSONB` +
  `source_image_analysis_version VARCHAR(16)` columns.

## 3. Engine catalogue

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test \
  -c "SELECT id, kind, endpoint_id FROM engines WHERE id IN ('fal-yolo-world','nano-banana-2','nano-banana-2-edit');"
```

Expected: 3 rows. `fal-yolo-world` is `kind=utility`, endpoint
`fal-ai/yolo-world`. `engineBenchType()` returns `"image-classifier"` for it.

## 4. Admin endpoints (manual smoke)

With `OPENAI_API_KEY` + fal credentials + `enable_image_prompt_v2=true` in
admin_config, against a real fact:

```bash
# Analyzer on an uploaded object (admin debug bypasses ownership gate).
curl -X POST -u "$ADMIN_AUTH" -H "Content-Type: application/json" \
  -d '{"uploadedObjectPath":"/objects/some-upload.jpg"}' \
  http://localhost:5000/api/admin/source-image/analyze
# Expected: { analysis: { subjectKind, confidence, suggestedRenderMode, classificationMethod: "fal_detector", ... } }

# Workbench preview (sync, no queue).
curl -X POST -u "$ADMIN_AUTH" -H "Content-Type: application/json" \
  -d '{"factId":1,"subjectRenderMode":"human_identity_i2i","sourceImageAnalysis":{"subjectKind":"human_face","confidence":"high","hasUsableHumanFace":true,"hasUsableSubject":true,"subjectCount":1,"suggestedRenderMode":"human_identity_i2i","warnings":[],"classificationMethod":"fal_detector","analyzerVersion":"v1"}}' \
  http://localhost:5000/api/admin/image-prompt/preview
# Expected: { visualPlan, compiledPrompt: { prompt: "...preserve... face...", imagePrompt }, subjectFactCompatibility, attemptId? }

# List recent attempts.
curl -u "$ADMIN_AUTH" \
  "http://localhost:5000/api/admin/image-prompt/attempts?factId=1&limit=5"
```

## 5. User flow (after `enable_image_prompt_v2 = true`)

```bash
# Analyze.
curl -X POST -b "$USER_COOKIE" -H "Content-Type: application/json" \
  -d '{"uploadedObjectPath":"/objects/my-upload.jpg"}' \
  http://localhost:5000/api/memes/ai/1/analyze-source

# Generate-v2 (returns 202 immediately).
curl -X POST -b "$USER_COOKIE" -H "Content-Type: application/json" \
  -d '{"sourceImageAnalysis":{...},"userSelectedSubjectRenderMode":"human_identity_i2i","renderControls":{"aspectRatio":"portrait","contentMode":"sfw"},"uploadedObjectPath":"/objects/my-upload.jpg"}' \
  http://localhost:5000/api/memes/ai/1/generate-v2

# Poll.
curl -b "$USER_COOKIE" http://localhost:5000/api/memes/ai/renders/$RENDER_JOB_ID
# Expected: status advances pending → prompt_ready → image_ready over ~30s.
```

## What's NOT in this PR

- No proactive face-detection at upload time outside the analyze-source flow.
- No batch backfill for the cache columns — populated lazily on first use.
- No retention sweep for `image_prompt_attempts` — low volume during initial
  rollout; follow-up may add one.
- No replacement of the legacy `/memes/ai/:factId/generate` route or the
  `aiMemePipeline.ts` callsites. Cutover is a follow-up PR after one week of
  clean prod UAT, per the removal criteria in the plan.
- Workbench classifier UI: the `image-classifier` bench type is recognized
  server-side but the existing admin/engines workbench frontend doesn't
  render a detector-specific input form yet — runs through
  `/admin/source-image/analyze` instead. UI follow-up is small.
- No automated tests for the source-image analyzer or the prompt-generation
  service yet — only the validator. Generator + analyzer tests are a
  near-term follow-up; both modules accept injected callModel/detector
  callbacks (visualPreview pattern) so testing them in isolation is cheap.
