# Enrichment staleness (version discrepancy) — automated test run

Engineering-side checklist for Replit. The in-app walkthrough is in
[`ENRICHMENT_STALENESS_UAT.md`](./ENRICHMENT_STALENESS_UAT.md).

Surfaces whether a fact's stored enrichment was produced under the CURRENT
taxonomy/visual-plan versions, on two surfaces:

1. **Per-fact "Visual Taxonomy Enrichment" panel** — a staleness badge: green
   "up to date (taxonomy vN)" when current, or an amber "stale — re-enrich"
   block listing each stored→current discrepancy.
2. **Taxonomy Health page** — a "Current versions" line in the header
   (taxonomy / visual plan / strategy) and a compact stored→current diff in the
   Health cell of every version-stale row.

Both read the same shared comparison (`computeEnrichmentVersionStatus` /
`enrichmentVersionStatusFromStored` in `@workspace/api-zod`), which agrees with
the server `evaluateFactTaxonomyHealth` decision. No schema/migration changes —
the version fields (`classificationPromptVersion`,
`visualPromptPreview.previewPromptVersion`) already live on the enrichment blob;
this only surfaces them. The current versions come from the existing constants
(`CLASSIFICATION_PROMPT_VERSION`, `PREVIEW_PROMPT_VERSION`,
`VISUAL_STRATEGY_VERSION`).

---

## TL;DR

```bash
pnpm run typecheck:libs
( cd artifacts/api-server  && tsc -p tsconfig.json --noEmit )   # exits 0
( cd artifacts/overhype-me && tsc -p tsconfig.json --noEmit )   # exits 0

# Shared version-staleness helper (pure).
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/enrichmentVersionStatus.test.ts

# Existing taxonomy-health evaluator still green.
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/taxonomyHealth.evaluate.test.ts

# Per-fact staleness badge.
cd artifacts/overhype-me && pnpm exec vitest run \
  src/__tests__/EnrichmentStalenessBadge.test.tsx
```

---

## A — Helper unit tests

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/enrichmentVersionStatus.test.ts
```

Pass criterion: **7 tests pass, 0 fail.** Covers: older classification version
⇒ `enrichmentStale`; missing (null) version ⇒ stale + `missing`; both current ⇒
not stale; old visual-plan version ⇒ `previewStale` only; reading versions out
of an enrichment blob; absent enrichment ⇒ fully stale; defaulting to the live
constants.

## B — Per-fact badge

```bash
cd artifacts/overhype-me && pnpm exec vitest run \
  src/__tests__/EnrichmentStalenessBadge.test.tsx
```

Pass criterion: **4 tests pass, 0 fail.** Up-to-date shows the green badge;
an old version shows the amber stale badge with the stored→current diff; an
unversioned blob is labelled stale ("unversioned → vN"); the visual-plan line is
omitted when no plan exists.

## C — Evaluator non-regression

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/taxonomyHealth.evaluate.test.ts
```

Pass criterion: all pass — the evaluator is unchanged; the new helper only reads
the same fields it already compares.

## D — Manual DB spot-check (Replit)

Pick a fact whose stored `enrichment.classificationPromptVersion` differs from
the current `CLASSIFICATION_PROMPT_VERSION` (or is absent), then:

- Open it in the Facts admin page → the "Visual Taxonomy Enrichment" panel shows
  the amber stale badge with `stored → current`.
- Open the Taxonomy Health page → the "Stale enrichment" card lists it, and its
  Health cell shows the same `enrich vX→vY` diff; the header shows the current
  versions.

## What this explicitly does NOT ship

- **No new version-bump tooling.** Bumping a version is still editing the
  constant in `@workspace/api-zod`; this just makes the resulting discrepancy
  visible.
- **No new staleness detection logic.** The evaluator already flagged
  `stale_enrichment_version`; this surfaces the concrete versions behind that
  flag. The shared helper mirrors the evaluator's decision rather than
  introducing a second one.
- **No auto-re-enrich.** Re-enrich is still the existing manual / bulk action on
  the Taxonomy Health page.
