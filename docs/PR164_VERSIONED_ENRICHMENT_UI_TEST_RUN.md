# PR164 — Stale-Fact Refresh PR2 (Send-back UI, Version History, Candidate Editing) · Engineering Test Run

> **Audience:** Replit (automated technical safety net).
> **Scope:** the full PR2 slice — refresh-aware enrichment guards, the shared
> override-layer module, send-back + version-history endpoints, candidate
> editing endpoints, and the Facts/Moderation UI. See "Deliberately not
> shipped" before flagging anything as missing.
> **Companion:** `docs/PR164_VERSIONED_ENRICHMENT_UI_UAT.md` (David's in-app pass).

---

## 1. Setup

1. Check out the PR branch (`claude/pr1-section-8-tz0z1o`), `pnpm install`.
2. No new migrations in this PR (schema is PR1's 0078). Sanity:

   ```bash
   pnpm --filter @workspace/db run migrate     # expect: 79 already up-to-date
   pnpm --filter @workspace/db run check-snapshots
   ```

## 2. Typecheck + suites

```bash
pnpm typecheck
# expect: clean (api-server also runs check:cycles + check:no-console)

pnpm --filter @workspace/api-server test
# expect: 523 tests, 0 fail

pnpm --filter overhype-me exec vitest run
# expect: 683 tests, 0 fail
```

New/extended suites (run individually from `artifacts/api-server/` with
`BCRYPT_SALT_ROUNDS=4 node --import tsx/esm --test <file>` if you want them isolated):

| File | Covers | Count |
|---|---|---|
| `src/__tests__/enrichmentVersioning.refresh.test.ts` | PR1 core + the NEW guard tests: resolved cycles never poison live re-enrich (rejected refresh, promoted refresh, first-time approval); the in-flight race (generic job skips everything, candidate job owns the cycle); abandoned staging facts still skip paid work | 20 |
| `src/__tests__/routes.sendBackToReview.test.ts` | send-back endpoint contract (incl. a REAL concurrent-transaction unique-violation race returning the winner's ids) + metadata-only enrichment-versions GET | 7 |
| `src/__tests__/routes.candidateEnrichmentEditing.test.ts` | the four candidate endpoints: resolved shape, PUT/DELETE/PATCH semantics, guards at every lifecycle stage, `facts.*` byte-identical across all candidate writes, zero history rows, hashtag pinning, candidate-edit-survives-promotion | 9 |
| `overhype-me src/components/admin/useFactEnrichmentEditing.test.tsx` | candidate target hits only candidate URLs / own draft namespace / no polling / no `/enrich` / server error surfaced + fact-mode regressions | 8 |
| `overhype-me src/__tests__/{SendBackToReviewModal,FactEnrichmentVersionHistory,RefreshReviewBadge}.test.tsx` | modal checkbox default OFF + clearOverrides passthrough; history label mapping + empty state; badge | 6 |

## 3. Behavior checks worth spot-verifying by hand (SQL/API)

1. **Send-back + isolation.** POST `/api/admin/facts/<live-id>/send-back-to-review` →
   `{reviewId, candidateVersionId, versionNo}`. Confirm: fact row unchanged except
   `enrichment_status='pending'`; one `candidate` row in `fact_enrichment_versions`
   with `created_by` = the acting admin; one `prep_pending` review with
   `candidate_version_id` set and `submitted_by_id` NULL.
2. **Candidate editing never touches the live fact.** With the cycle at
   `production_review`, PUT `/api/admin/reviews/<id>/candidate-overrides`
   `{"path":"/overhypeFit","value":"questionable"}`. Diff the fact row before/after:
   `enrichment`, `enrichment_ai_derived`, `enrichment_overrides`, projections,
   `last_processed_signature` all byte-identical; the version row carries the edit;
   `enrichment_override_history` gained ZERO rows.
3. **Write freeze vs candidate path.** While in-flight: PUT
   `/api/admin/facts/<id>/enrichment-overrides` → 409 `REFRESH_IN_REVIEW`;
   the candidate PUT above → 200.
4. **Promote carries the edit.** Approve the review (waive renders) → `facts.enrichment`
   + `facts.enrichment_overrides` carry the candidate edit; projection columns re-synced;
   prior active archived as `superseded`.
5. **Guard fix (the latent bug).** Take any long-approved first-time fact
   (its review is `production_approved`), POST `/api/admin/facts/<id>/enrich` →
   the job actually classifies and the pill resolves to `ok` (before this PR it
   silently no-opped and stuck on "classifying…").
6. **Version history is metadata-only.** GET `/api/admin/facts/<id>/enrichment-versions`
   → no `enrichment*` jsonb keys anywhere in `versions[]`.

## 4. Known gotchas

- The `webhookHandlers.integration.test.ts` fix in this PR is test-infra: it
  previously depended on a shard-mate exporting dummy `STRIPE_*_TEST` env vars.
  On Replit (real secrets present) it always passed; the fix just removes the
  ordering dependency. Don't flag it as a Stripe behavior change.
- Refresh review rows have `submitted_by_id = NULL` by design.
- `fact_enrichment_versions.signature` and `facts.last_processed_signature`
  stay null until PR3. Not a bug.
- Enrichment test fixtures need ≥3 `suggestedHashtags` or `resolveEnrichment`
  falls back to the raw baseline (looks like a dropped override; isn't).

## 5. Deliberately NOT shipped in PR2

- Per-version override history (`version_id` on `enrichment_override_history`)
  — the version row + promote-time snapshot are the audit.
- "Re-run classification" at moderation Step 2 — removed on purpose (it was
  already non-functional for review-backed facts and could only strand the
  status pill). Re-classification: Facts page for live facts, Retry Prep for
  prep-failed, reject + re-send for refresh candidates.
- Refresh-specific rejection-reason enum value (copy-only mitigation for now).
- `ProcessingSignature` / staleness / Taxonomy Health card → **PR3**; bulk
  re-process → **PR4**.
