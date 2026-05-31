# Visual Taxonomy on Facts — Automated test run

Engineering-side checklist for surfacing the **Visual Taxonomy
Enrichment** editor on the admin Facts page (`/admin/facts`). The same
editor already lives on `/admin/moderation`; this change makes it a
single reusable object used by both, and adds the backend a live fact
needs to load + edit + re-classify its enrichment. Hand this to Replit
(or run locally) to confirm everything is wired correctly.

The User Acceptance Test is in
[`VISUAL_TAXONOMY_FACTS_UAT.md`](./VISUAL_TAXONOMY_FACTS_UAT.md) — that
one is for the product owner to click through in a browser.

---

## TL;DR

```bash
# 1. Apply the new migration (single ADD COLUMN, snapshot-exempt).
pnpm --filter @workspace/db run migrate

# 2. Validate the migration snapshot chain.
pnpm --filter @workspace/db run check-snapshots

# 3. Repo-wide typecheck (libs build first).
pnpm typecheck

# 4. New + drift-checked backend tests.
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts \
  artifacts/api-server/src/__tests__/routes.admin.auth.test.ts \
  artifacts/api-server/src/__tests__/factEnrichment.test.ts

# 5. Backend regression on the refactored enrichment-job path.
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/routes.reviews.test.ts \
  artifacts/api-server/src/__tests__/reviews.reject.test.ts

# 6. Frontend tests (new hook tests + full suite).
cd artifacts/overhype-me && pnpm exec vitest run
```

If everything above is green, you can stop. Sections below break each
step out in case anything fails.

---

## A — Setup gate

### A1. Test DB is up

A Postgres database must be reachable. The connection setup belongs to
the running environment, not to this doc — Replit owns it.

### A2. New migration applies cleanly

This change ships **one** new migration:

- `0069_facts_enrichment_status.sql` — `ALTER TABLE facts ADD COLUMN
  enrichment_status varchar(16)` (nullable). Mirrors
  `pending_reviews.enrichment_status`. Registered as snapshot-exempt in
  `lib/db/scripts/check-migration-snapshots.ts` (drizzle-kit snapshot
  regen still fails on the upstream malformed 0063 snapshot, same as
  0064–0068; `lib/db/src/schema/facts.ts` is the source of truth).

```bash
pnpm --filter @workspace/db run migrate
```

Confirm `facts.enrichment_status` exists afterward:

```sql
SELECT column_name, data_type, character_maximum_length
FROM information_schema.columns
WHERE table_name = 'facts' AND column_name = 'enrichment_status';
-- expect: enrichment_status | character varying | 16
```

### A3. Schema chain valid

```bash
pnpm --filter @workspace/db check-snapshots
```

Pass criterion: `✓ All <N> journal entries have snapshot files (or are
explicitly exempt).` and `✓ Snapshot chain is valid`. (One new journal
entry, exempt — no new snapshot file.)

### A4. Typecheck

```bash
pnpm typecheck
```

Pass criterion: no new errors. **Pre-existing** errors in
`src/routes/videos.ts` and `src/routes/videoJobs.ts` (about the `User`
type) are on `main` already and are NOT introduced here — ignore them.

---

## B — Backend tests

### B1. Facts enrichment endpoints + job branch (new file)

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/routes.adminFactsEnrichment.test.ts
```

Pass criterion: **11 tests pass, 0 fail.**

| Surface | Check |
| --- | --- |
| `GET /admin/facts/:id` | returns `enrichment`, `enrichmentStatus`, derived `previewStatus`; **omits** `embedding`, `aiScenePrompts`, `aiMemeImages`, `pexelsImages`; 404 unknown, 400 for `0` / negative / non-numeric id |
| `PATCH /admin/facts/:id/enrichment` | valid blob → 200, projection columns (`primaryArchetype`/`subtype`/`overhypeFit`/`adultSuitability`) re-synced in the DB row, `enrichmentStatus="ok"`, response carries `enrichment` + `projection`; **invalid blob → 400 and the row is untouched**; 404 unknown, 400 bad id |
| `POST /admin/facts/:id/enrich` | marks `enrichmentStatus="pending"` and enqueues an `enrichment` job with `payload.factId` + `dedupeKey=enrichment:fact:<id>`; 404 unknown, 400 bad id |
| `runEnrichmentForFact` (job branch) | classify-fail → `enrichmentStatus="failed"`; classify-ok + preview-fail → **`enrichmentStatus="ok"`, `enrichment.previewStatus="failed"`** (job returns ok, not retried forever); classify-ok + preview-ok → both set, `visualPromptPreview` present |

The classify + preview calls are network operations, so the job-branch
tests inject deterministic stubs via the `runEnrichmentForFact(factId,
deps)` seam. The full model path is exercised in the UAT.

### B2. Admin auth coverage (drift-checked)

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/routes.admin.auth.test.ts
```

