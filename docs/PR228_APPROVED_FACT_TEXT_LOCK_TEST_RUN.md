# PR228 — Approved Fact Text Lock · TEST_RUN

Checklist for Replit (the technical safety net), run post-merge against the
live workspace. Replit owns the DB connection — no `DATABASE_URL` / test-DB
env is set anywhere in this doc. The
[`PR228_APPROVED_FACT_TEXT_LOCK_UAT.md`](./PR228_APPROVED_FACT_TEXT_LOCK_UAT.md)
sibling is the durable half.

Pre-merge gates (install, typecheck, codegen drift) are assumed green;
spot-check only if something below fails.

**No test suites in this checklist, deliberately.** This PR's feature is
covered by `factTextEditProtection.test.ts`, `confirmedFactTextEdit.test.ts`,
`routes.admin.test.ts`, `routes.adminFactsEnrichment.test.ts`,
`routes.reviews.test.ts`, and `enrichmentVersioning.refresh.test.ts`
(api-server, all run through `run-test.sh`), plus the frontend's
`ApprovedFactTextEditModal.test.tsx`, `patchFactDraft.test.ts`, and
`useDraftForm.test.tsx` — all of which already ran and passed in CI on this
exact code. Re-running them here would verify nothing new. Everything below
is what CI genuinely cannot see: the state of the live database and the live
app.

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

## Repo-health gates (post-merge state — run always)

- `pnpm --filter @workspace/db validate-snapshots` — expected: passes (matches
  CI's `build.yml`).
- `pnpm --filter @workspace/db check-snapshots` — expected: passes.
  `0089_fact_text_edit_history` is real DDL (a new table) generated without a
  snapshot file — confirm it's listed in `SNAPSHOT_EXEMPT_TAGS` (added by a
  later follow-up commit, not this PR's own diff).
- `node scripts/check-docs-accuracy.mjs` — expected: clean.
- Other allow-list entries this PR added: `lib/api-zod/src/factTextEdit.ts`
  registered in the codegen allowlist (`lib/api-spec/patch-generated.mjs`).

## Live checks (read-only; run always)

1. Migration `0089_fact_text_edit_history` applied — confirm:
   - table `fact_text_edit_history` exists with columns `id` (bigserial PK),
     `fact_id` (FK → facts, ON DELETE CASCADE), `old_text`, `new_text`,
     `reason`, `performed_by` (FK → users, **ON DELETE SET NULL**),
     `created_at`.
   - index `IDX_fteh_fact_created` on `(fact_id, created_at DESC)`.
   - index `idx_pending_reviews_approved_fact` on
     `pending_reviews(approved_fact_id)`.
   - `0089_fact_text_edit_history` present in `meta/_journal.json`, reported
     `applied` by the migrate runner.
2. Re-running migration `0089`: a second `migrate` **skips it** via the
   content-hash tracker — confirm skipped, not re-applied, no changes. (The
   migration's own SQL is `CREATE TABLE/INDEX IF NOT EXISTS`, so it would be
   idempotent even if re-run — but the tracker should skip it outright rather
   than re-running the SQL.) No backfill shipped with this migration.
3. Manual API spot-checks against a **live** fact id (`$F`), with `$SID` an
   admin session cookie. Steps 3.1, 3.3, and 3.5 are rejection probes —
   nothing is written on their expected path. Steps 3.2 and 3.4 are real
   writes; each has a capture-before/restore-after step called out inline.
   1. Text change, no confirmation → `409` `TEXT_EDIT_REQUIRES_CONFIRMATION`,
      body has `impact` (currentStoredText, normalizedProposedText,
      expectedOldTextHash, affectedVariantCount,
      persistedMemeCount/liveMemeCount, refreshInFlight).
   2. Confirm the edit using the hash from step 3.1's response —
      `confirmTextEdit:{phrase:"CHANGE APPROVED FACT TEXT", reason:"<≥10
      chars>", expectedOldTextHash:"<from 3.1>"}` → `200`; one new row in
      `fact_text_edit_history`; `facts.last_processed_signature` for `$F` is
      now null; Taxonomy Health lists `$F` as `stale_for_reprocess`. **Real
      write — restore immediately after**: issue a second confirmed PATCH
      through the same route, `text` set back to the value captured in
      3.1's `impact.currentStoredText`, `expectedOldTextHash` taken from this
      step's own response. Confirm the restore PATCH itself returns `200`.
   3. Wrong `expectedOldTextHash` → `409` `TEXT_EDIT_STALE_BASELINE`, nothing
      written.
   4. Score-only PATCH (no `text`) on `$F` — note the current score value
      first → `200`, no confirmation, no audit row. **Real write — restore
      the original score afterward** with the same PATCH route.
   5. A root with an active child variant review → `409`
      `DEPENDENT_VARIANT_IN_PROGRESS`, no write.
   6. `GET /admin/facts/$F/text-edit-history` → newest-first entries;
      `actor:null` renders as "deleted admin" in the UI when `performed_by`
      was nulled. Read-only.
4. Timing-dependent, run if convenient — the two-transaction
   approval-concurrency ordering (edit-wins vs. approval-wins) is covered by
   design plus the service tests; a deterministic concurrent-transaction
   harness is a CI/manual follow-up, not something this checklist can
   automate. On a **staging** fact, start its production approval, re-word
   the fact's text via PATCH before the approval transaction commits, then
   let the approval complete. Expected: approval fails with
   `FACT_TEXT_CHANGED_DURING_APPROVAL` and the fact stays inactive — nothing
   is written on this expected path.

## What's deliberately NOT shipped

- No change to fact **creation** paths (submit / staging insert / import / seed).
- No auto-reject of an in-flight refresh, no meme-image regeneration, no second-admin
  sign-off, no artificial delay (all listed deferred in the plan).
- No `docs/plans` file lands on main.

## Delete me

Transient — delete once Replit has run the checklist. The
[`PR228_APPROVED_FACT_TEXT_LOCK_UAT.md`](./PR228_APPROVED_FACT_TEXT_LOCK_UAT.md)
sibling is the durable half.
