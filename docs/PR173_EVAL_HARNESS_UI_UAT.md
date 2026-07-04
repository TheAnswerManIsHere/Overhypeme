# PR173 — Eval harness UI · UAT (click-through)

> **For David.** This is the in-app acceptance test for the **whole eval
> harness** — the backend (#170) plus this UI (#173). Companion engineering
> checklist: `docs/PR173_EVAL_HARNESS_UI_TEST_RUN.md`.
>
> **What this feature is:** a way to tell whether a pipeline change actually
> moved render quality, instead of eyeballing one meme and guessing.
>
> - **Rate any render** right on its tile — a 1–5 score, a *failure attribution*
>   (Concept / Compiler / Image model / None), and an optional note.
> - **Golden set** — mark a handful of stable facts "golden" so every eval run
>   re-renders exactly those, giving you a fixed yardstick.
> - **Eval runs** — from `/admin/eval`, one click renders the golden set under
>   the *current* pipeline. Change something, run it again, and the dashboard
>   shows a **run-vs-run diff** (avg-rating delta + failure-tag shifts).
>
> **Prereq:** starting an eval run spends real image-model budget and needs a
> live OpenAI/fal key configured. If renders never complete, check the
> environment first — it's not the UI.

---

## Where to go

- **Rate a render:** Admin → Moderation → open a review → **Step 2 · Visual
  review** → any test-render tile (the rating control sits under the tile's
  diagnostics).
- **Mark a fact golden:** Admin → **Facts** → find a fact → the **Mark golden**
  button in its status row.
- **Eval dashboard:** Admin → **Eval** (new left-nav item, flask icon) →
  `/admin/eval`.

## The happy path

| # | Do this | Expect |
|---|---------|--------|
| 1 | On a Step-2 render tile, click a rating number **1–5**. | The chosen number and everything below it highlight. It **saves immediately** (no Save button) — reload and it persists. |
| 2 | Click a **Failure** chip (Concept / Compiler / Image model / None). | The chip highlights and saves. Hover any chip for its meaning (Concept = idea/staging wrong; Compiler = concept good but compiled prompt lost it; Image model = prompt good but execution failed; None = rated, no dominant failure). |
| 3 | Click the **same** rating number (or chip) again. | It **clears** back to unrated/untagged, and saves the clear. Rating and failure-tag are independent — clearing one leaves the other. |
| 4 | Type in the **note** field and click away. | The note saves on blur. |
| 5 | Go to Admin → **Facts**, click **Mark golden** on a stable active fact. | The button flips to **Golden** (highlighted). Do this for 2–3 facts. |
| 6 | Open **`/admin/eval`**. | The **Golden set** section lists exactly the facts you marked. **Start eval run** is enabled. |
| 7 | Click **Start eval run**. | A **cost confirmation** appears ("This renders every golden fact (N)… real image-model spend. Continue?") with an optional run-label field. |
| 8 | Add a label (e.g. `baseline`) and confirm **Start run**. | An **active-run panel** appears with a running tally ("*k* of *N* rendered") and a **chip per item** that goes spinner → green check (or amber for skipped/failed) — live, no refresh. |
| 9 | Wait for the run to finish, then rate a couple of its rendered attempts in the **Runs** section. | Same rating control as the tile; saves against the eval run. |
| 10 | Change something in the pipeline, run a **second** eval run, rate it. | A **Run #N vs #N-1** panel appears: an **avg-rating delta** (green ↑ / red ↓) plus any failure-tag shifts. |

## Edge cases to spot-check

| Scenario | Expect |
|----------|--------|
| No golden facts yet | `/admin/eval` shows "No golden facts yet…" and **Start eval run is disabled** — you can't run an empty set. |
| An **inactive** fact that is *not* golden | Its **Mark golden** button is disabled with a tooltip ("Only active facts can be added to the golden set"). |
| An inactive fact that **is** already golden | Still removable — the button is live and un-marks it. |
| A golden i2i scenario with **no reference asset** available | That item comes back **skipped/blocked** (amber), the run keeps going, and the tally shows it under "blocked" — this is the per-item guard working, not a run failure. |
| A save fails (network blip) | The control **reverts** to its prior value and shows a small amber error under it — it never silently pretends it saved. |
| Ratings on ordinary moderation renders (not part of a run) | Shown under **Opportunistic ratings**, explicitly labeled **"directional only"** and kept *out* of any run's average — only eval-run rows are a true A/B. |

## What should NOT happen

- Starting an eval run must **never** happen without the cost confirmation.
- The active-run status must **never** require a page refresh to update, and must
  **never** impose a timeout — a long run keeps showing live per-item status.
- A per-item skip/fail must **never** fail the whole run or get collapsed into a
  green check — skipped/blocked is its own amber state.
- An eval render must **never** show up in the moderation Step-2 grid (eval
  attempts carry no `review_id`).
- Rating a tile must **never** require a Save click or block the moderation flow.

## Regression smoke (existing behavior unchanged)

- The Step-2 render tiles, diagnostics, Advanced Options, and approve/reject flow
  are unchanged — the rating control is purely additive under each tile.
- The Facts admin page is unchanged except for the added **Mark golden** button
  in the status row.

## Known non-bugs / limitations

- **Opportunistic ratings are directional only.** A rating on a one-off
  moderation render isn't a controlled comparison — only eval runs render the
  same golden set under one pipeline, so only they roll up into a run average.
- **Eval spend is real and deliberate.** The confirmation exists because a run
  renders the whole golden set for real; that's the point of the yardstick.
- **Run diff needs ≥2 runs.** The comparison panel only appears once a second run
  exists.

## Bug report template

```
Fact / review / run id:
Where: (tile rating / failure chip / note / golden toggle / start run / active-run status / run diff / opportunistic)
Expected:
Actual:
Screenshot:
```
