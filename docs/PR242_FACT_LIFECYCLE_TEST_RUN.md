# PR #242 — Close the fact lifecycle — TEST_RUN

Engineering/automated checklist for Replit (the technical safety net). This
verifies the Phase 2 fact-lifecycle closure: activation is moderation-only +
concept-gated (DB CHECK), and every ingestion path funnels into Stage-1 moderation.

> **Replit owns the database connection.** Don't set `DATABASE_URL` or test-DB env
> here — apply migrations and run the test files against whatever DB Replit uses.

## 1. Apply migrations + re-clone test schema

Apply the schema to the local public schema, run migrations, then re-clone the
test schema so tests see the new shape:

- `pnpm --filter @workspace/db push-force`
- `pnpm --filter @workspace/db run migrate`  ← applies `0091` (additive) then `0092` (backfill + CHECK)
- Re-clone the test schema (`bash artifacts/api-server/scripts/run-test.sh --setup <any file>` does this once).

**Confirm the migration landed:**
- `pending_reviews.parent_fact_id` column exists (integer, nullable, FK → `facts.id` ON DELETE SET NULL).
- `facts.is_active` default is now `false`.
- CHECK constraint `facts_active_requires_concept` exists on `facts`.
- Migration `0092` log line: `[0092] fact-lifecycle grandfather backfill: deactivated_no_valid_enrichment=…, orphan_children_deactivated=…, sentinel_concept_stamped=…`.

## 2. Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`). New exemptions this PR added:
  `0091_fact_lifecycle_phase1_additive` (hand-authored idempotent DDL) and
  `0092_fact_lifecycle_phase2_backfill_check` (DML + the blocking CHECK
  constraint) are both in `SNAPSHOT_EXEMPT_TAGS` — confirm both entries are
  present.
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Typecheck (`typecheck:libs`, per-package `tsc -b`) — pre-merge gates assumed
  green; spot-check only if something below fails.

## 3. Codegen drift (POST /facts removal) — run always, not a trivial re-check

- `pnpm --filter @workspace/api-spec run codegen` then `git diff --exit-code lib/api-zod/src/index.ts` is **clean** (the removed `createFact`/`CreateFactBody`/`CreateFactRequest` drop out of the generated modules, not the index line-list).

## 4. Backend test files (run each; expect `# fail 0`)

Runner: `bash artifacts/api-server/scripts/run-test.sh src/__tests__/<file>` (add
`--setup` only on the first run to re-clone). Key files touched by this PR:

| File | Expect | Covers |
|---|---|---|
| `factLifecycleClosure.test.ts` | 9/9 | **NEW** — the DB CHECK (active needs a non-empty string concept; inactive unconstrained) + `activateFact` (`ConceptMissingError` / `ParentNotActiveError` / `ActivationConflictError`, never activates on failure) |
| `routes.import.test.ts` | 15/15 | API-key bulk import → Stage-1 **system** reviews (`submittedById=null`), `{queued,skipped,failed}`, dedup vs facts **and** unresolved reviews, raw hashtags on the review, no facts written |
| `routes.admin.test.ts` | 45/45 | admin import/import-csv → queued reviews; variant → queued review carrying `parent_fact_id` (no active variant fact); cleanup clears reviews before users |
| `routes.reviews.test.ts` | 55/55 | manual submit unchanged; provisional-approve threads the parent; production approval activates through `activateFact` |
| `routes.facts.test.ts` | 31/31 | public feed still returns active facts; `POST /facts` is gone |
| `routes.resubmitForModeration.test.ts` | 4/4 | **NEW** (round 7 follow-up) — `POST /admin/facts/:id/resubmit-for-moderation`: re-enters an INACTIVE fact at `prep_pending` reusing its existing id (no duplicate fact), preserves a variant's `parentId`, 404 missing / 409 `ALREADY_ACTIVE` / 409 `REVIEW_ALREADY_IN_PROGRESS` |
| `routes.admin.auth.test.ts` | full suite | the new route is registered in `ADMIN_AUTH_ROUTES` (drift-guard test — fails loudly if a route is added without an entry) |

**Sharded full run — shared infra touched: yes** (this migration flips
`facts.is_active`'s default, adds a blocking CHECK constraint evaluated on
every fact, and retires `POST /facts` across every ingestion path — broad
enough blast radius to warrant the full run): `pnpm --filter @workspace/api-server test`.
**Stop the `artifacts/api-server: API Server` workflow first** to free
test-DB connections, or the `pretest` chain can stall against the test
database. **Known
environmental caveat in this container:** the sharded per-schema clone does **not**
clone the external `stripe` schema, so some shards emit `relation "stripe.prices"
does not exist` and cascade-cancel siblings. Those are infra, **not** this PR — every
affected file passes in isolation and there are **0** `facts_active_requires_concept`
violations across the suite. If your CI uses create-database mode (full schema clone),
the stripe issue does not occur.

## 5. Manual DB checks (against Replit's DB)

- Insert an active fact with no concept via raw SQL → **rejected** by
  `facts_active_requires_concept`. With a non-empty `enrichment ->
  visualPromptStrategyOverride ->> coreSceneOverride` → allowed. Inactive with no
  concept → allowed.
- After migrate, confirm no active fact has a blank/absent concept:
  `SELECT count(*) FROM facts WHERE is_active AND COALESCE(jsonb_typeof(enrichment #> '{visualPromptStrategyOverride,coreSceneOverride}')='string' AND (enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S', false) = false;` → **0**.
- Grandfathered sentinels are greppable: `coreSceneOverride = '{NAME} stands there confidently.'`.

## 6. Idempotency

- Re-run `0092` (or its statements): deactivate/orphan-sweep/sentinel steps are all
  no-ops on a second pass; `ADD CONSTRAINT` is guarded (`IF NOT EXISTS` on
  `pg_constraint`). Counts on the second run should be `0, 0, 0`.

## What's deliberately NOT shipped

- No direct "reactivate a deactivated fact" toggle — David confirmed activation is
  moderation-only. Round 7 added `POST /admin/facts/:id/resubmit-for-moderation` so a
  deactivated fact isn't permanently stuck: it re-enters at `prep_pending` under its
  existing id and rides the normal pipeline back to production approval.
- No async/queued backfill — the grandfather backfill runs inline in `0092` at
  startup (single-instance deploy, migrate-before-serve), which is sufficient at
  this scale.
- "Invalid enrichment" is detected via the `primary_archetype` projection proxy (a
  real materialized enrichment always has it), not a full Zod re-validation in SQL.

## Delete me

Transient — delete once Replit has run the checklist. The
[`PR242_FACT_LIFECYCLE_UAT.md`](./PR242_FACT_LIFECYCLE_UAT.md) sibling is the
durable half.
