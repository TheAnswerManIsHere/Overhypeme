# Moderation render-review tools — user acceptance testing

**PR:** #139 · **Companion:** [`PR139_MODERATION_RENDER_REVIEW_TEST_RUN.md`](./PR139_MODERATION_RENDER_REVIEW_TEST_RUN.md)

## What you're verifying

During a fact's **production review** (the second moderation gate), you can now do
two new things before approving it:

1. **See the actual Pexels stock images** that were pulled in for the fact.
2. **Render the fact as an AI background** through the real image pipeline — the
   same engine path the Engines test bed uses — driven by the compiled prompt you
   already preview.

These are review-only checks. Renders are **throwaway verification**: they never
touch the fact's real production images, and they do **not** create a public meme.
The image shown is the **raw AI background** (no fact-text overlay) — it confirms
the pipeline works and the scene reads, not the final caption layout.

## Where to look

**Admin → Moderation → a review in the `production_review` stage** (provisionally
approve a submission and let enrichment finish to reach it). The two new panels sit
just below the enrichment editor:

- **Runtime Compiled Prompt Preview** → expand it → new **"Render AI background"** button.
- **"Pexels images pulled"** → a new collapsible panel.

## Setup: get a fact into production review

1. Submit a fact (or pick a pending one), open it in **Admin → Moderation**.
2. Click **Provisional Approve — Start Prep**. Watch prep run (enrichment + Pexels).
3. When it reaches **Production review**, the two new panels appear.

## 1. See the Pexels images pulled in

1. Find the **"Pexels images pulled"** panel. The header shows a running count
   (e.g. `12 total · male 4 · female 4 · neutral 4`).
2. If Pexels is still seeding, it shows **"seeding…"** with a spinner and fills in
   **live** — you should **not** have to refresh.
3. Use the **male / female / neutral** tabs to switch which set you see. Each tab
   shows the search keywords used and a grid of thumbnails. Hover a thumbnail for
   the photographer credit; there's a **"Photos provided by Pexels"** link at the
   bottom.

**Expect:**
- Images appear for the genders that have them.
- If a gender genuinely has none, you see the set is empty for that tab (not an error).
- If seeding **failed**, you get an amber note saying so — and it explicitly says this
  **does not block approval** (you can still render an AI background).
- A fact whose prep hasn't created a staging fact yet shows nothing to view.

## 2. Render the fact as an AI background

1. Expand **Runtime Compiled Prompt Preview** and click **Generate runtime prompt
   preview** so you can see the compiled prompt (as today).
2. Below it, click **Render AI background**.
3. Watch the new attempt row: **Queued… → Rendering image… → Rendered**, with a
   spinner while active. Above the rows, a tally updates
   (e.g. `Rendered 1 · 0 rendering · 0 failed`).
4. When it finishes, the **raw AI background image** appears in the row, along with a
   small line showing what assumptions were used (name/pronouns · aspect · gender ·
   style · content mode · attempt #).
5. Change an assumption (e.g. aspect ratio, look style, or sample name) and click
   **Render AI background** again. A **second** row appears and tracks
   independently — both stay visible.

**Expect:**
- Each render shows its own live status; the page never times out, even for a slow
  render. You never need to refresh to see progress.
- The image is the bare AI background (no fact text on it) — that's intended.
- Closing and reopening the modal still shows your recent renders.

## 3. Text-to-image only (no source image)

1. In the preview controls, change **Subject render mode** to `human_identity_i2i`.
2. The **Render AI background** button is replaced by an amber note: moderation
   renders are **text-to-image only** because review facts have no source image.
   Switch back to `t2i_fallback` to render again.

**Expect:** you can still *preview* an i2i prompt for inspection, but you can only
*render* in t2i mode.

## 4. Blocked / failed renders read clearly

- If a fact's subject↔fact compatibility is **poor**, the render row shows **Blocked**
  (not a generic error) with the recommended fallback — distinct from a hard failure.
- If the engine errors, the row shows **Render failed** with the error text.

## 5. Renders don't pollute the fact (the important one)

1. Render the fact a couple of times during review.
2. Approve the fact (or check with Replit / the DB).

**Expect:** the fact's production AI backgrounds are **unchanged** by your moderation
renders — they were verification only. (Replit confirms `facts.ai_meme_images` is
untouched; see the test-run doc.)

## Regression smoke

| Area | Check | Expect |
|---|---|---|
| Prompt preview | Generate runtime prompt preview as before | Works unchanged |
| Enrichment editor | Tune + re-run classification | Works unchanged |
| Approve for production | Approve a prepped fact | Works unchanged; fact goes live |
| User meme generation | Generate an AI background as a normal user | Works unchanged; still saved to the fact |

## Known non-bugs / limitations

- **Raw background, not a finished meme.** No fact-text overlay is rendered — this
  validates the image pipeline, not caption layout.
- **Renders need the worker.** If the async worker/fal isn't running, a render stays
  "Rendering…"; that's the queue, not a stuck UI.
- **Render history is per-browser.** The list of recent renders is remembered locally
  per review; a different browser won't show them (the renders are still saved as
  audit rows server-side).
- **t2i-only.** Review facts have no uploaded image, so i2i rendering isn't available
  here.

## Bug report template

```
Fact / Review #:
Stage (should be production_review):
Panel (Pexels / Render):
What I did:
What I expected:
What happened:
Screenshot:
```
