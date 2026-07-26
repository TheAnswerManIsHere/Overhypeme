# PR #256 — Variant independence — TEST_RUN

Engineering/automated checklist for Replit (the technical safety net). Verifies
that `facts.parent_id` is kinship + show/hide only — a variant no longer
inherits, is blocked by, or is denied its own metadata (enrichment, images, AI
generation) — and that the new async-queue/circuit-breaker machinery behind the
bulk-backfill routes is sound.

> **Replit owns the database connection.** Don't set `DATABASE_URL` or test-DB
> env here — apply migrations and run the test files against whatever DB
> Replit uses.

## 1. Apply the migration

- `pnpm --filter @workspace/db run migrate` ← applies `0093` (idempotent
  `ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "ai_meme_backfill_status"
  varchar(16)`).
- Re-clone the test schema if your runner requires it after a migration.

**Confirm it landed:** `facts.ai_meme_backfill_status` column exists,
`varchar(16)`, nullable, no default — every existing row reads `NULL`. Running
the migration a second time is a no-op (`IF NOT EXISTS`).

## 2. Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`; do not substitute `check-migration-snapshots.ts` — it
  reports the **pre-existing**, unrelated `0089`/`0090` gap regardless of this
  PR). New exemptions this PR added: `0093_facts_ai_meme_backfill_status` is
  in `SNAPSHOT_EXEMPT_TAGS` (mirrors the `0075_facts_pexels_status`
  precedent) — not required for
  `validate-snapshots` to pass, but confirms the exempt-list entry is present
  if you do run `check-migration-snapshots.ts` directly.
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- `pnpm run check:codegen-drift` — expected: clean (no hand-edited generated
  files).
