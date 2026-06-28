# PR147 — Exclude subject/app name from suggested hashtags — Test Run (Replit)

Engineering / automated checklist. In-app click-through: `PR147_HASHTAG_EXCLUSIONS_UAT.md`.

## What this PR does

Stops the enrichment classifier from ever suggesting the **subject placeholder
name** ("alex") or the **app's own name** ("overhype" / "overhypeme") as hashtags.
Combines a prompt nudge (probabilistic) with a deterministic post-filter
(guaranteed) plus a re-run when filtering drops below the schema minimum of 3.

**Forward-looking only.** This changes how *new* enrichments (and explicit
re-runs) produce hashtags. It does **not** retroactively clean facts already in
the database — that backfill is a separate follow-up PR.

## Where the change lives

- `artifacts/api-server/src/lib/factEnrichmentConfig.ts` — hashtag rules in
  `FACT_ENRICHMENT_SYSTEM_DEFAULT` now exclude the subject name + app name.
- `artifacts/api-server/src/lib/factEnrichment.ts` —
  - `stripDeniedHashtags(tags)` (exported): drops normalized matches of
    `CANONICAL_SUBJECT_NAMES` + `["overhype","overhypeme"]`.
  - `enrichFactWithModel` applies it to the parsed output **before** validation
    (both the first attempt and the corrective retry).
  - `buildGenericCorrective` now names the excluded terms.

## Commands

```bash
pnpm --filter @workspace/api-server typecheck     # tsc -b + cycles + no-console

# Unit + orchestration tests (the new ones):
#   src/__tests__/factEnrichment.test.ts
#     describe "stripDeniedHashtags"
#       - removes the subject name and the app name in any casing/punctuation, keeps real tags
#       - is a no-op when nothing is denied
#     describe "enrichFactWithModel — orchestration"
#       - strips subject-name / app-name hashtags without a retry when enough real tags remain
#       - re-runs the model when stripping denied hashtags drops below the minimum of 3
pnpm --filter @workspace/api-server test          # full sharded suite
```

Local results at authoring time: `factEnrichment.test.ts` **30 pass / 0 fail**
(4 new); `redundantMechanism.test.ts` + `factEnrichmentRepair.test.ts` **27 pass**
(prompt edit is additive — substring assertions still hold); typecheck clean.

## DB / schema checks

- **No migration, no schema change, no data change** in this PR. It only alters
  in-process enrichment behavior.
- To confirm the behavior against the model, re-run enrichment on a fact whose
  text mentions the subject (e.g. an "Alex …" rendered fact) and confirm the
  resulting `suggestedHashtags` contain neither `alex` nor `overhype`.

## Gotchas

- The filter runs **inside** `enrichFactWithModel`, so it applies on first
  classification and on any admin "re-run classification". It does **not** touch
  already-stored enrichments or already-attached hashtag rows.
- `CLASSIFICATION_PROMPT_VERSION` is intentionally **not** bumped — bumping would
  flag every existing fact as stale in Taxonomy Health. Existing data is handled
  by the separate backfill PR.

## Deliberately not shipped

- No backfill of existing facts (separate follow-up PR).
- No change to admins manually adding hashtags in the EnrichmentEditor (a manual
  add is intentional; the denylist targets *AI suggestions*).
