# PR142 — Moderation Wizard + Multi-Scenario Test Renders — UAT (David)

In-app click-through. Engineering checklist: `PR142_MODERATION_WIZARD_TEST_RUN.md`.

## What changed, in one breath

Reviewing a fact is now a **two-step wizard** like "Submit a Fact". Step 1 is the
keep/reject decision. Step 2 shows the AI's test images across scenarios and
hides all the technical knobs behind "Advanced Options" until you need them.

## Before you start — one setup item

For the **image-to-image** scenarios to render, three reference images are
needed (you're providing them):

- `female.jpg`, `nonhuman-animal.jpg`, `nonhuman-object-vehicle.jpg` →
  `artifacts/api-server/src/assets/render-references/`

Until those exist, the **Generic (t2i)** and **Male (i2i)** tiles render normally
and the female/non-human tiles show a clear "reference not configured" message.
That's expected, not a bug. (Admin → check readiness any time via the reference
health endpoint, or just look at the tiles.)

## Walkthrough

1. **Submit a fact** (or pick a pending one). Open **Admin → Moderation → Fact
   Reviews** and open a review.
2. **Step 1 — Triage.** You should see only: the submitted text, duplicate
   likelihood/context, submitter info, and Keep / Reject. **You should NOT see**
   enrichment dropdowns, the compiled-prompt panel, or render controls here.
3. Click **Keep / Provisional Approve.** Prep (enrichment + Pexels + test
   renders) starts automatically — watch the live prep status. You do **not**
   click anything to start rendering.
4. **Step 2 — Visual review.** When prep finishes you land here automatically.
   Expect:
   - A short plain-English **AI interpretation** summary (what the AI thinks the
     fact is — archetype, subtype, key entities, any warnings). No raw JSON.
   - A **scenario grid**: Generic (t2i), Male (i2i), Female (i2i), and one
     **Non-human** tile. Each tile shows its own live status — a spinner while
     queued/rendering, then the image when done (or a clear failed/blocked/skipped
     state). A running tally sits above the grid ("Rendered 2 of 3 · …").
   - The **Non-human** tile shows as **Skipped** with a reason (it doesn't
     auto-run in this version) and a **"Run anyway"** button.
   - **Pexels** stock images are in a collapsed section *below* the grid.
5. **Tune + re-run.** Open **Advanced Options** (collapsed by default). Change an
   enrichment value or a Visual Strategy Override. The affected tiles should pick
   up a **"stale — rerun recommended"** badge (the old image stays visible). Use
   the checkboxes `[Generic] [Male] [Female] [Non-human]` + **Run selected**, or a
   tile's **Rerun**, to regenerate. Only the chosen scenarios re-render.
6. **Per-image diagnostics.** Expand **Scenario diagnostics** on a tile to see the
   exact (frozen) prompt that produced *that* image — distinct from the
   "Prompt Diagnostics" panel in Advanced Options, which recomputes under your
   current settings.
7. **Approve.** Click **Approve for Production**.
   - If a required scenario (Generic / Male / Female) is missing, still running,
     failed, or stale, you get a clear warning **naming those scenarios** and an
     **"Approve Anyway (Waive N)"** button. Nothing slips through silently.
   - With all three required scenarios freshly rendered, approval proceeds
     normally.

## Expect vs. don't-expect

| Expect | Don't expect |
| --- | --- |
| Step 1 = decision only | Enrichment/prompt panels on Step 1 |
| Renders start on Keep, no manual click | A page refresh ever needed to see status |
| Each tile its own live status + a tally | A single global spinner for the whole grid |
| Male (i2i) renders today | Female/non-human to render before you add their images |
| "Skipped" / "stale" shown as distinct states | Skipped/stale collapsed into ✓ or ✗ |
| Approval warns + lets you waive | Being silently blocked, or silently approving incomplete visuals |

## Regression smoke

| Area | Check |
| --- | --- |
| Triage | Reject (with reason) still works from Step 1 |
| Duplicates | Duplicate likelihood + matching fact still shown |
| Prep | Enrichment + Pexels still run and show live status |
| Approve | Approved fact goes live; test images are NOT attached to the live fact |
| Existing facts | Facts admin page enrichment editor still works |

## Known non-bugs (this version)

- **Non-human is manual-only** — it won't auto-fire; use "Run anyway". Automatic
  detection of a non-human subject is a later PR.
- **Female / non-human tiles say "reference not configured"** until you add the
  three images above.
- **Field tooltips / clearer field names** are PR 2.
- **Edit Fact screen** doesn't have this surface yet — PR 3.

## Bug report template

```
Screen/step: (Step 1 / Step 2 / Advanced Options / Approve)
Review id / fact:
What I did:
What I expected:
What happened (with the tile/scenario name + its status):
Screenshot:
```
