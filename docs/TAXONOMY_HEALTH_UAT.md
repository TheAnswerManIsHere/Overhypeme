# Taxonomy Health Workbench — UAT

In-app click-through for the admin Taxonomy Health workbench.
Engineering test plan:
[`TAXONOMY_HEALTH_TEST_RUN.md`](./TAXONOMY_HEALTH_TEST_RUN.md).

The workbench answers, in one page: which approved facts are healthy, which are
missing pieces, which are stale (prompt-version bumps), and which need an admin
touch. Actions queue the right fix (re-enrich, regenerate the visual plan,
repair projection columns) and now **show you exactly what's happening** —
a spinner while a job runs, then a ✓ / ✗ / skipped indicator when it finishes.

This pass fixed the cards (Healthy no longer shows everything; every card's
number matches the rows it lists), added a plain-language explanation when you
select a card, and renamed the misleading "Preview" wording to **Visual Plan**.

---

## Setup

1. Sign in as admin.
2. Open `/admin/taxonomy-health` (sidebar: **Taxonomy Health**, under Engines).

You'll see a row of summary cards, a description panel for the selected card,
and a table beneath. The default filter is **Missing enrichment** — click any
card to change it.

---

## 1. Cards count what they list (the big fix)

1. Click **Healthy**. The table should show **only** healthy facts — NOT the
   whole corpus. The number on the card should equal the number of rows listed.
2. Click **Semantic entities need review**. The card number should equal the
   number of rows shown. This card now includes the informational
   "capitalization hint" facts (text mentions a capitalization-sensitive term
   like *sun* / *earth* but no entities were extracted).
3. Spot-check a couple of other cards (e.g. **Missing enrichment**, **Stale
   enrichment**): card number == rows listed.

> Note: cards are **filters, not exclusive buckets**. A healthy fact can also
> show under an informational card (e.g. a capitalization hint). The panel says
> this in the description block.

## 2. The selected-card explanation

Click any card. Above the search box you should see a panel that explains:
- **what the issue means**,
- **what to do** about it, and
- for each action button: **what it does**, whether it's **safe to repeat**, and
  whether it **costs model calls** or could **overwrite** data.

E.g. **Projection mismatch** says Repair is *safe to repeat, no model calls*;
**Missing enrichment** says Re-enrich *costs model calls and protects
admin-edited facts*.

## 3. Single-fact Re-enrich — spinner → done

1. Click **Missing enrichment** (or **Stale enrichment**).
2. On a row that is NOT admin-edited, click **Re-enrich**.
3. You should see a **spinner ("Working…")** on that row while the queued job
   runs, then a **✓ Done** when the async worker finishes (give it up to ~30–60s;
   the panel polls every couple seconds). Other rows stay clickable meanwhile.
4. A **last-action banner** appears up top summarizing the run (e.g.
   "Re-enrich: 1 done"). You can dismiss it with the ✕.

## 4. Admin-edited protection

1. Open a fact, edit its enrichment (so `enrichedBy` becomes admin / it has
   admin review notes), save.
2. Back on the panel, click **Re-enrich** on that row.
3. It should show **"Skipped — admin-edited"** (not an error, not a silent
   no-op). The banner reports `skipped`. Admin-edited facts are protected by
   default — edit them in the fact editor instead of re-classifying from here.

## 5. Regenerate Visual Plan — spinner → done

1. Click **Missing visual plan** (formerly "Missing preview").
2. On a row, click **Regenerate Visual Plan** (formerly the bare "Preview"
   button). Spinner → ✓ Done when the `preview` job finishes.
3. Verify in the editor: click the fact id (deep-links to
   `/admin/facts?focus=<id>`). The section is titled **Visual Plan** and its
   button reads **Regenerate visual plan**.

## 6. Repair projections — instant, safe

1. Click **Projection mismatch**.
2. Click the row-level **Repair**. No scary modal — it's a fast, idempotent DB
   write with no model calls. You should see **✓ Done** immediately.
3. Refresh — the row drops out of the **Projection mismatch** filter.

## 7. Bulk actions — per-fact progress + a running tally

1. Click a card with several affected rows (e.g. **Stale enrichment**).
2. Click the bulk action (e.g. **Re-enrich stale facts**). A confirm dialog
   warns you with the **affected count** and that it **costs model calls / takes
   time** (Repair has no such modal — it's safe).
3. Accept. Now watch **two things at once**:
   - **In the list:** every affected fact lights up its own indicator —
     **Queued… → Working… → ✓ Done** (or ✗ Failed / Skipped) — fact by fact,
     exactly as if you'd clicked Re-enrich on each one. Rows stay put while the
     run is in flight so you can see each one finish.
   - **Up top:** a live banner counts the total — e.g. **"Re-enrich: 7 of 25
     done · 5 in progress · 1 failed"** — updated every time a fact completes.
4. When the whole run finishes, the list refreshes once: facts that were fixed
   drop out of the filter, and the banner shows the final tally (dismiss with ✕).
5. If the panel hits its polling ceiling before a long queue drains, the
   stragglers show **"Still running"** — NOT failed. Refresh later to confirm.

## 8. Selected filter is preserved

After any action completes and the panel auto-refreshes, you should stay on the
**same card** you were working — fixed rows simply drop out of that filtered list.

---

## Known non-bugs

- A completed job does **not** always mean the health issue is resolved (e.g. a
  re-enrich can still land in "Needs admin review"). The refreshed list is the
  source of truth; the banner only reports operation progress.
- Cards overlap by design. A fact can appear under more than one (Healthy +
  an informational hint, "Needs admin review" + a specific sub-reason).
- The panel polls async-jobs every ~2s with a ceiling (~90s). Long bulk runs
  keep draining in the background even after the panel says "still running".
- Single-row Re-enrich never overwrites admin-edited enrichment from this panel.
  There's no force toggle here — use the fact editor for admin-curated facts.
- Summary counts are computed per page load; fine at current corpus size.

## Bug report template

```
Filter:    <which summary card you clicked>
Action:    <which bulk or row-level action you triggered>
Expected:  <e.g. "Healthy count == rows listed", "spinner then ✓">
Got:       <what you saw — screenshot of the row indicator + banner>
Fact id:   <if a specific fact is misbehaving>
Health badges shown: <from the table>
```
