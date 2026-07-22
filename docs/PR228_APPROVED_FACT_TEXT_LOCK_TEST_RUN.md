# PR228 — Approved Fact Text Lock — TEST_RUN (Replit / engineering)

> Engineering/automated checklist for the technical safety net. Transient —
> delete once it has been run and confirmed. The UAT sibling
> (`PR228_APPROVED_FACT_TEXT_LOCK_UAT.md`) is the durable half.

## What this PR does (one paragraph)

Editing an **approved** fact's text is now gated: `PATCH /admin/facts/:id` routes
any real text change through a transactional lock service. A protected fact
(live, or ever production-approved, or any ambiguous/legacy inactive row)
requires a typed `{phrase, reason, expectedOldTextHash}` confirmation; a
confirmed edit clears the fact's and its direct variants' processing signatures
(→ stale-for-reprocess), preserves enrichment, and writes one
`fact_text_edit_history` row. A never-approved first-time **staging** fact stays
freely editable but its edit **restarts prep** (enrichment/Pexels/Visual-Ideas).
First-time production approval got a compare-and-set (can't publish wording it
didn't validate), and the enrichment worker discards a result whose input
drifted mid-classify.

## Migrations / schema

Apply migrations, then re-clone the test schema:

```
pnpm --filter @workspace/db push-force
pnpm --filter @workspace/db run migrate
```

Confirm after migrate:
- table `fact_text_edit_history` exists with columns `id` (bigserial PK),
  `fact_id` (FK → facts, ON DELETE CASCADE), `old_text`, `new_text`, `reason`,
  `performed_by` (FK → users, **ON DELETE SET NULL**), `created_at`.
- index `IDX_fteh_fact_created` on `(fact_id, created_at DESC)`.
- index `idx_pending_reviews_approved_fact` on `pending_reviews(approved_fact_id)`.
- `0089_fact_text_edit_history` present in `meta/_journal.json` (90 entries) and
  reported `applied` by the migrate runner. Migration is idempotent
  (`CREATE TABLE/INDEX IF NOT EXISTS`); re-running `migrate` is a no-op. No backfill.

## Automated tests

Targeted runner (never raw `node --test`):

```
bash artifacts/api-server/scripts/run-test.sh --setup src/__tests__/factTextEditProtection.test.ts
bash artifacts/api-server/scripts/run-test.sh src/__tests__/confirmedFactTextEdit.test.ts
bash artifacts/api-server/scripts/run-test.sh src/__tests__/routes.admin.test.ts
bash artifacts/api-server/scripts/run-test.sh src/__tests__/routes.adminFactsEnrichment.test.ts
bash artifacts/api-server/scripts/run-test.sh src/__tests__/routes.reviews.test.ts
bash artifacts/api-server/scripts/run-test.sh src/__tests__/enrichmentVersioning.refresh.test.ts
```

Expected (local, verified):
- `factTextEditProtection` — **12 pass** (fail-closed matrix: active / ever-approved /
  orphan / single-first-time-staging / two-first-time → ambiguous / lone-refresh →
  ambiguous / resolved-historical-ignored; variant blocking; nonterminal-vs-terminal job).
- `confirmedFactTextEdit` — **9 pass** (confirmation_required, invalid phrase, stale hash,
  valid → commit + signature cleared + enrichmentStatus preserved + one audit row,
  no-op normalized text, root clears child signatures, dependent-variant block, staging
  restart, staging prep-in-progress).
- `routes.admin` — **45 pass** (incl. the normalization test now on the confirmed path,
  and 3 history-endpoint tests: auth, newest-first + deleted-actor fallback, 404).
- `routes.adminFactsEnrichment` — **18 pass** (incl. worker input-drift discard).
- `routes.reviews` — **55 pass** (provisional-approve rewired to the shared prep service).
- `enrichmentVersioning.refresh` — **23 pass** (worker recheck still discards on send-back).

Frontend:

```
pnpm --filter @workspace/api-spec run codegen
pnpm run typecheck:libs
pnpm --filter @workspace/overhype-me run typecheck
pnpm --filter @workspace/overhype-me exec vitest run src/components/admin/ApprovedFactTextEditModal.test.tsx src/components/admin/patchFactDraft.test.ts src/components/admin/useDraftForm.test.tsx
pnpm --filter @workspace/overhype-me run build
```

Expected: modal + client **10 pass**, useDraftForm **14 pass**, typechecks clean,
Vite production build succeeds.

## Manual API spot-checks (curl against a running server, admin session)

Let Replit own `DATABASE_URL`. With `$SID` an admin session cookie and `$F` a
**live** fact id:

1. Text change, no confirmation → `409` `TEXT_EDIT_REQUIRES_CONFIRMATION`, body has
   `impact` (currentStoredText, normalizedProposedText, expectedOldTextHash,
   affectedVariantCount, persistedMemeCount/liveMemeCount, refreshInFlight).
2. Same with `confirmTextEdit:{phrase:"CHANGE APPROVED FACT TEXT", reason:"<≥10 chars>",
   expectedOldTextHash:"<from step 1>"}` → `200`; row `fact_text_edit_history` has one new
   row; `facts.last_processed_signature` for `$F` is now null; Taxonomy Health lists `$F`
   as `stale_for_reprocess`.
3. Wrong `expectedOldTextHash` → `409` `TEXT_EDIT_STALE_BASELINE`, nothing written.
4. Score-only PATCH (no `text`) on `$F` → `200`, no confirmation, no audit row.
5. A root with an active child variant review → `409`
   `DEPENDENT_VARIANT_IN_PROGRESS`, no write.
6. `GET /admin/facts/$F/text-edit-history` → newest-first entries; `actor:null` renders
   as "deleted admin" in the UI when `performed_by` was nulled.

## Deliberately NOT shipped (out of scope, by design)

- No change to fact **creation** paths (submit / staging insert / import / seed).
- No auto-reject of an in-flight refresh, no meme-image regeneration, no second-admin
  sign-off, no artificial delay (all listed deferred in the plan).
- No `docs/plans` file lands on main.

## Deferred to CI / not automatable here

- Full DB-backed api-server suite (`pnpm --filter @workspace/api-server test`) — run in CI.
- **Two-transaction approval-concurrency ordering** test (edit wins vs approval wins):
  the compare-and-set uses conditional `UPDATE … WHERE text=validated AND stage=… RETURNING`
  and is covered by design + the service tests, but a deterministic concurrent-transaction
  harness (advisory locks / barrier) is a CI/manual follow-up. Manual check: start an
  approval, re-word the staging fact via PATCH before committing, confirm approval returns
  `FACT_TEXT_CHANGED_DURING_APPROVAL` and the fact stays inactive.