Pass criterion: all pass. This file 401/403-tests every admin route and
asserts `ADMIN_AUTH_ROUTES` is in lockstep with `adminRouter.stack`. The
three new routes (`GET /admin/facts/:id`, `PATCH
/admin/facts/:id/enrichment`, `POST /admin/facts/:id/enrich`) are
registered there — a missing entry fails the completeness check loudly.

### B3. Enrichment validation unit tests (regression)

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/factEnrichment.test.ts
```

Pass criterion: all pass. `buildFactEnrichmentColumns` and
`validateEnrichment` behavior is unchanged; this confirms the PATCH
endpoint's validation + projection helper still behave.

### B4. Enrichment-job + reviews regression

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/routes.reviews.test.ts \
  artifacts/api-server/src/__tests__/reviews.reject.test.ts
```

Pass criterion: all pass. The `enrichment` job handler was generalized
to dispatch on `{ reviewId }` vs `{ factId }`; the review path was
extracted verbatim into `runEnrichmentForReview`, so the review
submission/approve/reject flow is unchanged.

### B5. Sharded runner note

`pnpm --filter @workspace/api-server test` uses
`scripts/run-tests-sharded.sh` with `--test-isolation=none`, a flag this
sandbox's node build rejects. Workaround: invoke individual files via
`node --import tsx/esm --test <path>` as above. **Not introduced here** —
flagged in prior sessions too.

---

## C — Frontend tests

```bash
cd artifacts/overhype-me && pnpm exec vitest run
```

Pass criterion: **all files pass** (525+ tests). New file:
`src/components/admin/useEnrichmentDraft.test.tsx` — **3 tests**:

- a valid edit autosaves to `/api/admin/facts/:id/enrichment` after the
  debounce;
- an **invalid** edit does NOT autosave and surfaces `unsavedInvalid`
  (valid-only autosave guard);
- a pending save does not leak across an id change (switching the bound
  fact cancels the pending save — no cross-fact write).

`use-form-draft.test.tsx` and the rest of the suite still pass; the
moderation modal was refactored to consume the shared
`useEnrichmentDraft` hook with no behavior change.

---

## D — Manual API smoke (optional, no model spend)

As an admin session against a running dev server:

```bash
# Detail shape (pick a fact id that has enrichment).
curl -s "http://localhost:<api-port>/api/admin/facts/<id>" \
  -H "Cookie: <admin-session>" | jq 'keys'
# expect: includes enrichment, enrichmentStatus, previewStatus,
# hasEmbedding, hasPexelsImages; NOT embedding/aiScenePrompts/aiMemeImages.

# Save edit (round-trip the existing blob; projection re-synced).
curl -s -X PATCH "http://localhost:<api-port>/api/admin/facts/<id>/enrichment" \
  -H "Cookie: <admin-session>" -H "Content-Type: application/json" \
  -d '{"enrichment": <valid FactEnrichment>}' | jq '.projection'
```

The list endpoint now also returns `primaryArchetype`,
`enrichmentStatus`, and `hasEnrichment` so list rows can show the
"enriched" chip.

---

## What this change explicitly does NOT ship

- **No new schema beyond `facts.enrichment_status`.** The enrichment
  blob + projection columns already existed.
- **No change to the visual-preview / image generation pipeline.** Re-run
  classification reuses the existing `enrichFact` + `generateVisualPreview`
  path; the preview job already supported a fact target.
- **`enrichmentStatus` tracks classification only.** Visual-preview state
  stays in `enrichment.previewStatus`; a preview failure never marks
  `enrichmentStatus` failed.
- **No bulk re-classify UI change.** The existing "Backfill enrichment"
  control on the Facts page is untouched; this adds per-fact editing.

---

## Notes for future sessions

- Enrichment editing + autosave + re-run + preview-regeneration now live
  in one hook, `artifacts/overhype-me/src/components/admin/useEnrichmentDraft.ts`,
  parameterized by `resource: "reviews" | "facts"`. Change the editor or
  its behavior there and both `/admin/moderation` and `/admin/facts` move
  together.
- The hook is resource-aware, not page-aware: approve-gating
  (`isApprovable`) and the re-run confirmation dialog live in the pages.
- Branch: `claude/affectionate-hamilton-S3TAK`.
