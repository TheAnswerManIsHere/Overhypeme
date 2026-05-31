# Taxonomy Health Workbench — UAT

In-app click-through for the new admin Taxonomy Health workbench.
Engineering test plan:
[`TAXONOMY_HEALTH_TEST_RUN.md`](./TAXONOMY_HEALTH_TEST_RUN.md).

The workbench answers, in one page: which approved facts are healthy,
which are missing pieces, which are stale (due to prompt-version bumps),
and which need an admin touch. Bulk actions queue the right fix
(re-enrich, regenerate preview, repair projection columns).

---

## Setup

1. Sign in as admin.
2. Open `/admin/taxonomy-health` (sidebar entry: **Taxonomy Health**,
   under Engines).

You should see a row of summary cards plus a table beneath. The first
view filters to **Missing enrichment** by default — change the filter by
clicking any card.

---

## 1. Summary cards reflect the corpus

Cards show:
- Total facts
- Healthy
- Missing enrichment
- Invalid enrichment
- Needs admin review
- Missing preview
- Stale preview
- Stale enrichment (version)
- Projection mismatch
- Cultural refs need research
- Semantic entities need review
- Low confidence

Click each card → the table re-queries with that filter applied.

## 2. Missing enrichment

1. Click **Missing enrichment**.
2. If any facts appear, click **Backfill missing enrichment** in the
   action row. A confirm dialog appears.
3. Accept. The server enqueues a `fact_enrichment_backfill` job per
   fact. Response shows `{ queued, skipped, failed }`.
4. Wait ~30–60s for the async-jobs worker to process them.
5. Click **Refresh**. The missing-enrichment count should drop; the
   facts should reappear under **Healthy** or **Needs admin review**.

## 3. Re-enrich stale facts

1. Click **Stale enrichment**.
2. Click **Re-enrich stale facts** (confirms first).
3. The default skips facts where `enrichedBy === "admin"` or
   `adminReviewNotes` is non-empty. Server response lists `skipped`.
4. After workers run, refresh — stale count drops, and the rows now
   carry the current `CLASSIFICATION_PROMPT_VERSION` in their summary.

To force-overwrite admin-edited rows, the row-level **Re-enrich** action
in the table (per fact) prompts for confirmation.

## 4. Missing / stale visual preview

1. Click **Missing preview**.
2. Click **Regenerate missing previews**. Confirm.
3. Each fact gets a `preview` job (queue name `preview`, payload
   `{targetType: "fact", targetId}`).
4. After workers run, refresh — the previews appear in the fact editor
   (you can verify by clicking the fact id in the table, which deep-links
   to `/admin/facts?focus=<id>`).

Same flow for **Stale preview** (`previewPromptVersion` doesn't match
current `PREVIEW_PROMPT_VERSION`).

## 5. Projection mismatch — sync repair

1. Click **Projection mismatch**.
2. For a single row, click the row-level **Repair** button. Runs
   synchronously and shows the before/after columns in the action message
   panel.
3. For a bulk repair with ≤25 facts, click **Repair projection
   mismatches** — runs synchronously and returns full outcomes.
4. For a larger set, the same button enqueues `projection_repair` jobs;
   response includes `{mode: "async", queued}`.

Pure DB UPDATE under the hood — derives the right column values from
the existing `enrichment` JSONB. Safe to run repeatedly.

## 6. Cultural references needing research

1. Click **Cultural refs need research**.
2. Click the fact id to open it in the moderation/facts editor.
3. The per-row **Research Reference** button (built in the previous PR)
   does the research. Apply, save, return to the workbench.
4. Refresh — the row should drop from the **Cultural refs need
   research** filter.

There's no bulk action for reference research in this PR — the
per-fact flow keeps cost predictable.

## 7. Semantic entities needing review

1. Click **Semantic entities need review**.
2. Open a fact whose semantic entity has `sentence_initial_ambiguous` or
   `requiresAdminReview=true`. (Example: any fact starting with "Earth …".)
3. Confirm the in-editor warning matches the table.
4. Edit, save, return to the workbench.
5. Refresh — the row should drop from the filter.

## 8. Regression fixture confidence check

The fixture suite (offline, no LLM) runs as part of CI/local tests:

```bash
node --import tsx/esm --test \
  artifacts/api-server/src/__tests__/taxonomyRegressionFixtures.test.ts
# Expected: # tests >= 50 # pass all
```

Every canonical fact (Earth / earth / Shark Week / Victoria's Secret /
pi / teachers / baby / Yardi / water / system / coffee / magnifying
glass) is locked at the SHAPE level — archetype + subtype + key
referent words, with explicit must-avoid keywords for the ones the
spec called out (Shark Week must NOT be David-swimming-with-sharks;
lowercase earth must NOT be the planet).

If the enrichment prompts or validators drift in a way that breaks one
of these, the test names tell you which fact and which assertion.

---

## Known non-bugs

- Summary counts are computed on every page load. With ~10k facts this
  is fine; if the corpus grows much larger, the page may slow down. A
  persisted snapshot table is the planned follow-up if that happens.
- The page filter is single-select. "Needs admin review" overlaps with
  several other filters by design; pick the one you care about.
- The action message panel shows the raw JSON response so you can spot
  surprises (e.g. an unexpectedly large `skipped` count). It's intended
  as a developer-friendly readout, not polished UI.
- Bulk **re-enrich stale** skips admin-edited rows automatically. To
  force-overwrite, use the row-level Re-enrich (with the appropriate
  confirm dialog).
- No retention on `async_jobs` for these new queues — the existing
  retention sweeps continue to apply.

## Bug report template

```
Filter:    <which summary card you clicked>
Action:    <which bulk or row-level action you triggered>
Expected:  <e.g. "all 5 missing-enrichment rows queued">
Got:       <screenshot of action panel + table state>
Fact id:   <if a specific fact is misbehaving>
Health badges shown: <from the table>
```
