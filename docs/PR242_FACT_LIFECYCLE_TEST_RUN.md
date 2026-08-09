# PR242 — Close the fact lifecycle · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. **Replit owns the DB connection** — no `DATABASE_URL` /
test-DB env is set anywhere in this doc. Verifies the Phase 2 fact-lifecycle
closure: activation is moderation-only + concept-gated (DB CHECK), and every
ingestion path funnels into Stage-1 moderation.

Pre-merge gates (install, typecheck, codegen drift — including the
`POST /facts`-removal drift check) are assumed green; spot-check only if
something below fails.

**No test suites in this checklist, deliberately.** This closure is covered
by `factLifecycleClosure.test.ts` (the `facts_active_requires_concept` CHECK
+ `activateFact`'s `ConceptMissingError` / `ParentNotActiveError` /
`ActivationConflictError` paths), `routes.import.test.ts`,
`routes.admin.test.ts`, `routes.reviews.test.ts`, `routes.facts.test.ts`,
`routes.resubmitForModeration.test.ts` (the round-7 follow-up reactivation
route), and `routes.admin.auth.test.ts` (drift guard — fails loudly if a new
admin route ships without an `ADMIN_AUTH_ROUTES` entry) — all of which
already ran and passed in CI against a real Postgres, on this exact code.
Re-running them here would verify nothing new. Everything below is what CI
genuinely *cannot* see: the state of the live database and the live app.

## Repo-health gates (post-merge state — run always)
- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`)
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entries this PR added:
  `0091_fact_lifecycle_phase1_additive` (hand-authored idempotent DDL) and
  `0092_fact_lifecycle_phase2_backfill_check` (DML + the blocking CHECK
  constraint) — confirm both are present.
- `node scripts/check-docs-accuracy.mjs` — expected: clean
- Other allow-list entries this PR added: none

## Live checks (read-only; run always)

Nothing below writes a row — check 4 is a rejected-insert probe, and a
rejected insert persists nothing regardless of how many times it's run.

1. Migration `0091` (additive) then `0092` (backfill + CHECK) applied —
   confirm:
   - `pending_reviews.parent_fact_id` column exists (integer, nullable, FK →
     `facts.id` ON DELETE SET NULL).
   - `facts.is_active` default is now `false`.
   - CHECK constraint `facts_active_requires_concept` exists on `facts`.
   - The deploy log carries `0092`'s backfill line: `[0092] fact-lifecycle
     grandfather backfill: deactivated_no_valid_enrichment=…,
     orphan_children_deactivated=…, sentinel_concept_stamped=…` — confirms the
     inline startup backfill ran once; don't re-trigger it to reproduce the
     line.
2. Re-running migration `0092`: a second `pnpm --filter @workspace/db run
   migrate` is **skipped by the content-hash tracker** — confirm skipped, not
   re-applied, no changes. (By design, not something this checklist
   re-executes to prove: `ADD CONSTRAINT` is separately guarded with an `IF
   NOT EXISTS` check against `pg_constraint`, and the backfill's
   deactivate/orphan-sweep/sentinel steps each only touch rows that still
   need it.)
3. No active fact has a blank/absent concept — read-only count, verifying the
   backfill actually caught every row that needed transforming:
   `SELECT count(*) FROM facts WHERE is_active AND COALESCE(jsonb_typeof(enrichment #> '{visualPromptStrategyOverride,coreSceneOverride}')='string' AND (enrichment #>> '{visualPromptStrategyOverride,coreSceneOverride}') ~ '\S', false) = false;`
   — expected: `0`.
4. `facts_active_requires_concept` rejects a bad insert — attempt a raw-SQL
   insert of an active fact with no concept → expected: **rejected** by the
   constraint, before anything is written. (The constraint's other two cases
   — active-with-concept allowed, inactive-without-concept allowed — are
   already covered by `factLifecycleClosure.test.ts` in CI; skip exercising
   them live, since a successful insert here would leave a real row with no
   documented cleanup path.)
5. Grandfathered sentinels are greppable: `coreSceneOverride = '{NAME} stands
   there confidently.'`.

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
