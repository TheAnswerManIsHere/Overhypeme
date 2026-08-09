# PR #256 — Variant independence — TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Verifies that `facts.parent_id` is kinship + show/hide only —
a variant no longer inherits, is blocked by, or is denied its own metadata
(enrichment, images, AI generation) — and that the new async-queue/
circuit-breaker machinery behind the bulk-backfill routes is sound.
[`PR256_VARIANT_INDEPENDENCE_UAT.md`](./PR256_VARIANT_INDEPENDENCE_UAT.md) is
the durable sibling.

**Replit owns the DB connection** — no `DATABASE_URL` / test-DB env is set
anywhere in this doc.

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails.

No test suites here — this PR's suites (named for awareness below) already
ran and passed in CI on this exact code. Everything below is what CI cannot
see: the live database and the live app. Nothing below writes a row except
applying the migration itself (the deploy action, not a test probe).

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes
  (matches CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes. New
  `SNAPSHOT_EXEMPT_TAGS` entry this PR added:
  `0093_facts_ai_meme_backfill_status` (mirrors the `0075_facts_pexels_status`
  precedent) — confirm the entry is present.
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Other allow-list entries this PR added: `check:no-console` allowlist entry
  `cliJobPoller.ts:78` (intentional, see the file's own comment).

## Live checks (read-only, except item 1)

1. **Apply migration `0093`** — `pnpm --filter @workspace/db run migrate`
   (`ALTER TABLE "facts" ADD COLUMN IF NOT EXISTS "ai_meme_backfill_status"
   varchar(16)`). Confirm `facts.ai_meme_backfill_status` exists:
   `varchar(16)`, nullable, no default, every existing row reads `NULL`.
2. Re-running `migrate`: a second run is **skipped by the content-hash
   tracker** — the already-applied migration isn't re-executed, so this
   confirms tracking rather than SQL-level idempotency — confirm skipped, no
   changes.
3. `SELECT dedupe_key FROM async_jobs WHERE queue = 'fact_ai_meme_backfill'
   LIMIT 5;` — once the worker has processed a few jobs, dedupe keys follow
   `fact_ai_meme_backfill:fact:<id>`.
4. `SELECT ai_meme_backfill_status, count(*) FROM facts GROUP BY 1;` — new
   rows are `NULL` until they pass through the bulk-backfill queue; processed
   rows land on `ok`/`failed`/`skipped`.

Tests covering this PR (ran and passed in CI on the merged code — named for
awareness, not re-run here):

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