- New `check:no-console` allowlist entry this PR added: `cliJobPoller.ts:78`
  (intentional, see the file's own comment).
- Typecheck (`typecheck:libs`, per-package `typecheck`/`tsc -b`) — pre-merge
  gates assumed green; spot-check only if something below fails.

## 3. Full sharded suite — shared infra touched: yes

New async-queue/circuit-breaker machinery lands in the shared job/queue layer
(`enqueueJob`, `async_jobs`) — shared infra, so the full run stays required
alongside the targeted list below.

**Stop the `artifacts/api-server: API Server` workflow first** to free
test-DB connections, or the `pretest` chain (push-force → migrate → codegen)
can stall against the test database.

## 4. Backend test files (run each; expect `# fail 0`)

Runner: `BCRYPT_SALT_ROUNDS=4 bash artifacts/api-server/scripts/run-test.sh
src/__tests__/<file>` (never raw `node`/`tsx` execution — it bypasses the
script's production-DB guard; `run-test.sh` already sets
`TEST_DB_ALLOW_EXIT_ON_IDLE` internally). New and touched files:

| File | Covers |
|---|---|
| `aiMemeBackfillJobs.test.ts` **(NEW)** | The `fact_ai_meme_backfill` queue: enqueue's conditional status write, crash-recovery entry guard for every marker state (a pre-existing `processing`/`ok`/`failed`/`skipped` marker each short-circuits without repeating the paid pipeline call), a terminal marker is not sticky (a second independent job re-runs normally), execution-time inactive recheck, success/failure paths |
| `factPexelsJobs.test.ts` **(NEW)** | The `bulkBackfill` payload discriminator's execution-time inactive recheck applies ONLY when set — the single-fact staging-prep enqueue path (`bulkBackfill` unset) is untouched and still honors `isStagingImagePrepActive`'s OR-with-review-status logic even on an inactive fact with an unresolved review |
| `cliJobPoller.test.ts` **(NEW)** | Terminal tallying (succeeded/skipped/failed), a job resolving on a later poll round (not just the first check), the zero-progress stall ceiling (fires on genuine staleness, does NOT fire on a healthy batch whose total wall-clock span exceeds the ceiling as long as some job keeps resolving), never logs a raw job/fact id |
| `routes.sendBackToReview.test.ts` | A root with an active variant now **succeeds** at send-back-to-review (previously 409 `HAS_ACTIVE_VARIANTS`) |
| `enrichmentVersioning.refresh.test.ts` | Same claim at the `sendFactBackToReview` library level |
| `factSendBackJob.test.ts` | Same claim at the `fact_send_back` job-handler level; `sendBackGuardToSkip` no longer maps `HAS_ACTIVE_VARIANTS` |
| `adminTaxonomyHealth.guardQueryChunking.test.ts` | `factsWithActiveVariants` removed along with its cross-chunk test |
| `routes.adminTaxonomyHealth.bulkSendBack.test.ts` | `all_stale`/`selected` scope: a root with an active variant is now eligible and enqueues; the repeated-failure circuit breaker (a 3-strike fact is excluded from `all_stale` + counted in `repeatedFailureCount`, but `scope:selected` still enqueues it normally — the only path that clears the streak) |
| `routes.adminTaxonomyHealth.actions.test.ts` | `GET /admin/taxonomy-health/facts`'s new `repeatedFailure` row field: `true` after 3 consecutive terminal `fact_send_back` failures, `false` again once a later success lands in the most-recent-3 window |
| `routes.admin.test.ts` | `refresh-images` and the confirmed-text-edit dispatch (embed + image pipeline) both now work for a variant, not just a root |
| `routes.facts.test.ts` | `GET /facts/:factId` and `GET /facts/:factId/pexels-images`: a variant with no images of its own shows none — never falls back to the root's; a variant WITH its own images shows exactly those |
| `routes.enrichmentOverrides.test.ts` | `runEnrichmentForFact` classifies a variant from its own text only — a distinctive marker in the root's text never reaches the classifier for a variant's job |
| `memesGenerateGeneric.test.ts` | `POST /memes/ai/:factId/generate` accepts a variant (previously 400 "only supported on root facts") |
| `confirmedFactTextEdit.test.ts`, `factTextEditProtection.test.ts` | Retired dependency machinery: a root text edit never blocks on or clears a variant's signature |
| `factEnrichment.test.ts`, `factEnrichmentRepair.test.ts`, `redundantMechanism.test.ts` | Enrichment signature v7 bump + the `status`/`parentText` field removal from `enrichFact`'s input |
| `ApprovedFactTextEditModal.test.tsx`, `patchFactDraft.test.ts`, `sendBackToReview.test.ts` (frontend) | Contract cleanup matching the backend changes |
| `useBulkMediaBackfillActions.test.ts` **(NEW)**, `taxonomy-health.bulkMediaBackfill.test.tsx` **(NEW)** | The new Bulk Media Backfill panel: submit → poll → terminal counts, independent action-key state, confirm-before-fire |

**Sharded full run:** `pnpm --filter @workspace/api-server test`. Expect **3
pre-existing failures**, all in `factLifecycleClosure.test.ts`'s `DB CHECK —
facts_active_requires_concept` suite (`REJECTS an active fact with null
enrichment` / `...whitespace-only concept` / `...non-string JSON scalar`).
Confirmed via `git stash` against a clean `main` before this PR — they exist
identically there, unrelated to this change. Everything else: `# fail 0`.

**Frontend:** `pnpm --filter @workspace/overhype-me test` (Vitest). Expect
**843/843 pass** across 80 files.

## 5. Manual DB checks (against Replit's DB)

- `SELECT dedupe_key FROM async_jobs WHERE queue = 'fact_ai_meme_backfill'
  LIMIT 5;` — after the worker has processed a few jobs, dedupe keys follow
  `fact_ai_meme_backfill:fact:<id>`.
- `SELECT ai_meme_backfill_status, count(*) FROM facts GROUP BY 1;` — new rows
  are `NULL` until they run through the new bulk-backfill queue; processed
  rows land on `ok`/`failed`/`skipped`.
- Repeated-failure circuit breaker (raw SQL, no need to wait for real
  failures): insert 3 `failed` rows into `async_jobs` for one fact
  (`queue='fact_send_back'`, `dedupe_key='fact_send_back:<id>'`), then hit
  `POST /admin/taxonomy-health/actions/bulk-send-back` with
  `{"scope":"all_stale"}` — that fact must not appear in `jobs`, and the
  response's `repeatedFailureCount` must be ≥ 1.

## 6. Idempotency

- Re-running migration `0093`'s `ADD COLUMN IF NOT EXISTS` a second time is a
  no-op.
- Re-running any of the three bulk-backfill routes (`backfill-images`,
  `backfill-pexels`, `backfill-ai-memes`) against a fact whose job is still
  in-flight dedupes onto the existing job (`deduped: true` in the response),
  never double-enqueues.

## What's deliberately NOT shipped

- **`enqueueJob` transaction-atomicity hardening.** The enqueue-side status
  write (`facts.ai_meme_backfill_status` / `facts.pexels_status`) and the
  `enqueueJob` call are sequential, not wrapped in a shared transaction — a
  crash between the two, or a late-enqueue race against the handler's
  terminal-marker write, can leave a status marker orphaned at `pending` (the
  underlying image/meme data is never affected, only the status column can go
  stale). Deliberately deferred by David (2026-07-25) to a separate plan,
  `docs/plans/PLAN_ASYNC_QUEUE_HARDENING.md` — not built in this PR.
- **No `repeated_failure` `TaxonomyHealthSkipReason`.** An earlier plan
  revision considered rejecting a `scope:selected` retry on a 3-strike fact
  with a dedicated skip reason — dropped because it would make the streak
  permanently unclearable. `scope:selected` always attempts the send-back
  normally; discoverability is the row-level `repeatedFailure` flag instead.
- **`factActivation.ts`'s reparenting `HAS_ACTIVE_VARIANTS` guard is
  untouched** — a differently-motivated structural invariant (don't strand a
  fact's own children by reparenting it), unrelated to the metadata-inheritance
  bug this PR fixes. Shares the error-code name with the retired
  `sendFactBackToReview` guard, not the reasoning.
- **`scripts/backfill-pexels-images.mjs` deleted**, not migrated — a third,
  undocumented standalone script duplicating `pexelsClient.ts`'s pipeline with
  its own hand-rolled logic; unreferenced anywhere in the repo.

## Delete me

Transient — delete once Replit has run the checklist. The
[`PR256_VARIANT_INDEPENDENCE_UAT.md`](./PR256_VARIANT_INDEPENDENCE_UAT.md)
sibling is the durable half.
