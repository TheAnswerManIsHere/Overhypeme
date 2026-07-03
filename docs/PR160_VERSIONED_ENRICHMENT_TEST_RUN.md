# PR160 — Versioned Enrichment Core (Stale-Fact Refresh PR1) · Engineering Test Run

> **Audience:** Replit (automated technical safety net).
> **Scope:** backend versioning core only — schema, candidate job, moderation-reader
> routing, promote/reject, and the `sendFactBackToReview` primitive. The admin
> UI surface (send-back button, version-history list) is **PR2** — see
> "Deliberately not shipped" at the bottom before flagging anything as missing.
> **Companion:** `docs/PR160_VERSIONED_ENRICHMENT_UAT.md` (David's in-app pass).

---

## 1. Setup

1. Check out the PR branch (`claude/pr1-section-8-tz0z1o`) and `pnpm install`.
2. Apply migrations against your database (you own the connection; no env config
   is prescribed here):

   ```bash
   pnpm --filter @workspace/db run migrate
   ```

   Expected: `Applying 0078_fact_enrichment_versions` on a DB that doesn't have
   it yet, or `79 already up-to-date` on one that does. The migration is
   idempotent hand-written SQL (repo convention; drizzle-kit generate is broken
   on the pre-existing malformed 0063 snapshot, and 0078 is listed in
   `SNAPSHOT_EXEMPT_TAGS`).

3. Snapshot guard:

   ```bash
   pnpm --filter @workspace/db run check-snapshots
   ```

   Expected: passes.

## 2. Schema checks (SQL)

Run against the migrated DB:

```sql
-- Table exists with all 18 columns
SELECT count(*) FROM information_schema.columns
WHERE table_name = 'fact_enrichment_versions';          -- expect 18

-- The one-candidate-per-fact partial unique index
SELECT indexdef FROM pg_indexes
WHERE indexname = 'UQ_fev_one_candidate_per_fact';
-- expect: UNIQUE ... ON fact_enrichment_versions (fact_id) WHERE status = 'candidate'

-- Both ALTERs
SELECT column_name FROM information_schema.columns
WHERE table_name = 'pending_reviews'  AND column_name = 'candidate_version_id';  -- 1 row
SELECT column_name FROM information_schema.columns
WHERE table_name = 'facts' AND column_name = 'last_processed_signature';         -- 1 row
```

## 3. Typecheck + full test suite

```bash
pnpm typecheck
# expect: clean across all packages (api-server also runs check:cycles + check:no-console)

pnpm --filter @workspace/api-server test
# expect: 552 tests, 0 fail (sharded runner; its pretest applies push-force +
# migrations itself)
```

The new suite is `src/__tests__/enrichmentVersioning.refresh.test.ts` — **15
tests, all must pass**. To run it alone (from `artifacts/api-server/`, after
the DB is migrated):

```bash
BCRYPT_SALT_ROUNDS=4 node --import tsx/esm --test src/__tests__/enrichmentVersioning.refresh.test.ts
```

> Gotcha: run it from `artifacts/api-server/` (cwd matters for env/DB
> resolution); from the repo root the file fails to boot.

Frontend (one component touched — the moderation modal's prompt preview now
sends `reviewIdForRender`):

```bash
pnpm --filter overhype-me exec vitest run src/__tests__/RuntimePromptPreview.test.tsx
# expect: 12 pass
```

## 4. What the 15 refresh tests prove (spot-check map)

| Area | Assertions |
|---|---|
| `sendFactBackToReview` | candidate row seeded (overrides + visual override from ACTIVE, `fact_text_hash`, `version_no=1`, `source='refresh_candidate'`), NEW `prep_pending` review with `candidate_version_id`, `submitted_by_id=null`, `pending_reviews.enrichment` null; fact stays `is_active=true` with enrichment untouched, only `enrichment_status='pending'`; exactly one `enrichment` job with dedupeKey `enrichment:version:<id>`; **no** `fact_pexels` job |
| Guards | second concurrent refresh → `REFRESH_ALREADY_IN_PROGRESS` (names the in-flight cycle); inactive fact → `NOT_ACTIVE`; root with active variants → `HAS_ACTIVE_VARIANTS`; `clearOverrides` wipes the CANDIDATE seed only |
| Candidate job | writes the VERSION row (effective = fresh baseline + seeded override), never `facts.*`; advances its exact review to `production_review`; enqueues the deduped Step-2 default-render prep job; two-phase guard (resolved cycle pre-classify → paid classify skipped; mid-classify rejection → result discarded, cycle not re-advanced) |
| Reader isolation | plain `factId` preview reads ACTIVE; `resolveReviewCycleEnrichment`, single moderation render, scenario runner, and preview-with-`reviewIdForRender` all snapshot the CANDIDATE; fact/review mismatch → 400 `review_fact_mismatch` |
| Promote | `facts.*` ← candidate layers (manual override survives on top of fresh baseline); prior active archived as `superseded`/`prior_active_snapshot`; candidate → `promoted`; `last_processed_signature` = the CANDIDATE's signature; review `production_approved` with **no** enrichment audit snapshot; field-preservation (isActive, parentId, text, pexelsImages, aiMemeImages, upvotes/score, fact_hashtags all bit-identical); no submitter activity; idempotent re-approve |
| Drift guard | fact text edited after classify → approve returns 409 `REFRESH_STALE_TEXT`, nothing mutated |
| Not-ready candidate | approval before the job filled the blob → 400 |
| Reject | candidate RETAINED as `rejected` (blob kept), live fact bit-identical, `enrichment_status='ok'`, no submitter notification, a later send-back works (`version_no=2`) |
| Lookup determinism | `findReviewForStagingFact` returns the NEWEST review by `created_at` |

## 5. Manual smoke of the primitive (optional but recommended)

From `artifacts/api-server/` with a live fact id `<FID>`:

```bash
node --import tsx/esm -e "
import { sendFactBackToReview } from './src/lib/sendBackToReview.js';
console.log(await sendFactBackToReview({ factId: <FID>, adminId: null }));
process.exit(0);
"
```

Then confirm in SQL: one `candidate` row for the fact, one new `prep_pending`
review pointing at it, `facts.enrichment` unchanged, `facts.is_active` still
true. If a worker is running, the enrichment job will classify the candidate
and move the review to `production_review` (and enqueue default Step-2
renders). Clean up by rejecting the review through the admin UI (or delete the
review + version rows if you never ran the job).

## 6. Known gotchas

- `.claude/guard.sh` blocks a raw `drizzle-kit push` — always go through
  `pnpm --filter @workspace/api-server test` (its pretest handles push-force)
  or `pnpm --filter @workspace/db run migrate`.
- Enrichment fixtures must have ≥3 `suggestedHashtags` — a blob failing schema
  validation makes `resolveEnrichment` silently fall back to the raw AI
  baseline (overrides dropped), which looks like an override bug but isn't.
- Refresh review rows have `submitted_by_id = NULL` by design (admin-initiated;
  nobody to notify). Don't flag null submitters on refresh cycles.
- `fact_enrichment_versions.signature` is **null everywhere in PR1** —
  `TODO(PR3-signature)`. `facts.last_processed_signature` therefore also stays
  null after a promote until PR3 lands. Not a bug.

## 7. Deliberately NOT shipped in PR1

- `POST /admin/facts/:id/send-back-to-review` endpoint + Facts-page button +
  confirm modal with the "clear my edits" checkbox → **PR2**.
- Version-history list (`GET /admin/facts/:id/enrichment-versions`) and the
  distinct "Refresh review" labeling in the moderation list → **PR2**.
- `ProcessingSignature` model, staleness computation, Taxonomy Health
  `stale_for_reprocess` card, "Mark major update" → **PR3**.
- Bulk re-process queue + UI → **PR4**.
- Arbitrary-rollback UI (schema supports it; `TODO(version-rollback)` at the
  promote site).
