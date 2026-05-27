# Fact Visual-Taxonomy Enrichment — Automated test run

This is the engineering-side checklist for the fact-enrichment layer
landed in **PR #75** (branch `claude/visual-taxonomy-prompt-arch-cb8up`).
It exercises the shared taxonomy enums + zod schema, the new DB columns
and migration, the OpenAI enrichment service (with its corrective-retry
and graceful-failure paths), the review submission/approval wiring, the
admin enrichment endpoints, the backfill tool, and the removal of the
legacy `/ai/suggest-hashtags` endpoint. Hand it to Replit (or run
locally) to confirm everything came across correctly.

The User Acceptance Test is in [`FACT_ENRICHMENT_UAT.md`](./FACT_ENRICHMENT_UAT.md)
— that one is for the product owner to walk through in a browser.

**What this phase is (and isn't):** this is *durable classification
metadata* only. When a fact is submitted, OpenAI classifies its joke
mechanism into the taxonomy; an admin reviews/edits it; the structured
result is stored on the approved fact. **No image/video prompt
generation is in this PR** — that's the next phase, which will consume
this stored taxonomy.

**Scope of changes:**

- **Shared source of truth** — `lib/api-zod/src/taxonomy.ts`: all enums
  (`PRIMARY_ARCHETYPES`, `SUBTYPES_BY_ARCHETYPE`, visual literalness /
  complexity, Overhype fit, adult suitability, `KNOWN_FACT_MODIFIERS`),
  the `factEnrichmentSchema` zod validator (subtype must belong to
  archetype; 3–8 normalized hashtags; confidence 0–1), and
  `validateEnrichment` / `normalizeHashtag` / `buildFactEnrichmentColumns`
  helpers. Imported by **both** the API server and the admin UI.
- **Hybrid storage** (migration `0062_amazing_ser_duncan.sql`): a jsonb
  `enrichment` blob **plus** promoted, indexed columns
  (`primary_archetype`, `subtype`, `overhype_fit`, `adult_suitability`)
  on `facts`; `enrichment` blob + `enrichment_status` on
  `pending_reviews`.
- **Enrichment service** — `lib/factEnrichment.ts` (+ admin-configurable
  prompt/model in `lib/factEnrichmentConfig.ts`, seeded into
  `admin_config`). OpenAI JSON mode + app-side validation + **one
  corrective retry**; runs in the background at submission and is
  **non-blocking** — failures mark the review `enrichment_status = failed`.
- **Review wiring** — `routes/reviews.ts`: submit kicks background
  enrichment; GET endpoints return `enrichment` + `enrichmentStatus`;
  approve / approve-variant accept an admin-edited `enrichment` body,
  validate it, write the blob + promoted columns onto the new fact, and
  attach the enrichment's hashtags. New `PATCH …/enrichment` (save edits)
  and `POST …/enrich` (re-run).
- **AI hashtags moved to admin** — removed `POST /ai/suggest-hashtags`
  (route, frontend call, OpenAPI path). Users keep manual custom tags.
- **Backfill** — `POST /admin/facts/backfill-enrichment` + a "Backfill
  enrichment" button on `/admin` Facts Management.

---

## TL;DR

```bash
# 0. Test DB is up (session-start hook). DATABASE_URL points at it.
export DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test"

# 1. Apply the new migration (0062 — enrichment columns + indexes).
pnpm --filter @workspace/db run migrate
#    (On a fresh dev DB the session hook uses drizzle-kit push; if the DB
#     pre-dates this change, `push` also syncs the columns.)

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck — libs + api-server (cycles + no-console) + frontend.
pnpm run typecheck

# 4. Regenerate api-zod from the spec and confirm it's clean
#    (proves suggest-hashtags is gone and taxonomy export survives codegen).
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs

# 5. Server tests for the enrichment surface.
#    NOTE: the sharded runner (`pnpm test`) is broken in this environment on
#    a `node --test-isolation=none` flag; run the files directly instead.
cd artifacts/api-server && \
  DATABASE_URL="$DATABASE_URL" TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
  node --import tsx/esm --test \
    src/__tests__/factEnrichment.test.ts \
    src/__tests__/routes.reviews.test.ts \
    src/__tests__/reviews.reject.test.ts \
    src/__tests__/routes.ai.test.ts \
    src/__tests__/routes.admin.auth.test.ts \
    src/__tests__/scenePromptConfig.test.ts

# 6. Frontend tests (494 — SubmitFact + admin moderation + the rest).
cd ../overhype-me && pnpm exec vitest run
```

Expected: migration applies cleanly, all typechecks pass, **factEnrichment
15 / routes.reviews 37 / routes.ai 10 / routes.admin.auth 119 /
scenePromptConfig 3** pass with 0 failures, frontend 494 pass.

If everything above is green you can stop. Sections below break each step
out in case something fails.

---

## A — Setup gate

### A1. Test DB is up

The session-start hook brings up Postgres on `:5432`. Confirm:

> `Test DB ready at postgres://overhype:overhype@localhost:5432/overhype_test`

### A2. Migration applies cleanly

One new migration beyond the prior baseline:

- `0062_amazing_ser_duncan.sql` — DDL only. Adds `enrichment jsonb`,
  `primary_archetype varchar(64)`, `subtype varchar(64)`,
  `overhype_fit varchar(16)`, `adult_suitability varchar(24)` to `facts`;
  `enrichment jsonb` + `enrichment_status varchar(16)` to
  `pending_reviews`; and indexes `facts_primary_archetype_idx`,
  `facts_adult_suitability_idx`.

```bash
pnpm --filter @workspace/db run migrate
```

Pass criterion: applies with no SQL errors. (`seed.ts` `ensureSchema()`
also carries idempotent `ADD COLUMN IF NOT EXISTS` for the same columns,
so a prod-restore-into-dev that pre-dates the migration self-heals on boot.)

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db run check-snapshots
```

Pass criterion: chain valid, no missing/mismatched snapshots; the new
`0062` entry has its snapshot file.

### A4. New columns present

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name='facts'
     AND column_name IN ('enrichment','primary_archetype','subtype','overhype_fit','adult_suitability')
   ORDER BY column_name;"

PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT column_name FROM information_schema.columns
   WHERE table_name='pending_reviews'
     AND column_name IN ('enrichment','enrichment_status')
   ORDER BY column_name;"

PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT indexname FROM pg_indexes
   WHERE tablename='facts'
     AND indexname IN ('facts_primary_archetype_idx','facts_adult_suitability_idx');"
```

Pass criteria: all 5 `facts` columns, both `pending_reviews` columns, and
both indexes present.

### A5. Enrichment config seeded

On boot, `seedFactEnrichmentConfig()` upserts the admin-tunable levers.

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT key FROM admin_config WHERE key LIKE 'fact_enrichment_%' ORDER BY key;"
```

Pass criterion: five keys — `fact_enrichment_system`,
`fact_enrichment_model` (default `gpt-4o-mini`),
`fact_enrichment_temperature`, `fact_enrichment_max_tokens`,
`fact_enrichment_reasoning_effort`.

### A6. Legacy hashtag endpoint gone

```bash
grep -rn "suggest-hashtags\|suggestHashtags" \
  artifacts/api-server/src lib/api-spec/openapi.yaml \
  artifacts/overhype-me/src 2>/dev/null
```

Pass criterion: **no matches** (route, OpenAPI path, and the frontend
compose-time call are all removed).

---

## B — Server tests

Run from `artifacts/api-server`:

```bash
DATABASE_URL="postgres://overhype:overhype@localhost:5432/overhype_test" \
TEST_DB_ALLOW_EXIT_ON_IDLE=1 BCRYPT_SALT_ROUNDS=4 \
node --import tsx/esm --test \
  src/__tests__/factEnrichment.test.ts \
  src/__tests__/routes.reviews.test.ts \
  src/__tests__/reviews.reject.test.ts \
  src/__tests__/routes.ai.test.ts \
  src/__tests__/routes.admin.auth.test.ts \
  src/__tests__/scenePromptConfig.test.ts
```

Pass criterion: all suites pass, 0 fail.

### B1. factEnrichment (15 tests)

- **archetype/subtype pairing** — a valid pair passes; a subtype that
  belongs to a different archetype is rejected with `subtypeMismatch:
  true`; an unknown archetype is rejected.
- **hashtags** — `["#Strength", "Push Ups!", "EARTH"]` normalizes to
  `["strength","pushups","earth"]`; <3 (after normalization) rejected;
  >8 rejected; `normalizeHashtag` strips `#` and punctuation.
- **required fields & confidence** — missing a required field rejected;
  `taxonomyConfidence` outside 0..1 rejected.
- **buildFactEnrichmentColumns** — derives the four promoted column
  values from the blob.
- **enrichFactWithModel orchestration** (model caller injected, no
  network): valid first response → no retry (1 call), stamps
  `enrichedBy: "openai"` + `taxonomyVersion: "v1"`; bad-then-good →
  retries once (2 calls) and succeeds; bad-then-bad → throws
  `EnrichmentError` after exactly 2 calls; unparseable JSON → treated as
  a validation failure (retry then throw).
- **facts table (DB)** — a parent fact and its variant (`parentId`) each
  persist their own distinct enrichment blob + promoted columns; the
  variant's row is independent of the parent's.

### B2. routes.reviews (most of 37) + reviews.reject

Regression for the submission/approval surface, now enrichment-aware.

> **Expected log noise:** in the test env `AI_INTEGRATIONS_OPENAI_*` is
> not set, so the background `enrichAndStorePendingReview` during
> `submit-review` throws inside `getOpenAIClient()`. This is **caught**
> (fire-and-forget) — the review is marked `enrichment_status = failed`
> and submission still returns 201. Seeing that stack trace in the test
> output is the **graceful-degradation path working**, not a failure.
> The suite passes.

### B3. routes.ai (10 tests)

The `/ai/suggest-hashtags` auth+validation block was removed; the file
still covers `check-duplicate`, `tokenize-fact`, and `suggest-pronouns`.
Pass criterion: 10 tests, 0 fail.

### B4. routes.admin.auth (119 tests)

The `ADMIN_AUTH_ROUTES` registry guard requires every `/admin/*` route
to be listed. The new `post /admin/facts/backfill-enrichment` was added
to the registry; the "router auth coverage completeness" test must pass
(it fails loudly if the registry drifts from the router).

### B5. scenePromptConfig (3 tests)

Touched indirectly — `seed.ts` now also calls `seedFactEnrichmentConfig()`.
Confirms the existing config seeding still works (idempotent, debug
overlay intact).

---

## C — API smoke (curl)

Once the server is running. You need an authenticated user session for
submit, and an **admin** session for the review/backfill endpoints.

### C1. Submit a fact — review created with enrichment pending

```bash
curl -i -s -X POST -H "Cookie: <user-session>" \
  -H "Content-Type: application/json" \
  -d '{"text":"When {SUBJ} does pushups, {SUBJ} pushes the Earth down."}' \
  http://localhost:<api-port>/api/facts/submit-review
```

Pass criterion: `201 { success: true, reviewId }`. Then:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, enrichment_status FROM pending_reviews ORDER BY id DESC LIMIT 1;"
```

- With OpenAI configured (`AI_INTEGRATIONS_OPENAI_API_KEY` +
  `AI_INTEGRATIONS_OPENAI_BASE_URL`): `enrichment_status` transitions
  `pending` → `ok` within a few seconds and `enrichment` is populated.
- Without OpenAI configured: `enrichment_status = failed`,
  `enrichment = NULL` — and the submission still succeeded. This is the
  expected non-blocking behavior.

### C2. Admin list/detail returns enrichment

```bash
curl -s -H "Cookie: <admin-session>" \
  "http://localhost:<api-port>/api/admin/reviews?status=pending" \
  | jq '.reviews[0] | {id, enrichmentStatus, enrichment}'
```

Pass criterion: response includes `enrichmentStatus` and `enrichment`
(blob or null).

### C3. Save edited enrichment (PATCH)

```bash
curl -i -s -X PATCH -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"enrichment":{
        "primaryArchetype":"superhuman_physical_feat",
        "subtype":"force_scaled_action",
        "modifiers":["clear_causal_relationship","single_subject_focus"],
        "visualLiteralness":"literal_dramatization",
        "visualComplexity":"medium",
        "overhypeFit":"strong",
        "adultSuitability":"safe",
        "adultSuitabilityNotes":"",
        "suggestedHashtags":["strength","pushups","earth","legendary"],
        "taxonomyConfidence":0.95,
        "adminReviewNotes":""}}' \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/enrichment
