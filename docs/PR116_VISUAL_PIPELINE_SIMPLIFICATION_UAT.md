# Visual-pipeline simplification (PR #116) — user acceptance testing

Paired with **`docs/PR116_VISUAL_PIPELINE_SIMPLIFICATION_TEST_RUN.md`** (the
automated checklist). Click-through test for David.

## What you're verifying

The admin pipeline now tells **one story** instead of two competing "what will the
image look like" previews:

**① Meaning** (taxonomy + cultural references + semantic entities) → **② Optional
art-direction** (visual strategy override) → **③ The real compiled prompt**
(Runtime Compiled Prompt Preview).

The old enrichment-time "Visual Preview" panel (which showed a sample prompt that
never actually rendered, and blocked approval) is **gone**. Approval now runs a
quick **renderability check** using the *real* render pipeline. The "Stale Visual
Plan" card in Taxonomy Health is also gone.

**Nothing to switch on.** It's live by default.

## 1. The editor is simpler — one prompt surface

1. Open an enriched fact (admin **Facts** page) or a pending review
   (**Moderation**).
2. Confirm the enrichment editor shows **taxonomy + cultural references + semantic
   entities + Visual Strategy Override** — and **no "Visual Preview" panel** and
   **no "Regenerate preview" button**.
3. Confirm a short line points you to the **Runtime Compiled Prompt Preview** as
   the place to see the actual prompt. There should be **no "example prompt"**
   wording anywhere.
4. Open the **Runtime Compiled Prompt Preview**, Generate, and confirm it's the
   single "what the image will be" surface. Change render mode / style / sample
   name and confirm the prompt updates. Add/adjust a **Visual Strategy Override**,
   save, regenerate the preview, and confirm it reflects the override.

## 2. Approving a normal fact (renderability preflight)

1. On a pending review with valid enrichment, click **Approve** (or **Approve as
   variant**).
2. Expect a brief **spinner** — approval now runs a render check using the real
   pipeline (neutral test subject "Alex Jordan", not David).
3. Expect approval to **succeed** and the fact to reach its normal approved state.

## 3. Approving an un-renderable fact is blocked (content)

1. Find/craft a fact whose enrichment can't produce a coherent human image-to-image
   meme (the planner rates it `poor`).
2. Approve → expect a **clear, content-specific block** ("This fact doesn't render
   coherently as an image-to-image meme of a human subject … edit the fact or its
   enrichment …"). The review stays **pending/unchanged**.

## 4. A failed render check ≠ a bad fact

1. Simulate a transient failure (e.g. provider/network blip or timeout).
2. Approve → expect a **"Render check failed; please retry"** style message
   (HTTP 503), **not** "this fact is invalid." The review stays unchanged; retry
   should succeed once the provider is healthy.

## 5. Taxonomy Health no longer mentions visual plans

1. Open **Taxonomy Health**.
2. Confirm there is **no "Stale visual plan" card** and **no "Regenerate Visual
   Plan" action**. Enrichment validity/currency cards remain.

## 6. Retired config is gone

1. In admin config, confirm **`fact_visual_preview_system` is absent** (it's
   deleted on boot and no longer seeded). Restart and confirm it stays gone.

## Regression smoke table

| Surface | Action | Expect |
|---|---|---|
| Facts / Moderation | open enriched fact | taxonomy + override; **no** Visual Preview panel / regenerate button |
| Runtime Prompt Preview | Generate, tune settings, add override | single prompt surface; reflects settings + override |
| Moderation | approve normal fact | spinner → success |
| Moderation | approve un-renderable fact | **400**, content-specific block, review unchanged |
| Moderation | approve during a transient failure | **503** "retry", review unchanged |
| Taxonomy Health | open | no Stale-visual-plan card / Regenerate-Visual-Plan action |
| Admin config | inspect | `fact_visual_preview_system` absent after restart |

## Known non-bugs / notes

- The approval check validates the **canonical image-to-image path** (the primary,
  hardest mode). It does not separately validate every style or the t2i fallback —
  the error copy doesn't claim it does.
- Old facts may still have a `visualPromptPreview` blob sitting in stored JSON;
  it's **ignored** everywhere and disappears the next time the fact is saved. No
  migration is run.
- This PR does not change cultural-reference / semantic-entity prompt behavior
  (that's the separate #115).

## Bug report template

```
Where: <Facts / Moderation / Taxonomy Health / Runtime Prompt Preview>
Action: <…>
Expected (per this doc): …
Saw: …
If approval: HTTP status + message shown: …
```
