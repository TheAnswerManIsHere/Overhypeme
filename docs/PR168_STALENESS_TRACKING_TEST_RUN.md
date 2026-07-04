# PR168 — Stale-Fact Refresh PR3 (ProcessingSignature, Staleness Tracking & Taxonomy Health) · Engineering Test Run

> **Audience:** Replit (automated technical safety net).
> **Scope:** the full PR3 slice — the `ProcessingSignature` fingerprint,
> classify-time stamping, the `engine_revision` marker + audit table (migration
> 0080), the `stale_for_reprocess` Taxonomy Health lens, the atomic
> `mark-major-update` action, and the Taxonomy Health UI. See "Deliberately not
> shipped" before flagging anything as missing.
> **Companion:** `docs/PR168_STALENESS_TRACKING_UAT.md` (David's in-app pass).

---

## 1. Setup

1. Check out the PR branch (`claude/pr1-section-8-tz0z1o`), `pnpm install`.
2. **New migration `0080_engine_revision`** in this PR. Apply + verify:

   ```bash
   pnpm --filter @workspace/db run migrate        # expect: 1 applied (0080), 80 already up-to-date → 81 total
   pnpm --filter @workspace/db run check-snapshots # expect: 81 journal entries OK, snapshot chain valid
   ```

   Then confirm against the DB:
   - `admin_config` has an `engine_revision` row, `value='1'`, `data_type='integer'`, `is_public=false`.
   - table `engine_revision_bumps` exists (`old_revision`, `new_revision`, `note`, `performed_by`, `created_at`) with index `IDX_erb_created_at`.

## 2. Typecheck + suites

```bash
pnpm typecheck
# expect: clean (api-server also runs check:cycles + check:no-console)

pnpm --filter @workspace/api-server test
# expect: ~996 tests, 0 fail (4 shards)

pnpm --filter overhype-me exec vitest run
# expect: 697 tests, 0 fail
```

New/extended suites (run individually from `artifacts/api-server/` with
`BCRYPT_SALT_ROUNDS=4 pnpm exec tsx --test <file>` if you want them isolated):

| File | Covers | Count |
|---|---|---|
| `src/__tests__/taxonomyHealth.evaluate.test.ts` | `stale_for_reprocess`: null signature → `never_processed`; matching sig → not stale; engine-revision behind → `engine_revision`; code-version behind → `code_version`; `recommendedAction === send_back_to_review` (NOT `rerun_enrichment`); info severity keeps a stale-only fact overall "healthy"; **missing/invalid facts are NOT flagged (valid-only scope)** | +9 |
| `src/__tests__/taxonomyHealth.filters.test.ts` | filter/summary-count parity for `stale_for_reprocess` (count uses the same `matchesHealthFilter` as the list) | +1 |
| `src/__tests__/enrichmentVersioning.refresh.test.ts` | candidate stamps the signature captured **before** classify (a mid-classify engine bump does NOT change it); promote copies it onto `facts.last_processed_signature`; first-time staging prep stamps fresh; a direct live re-enrich never stamps | +2 |
| `src/__tests__/routes.adminTaxonomyHealth.markMajorUpdate.test.ts` | bump increments by one + audit row + `admin_config` metadata refresh; note trim / empty→null / missing→null; overlong note → 400 (no bump); **two concurrent bumps → distinct consecutive revisions with chained audit rows (no lost update)**; auth 401/403 | 5 |
| `src/__tests__/routes.adminTaxonomyHealth.actions.test.ts` | summary carries `engineRevision` + `staleForReprocess`; `stale_for_reprocess` lists valid null-sig facts, excludes missing; `refreshInReview` true for a fact with an in-flight candidate, false otherwise | +3 |
| `overhype-me src/components/admin/sendBackToReview.test.ts` | shared client: default `clearOverrides:false`, passthrough, 409 `HAS_ACTIVE_VARIANTS` / `REFRESH_ALREADY_IN_PROGRESS` shapes, network error | 6 |
| `overhype-me src/components/admin/MarkMajorUpdateModal.test.tsx` | confirm POSTs trimmed note + reports new revision; blank note → `{}`; cancel makes no request; server error surfaced | 5 |
| `overhype-me src/pages/admin/taxonomy-health.rows.test.tsx` | header renders engine revision; overlapping (`staleForReprocess` + `staleEnrichmentVersion`) row shows **Send back** and NOT Re-enrich; a `refreshInReview` row starts "in review" (no button) | 3 |

## 3. Behavior checks worth spot-verifying by hand (SQL/API)

1. **Legacy corpus reads stale.** Any valid enriched fact approved before PR3 has
   `facts.last_processed_signature = NULL`. GET
   `/api/admin/taxonomy-health/summary` → `staleForReprocess > 0` and the response
   carries `engineRevision` (=1 on a fresh DB). GET
   `/api/admin/taxonomy-health/facts?status=stale_for_reprocess` lists them; a
   `missing_enrichment` fact is NOT in that list.
2. **First-time approval stamps fresh.** Approve a brand-new fact through the
   normal flow → its `facts.last_processed_signature` equals the current signature
   (engineRevision + the four code-version constants), so it does NOT appear under
   `stale_for_reprocess`.
3. **Refresh promote stamps; direct re-enrich doesn't.** Send a live fact back
   (PR2 flow) → promote → `facts.last_processed_signature` is now the current
   signature and the fact drops off the stale list. Separately, a direct
   `/api/admin/facts/<id>/enrich` on a live fact leaves `last_processed_signature`
   untouched (refresh-first).
4. **Mark major update is atomic + audited.** POST
   `/api/admin/taxonomy-health/actions/mark-major-update` `{"note":"swap"}` →
   `{engineRevision: N+1, previousRevision: N}`. Confirm: `admin_config.engine_revision.value`
   is now `N+1` with refreshed `updated_at` / `updated_by_id`; one new
   `engine_revision_bumps` row (`old=N,new=N+1,note='swap',performed_by=<admin>`).
   A just-refreshed fact from step 3 returns to the stale list (its stored
   engineRevision is now behind).
5. **Note validation.** Empty/whitespace note → stored `NULL`; a >2000-char note
   → 400, no bump, no audit row.
6. **`engine_revision` is read RAW.** A `debug_value` override on `engine_revision`
   must NOT change staleness reads (the marker bypasses the debug overlay by
   design).

## 4. Known gotchas

- `patch-generated.mjs` gained `./processingSignature` in its api-zod barrel
  list. `codegen` (the api-server `pretest`) rewrites `lib/api-zod/src/index.ts`
  from that list, so the export MUST be there or every api-server import that
  reaches `taxonomyHealth/index.ts` fails at runtime. Not a Stripe/codegen
  behavior change — just the barrel completeness fix.
- `stale_for_reprocess` and `stale_enrichment_version` overlap heavily on the
  legacy corpus by design — orthogonal lenses (pipeline-signature vs. embedded
  prompt-version). Stale-for-reprocess rows offer only Send-back.
- Engine/model IDs are deliberately absent from the signature; a config toggle
  never flips staleness. LLM/engine swaps register via the manual bump.
- The concurrent-bump test exercises a REAL transaction race; on a busy shard it
  may log advisory-lock waits — that's the serialization working, not a failure.

## 5. Deliberately NOT shipped in PR3

- **Bulk reprocess** (fan-out send-back with per-item + aggregate async status
  via `useTaxonomyHealthActions`) → **PR4**. This PR ships only the per-fact
  Send-back from the stale list.
- Overall-status rollup for `stale_for_reprocess` — intentionally info-severity
  and NOT folded into the Healthy/attention pill (day one it would swamp the
  real attention signal; the dedicated card is the surface).
- `stale_for_reprocess` covering missing/invalid facts — deliberately valid-only
  (broken facts have their own error cards).
- Un-bump / revert of an engine revision — you bump again; the audit table is the
  history.