```

Pass criteria:
- Valid body → `200 { success:true, enrichment }`, and `enrichment_status`
  becomes `ok`.
- A body whose `subtype` doesn't belong to `primaryArchetype` (e.g.
  `subtype:"social_role_reversal"` under `superhuman_physical_feat`), or
  fewer than 3 hashtags → `400 { error: "Invalid enrichment: …" }`.

### C4. Re-run enrichment

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/enrich
```

Pass criterion: `200 { success:true, enrichmentStatus:"pending" }`; the
background job then sets `ok` (OpenAI configured) or `failed`.

### C5. Approve — enrichment + promoted columns land on the fact

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"adminNote":"looks good","enrichment":{ …same valid blob as C3… }}' \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/approve
```

Then:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, primary_archetype, subtype, overhype_fit, adult_suitability,
          enrichment IS NOT NULL AS has_blob
   FROM facts ORDER BY id DESC LIMIT 1;"
```

Pass criteria:
- New fact row has `primary_archetype`, `subtype`, `overhype_fit`,
  `adult_suitability` populated from the blob, and `has_blob = t`.
- The enrichment's `suggestedHashtags` are attached (rows in
  `fact_hashtags` for the new fact id).
- A malformed `enrichment` body → `400`, no fact inserted.
- If `enrichment` is omitted from the body, the stored pending-review
  enrichment is used; if that's also absent, the fact is created with
  null enrichment and the submitter's manual hashtags are attached
  (back-compat).

### C6. Approve as variant — independent enrichment

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  -H "Content-Type: application/json" \
  -d '{"parentFactId":<existingFactId>,"enrichment":{ …a DIFFERENT valid blob… }}' \
  http://localhost:<api-port>/api/admin/reviews/<reviewId>/approve-variant
```

Pass criterion: the new variant row (`parent_id = <existingFactId>`)
stores its own enrichment, independent of the parent's.

### C7. Backfill enrichment (admin)

```bash
curl -i -s -X POST -H "Cookie: <admin-session>" \
  http://localhost:<api-port>/api/admin/facts/backfill-enrichment
```

Pass criteria:
- `200 { success:true, queued:<N>, message }` immediately (runs in the
  background, sequentially, to respect OpenAI rate limits).
- With OpenAI configured: facts that had `enrichment IS NULL` gain blobs
  + promoted columns over the next minutes (watch the
  `[admin] backfill-enrichment: done {total,done,failed}` log line).
- `?force=true` re-enriches **every** active fact (not just null ones).
- 401 unauthenticated / 403 non-admin (covered by `routes.admin.auth`).

---

## D — Frontend

```bash
cd artifacts/overhype-me
pnpm run typecheck      # tsc --noEmit — clean
pnpm exec vitest run    # 494 tests pass
```

Pass criterion: typecheck clean; all 494 vitest tests pass. (The
`HTMLCanvasElement.getContext` warnings are pre-existing jsdom noise.)

The frontend pieces under test indirectly:
- `SubmitFact.tsx` — the live `/ai/suggest-hashtags` call + suggestion
  pills were removed; the manual hashtag input remains.
- `components/admin/EnrichmentEditor.tsx` — the editor + read-only
  summary (imports the shared taxonomy constants + `validateEnrichment`).
- `pages/admin/moderation.tsx` — renders the editor in the review modal.
- `pages/admin/facts.tsx` — the "Backfill enrichment" button.

---

## E — What's deliberately NOT shipped

Flag these as expected gaps, not failures:

- **No image/video prompt generation.** This phase stores taxonomy only.
- **Structured Outputs (`json_schema`) not used** — the service uses
  OpenAI JSON mode + app-side zod validation + one corrective retry,
  matching every other OpenAI call in this server (proven through the
  Replit proxy).
- **No automatic backfill of existing facts on deploy** — backfill is an
  explicit admin action (and bulk-imported facts are covered by it).
- **Enrichment is best-effort at submission** — if OpenAI is down or
  unconfigured, the review is flagged `failed` and the admin fills it in
  manually; submission is never blocked.

---

## F — Environment note

Real classification requires the OpenAI integration to be provisioned:

```
AI_INTEGRATIONS_OPENAI_API_KEY
AI_INTEGRATIONS_OPENAI_BASE_URL
```

Without them, every enrichment call fails gracefully (`enrichment_status
= failed`) and the metadata must be filled manually in the admin UI. The
unit tests inject a fake model caller, so **section B does not need
OpenAI**; sections C5–C7 and the UAT's "real classification" steps do.
