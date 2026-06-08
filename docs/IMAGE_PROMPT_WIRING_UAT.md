# New image-prompt engine → bench + meme generator — user acceptance testing

Paired with **`docs/IMAGE_PROMPT_WIRING_TEST_RUN.md`** (the automated checklist).
This is the click-through test for David.

## What you're verifying

The prompt engine we just built now powers two more places, replacing the old
scene-prompt generator:

1. The **t2i / i2i engine test bench** at `/admin/engines`.
2. The **generic "AI background" generator** in the meme builder (the
   non-upload "Generic" tab).

Reference-photo uploads already used the new engine — that's unchanged. The
video builder is intentionally untouched (it gets rebuilt on Nano Banana later).

## Heads-up before you start

- Both surfaces now **require the fact to be enriched**. If you pick a fact with
  no/invalid enrichment, you'll get a clear "enrich this fact first" message
  instead of an image — that's expected, not a bug.
- Generic AI backgrounds now render with **Nano Banana 2** in **whatever aspect
  ratio you've selected for the meme** (landscape / square / portrait), not a
  fixed square.

## 1. Engine bench — text-to-image

1. Go to `/admin/engines`, pick a **text-to-image** image engine, open its test
   bench.
2. Pick an **enriched** fact and a gender; optionally pick a look style and an
   aspect ratio.
3. Expect the **Image prompt** box to auto-fill with a cinematic Nano-Banana
   scene built from the fact's taxonomy (not the old "Cinematic man scene" stub).
4. Click **Test** → an image renders in the chosen aspect ratio.
5. Change the aspect ratio and re-assemble → the prompt regenerates; render
   matches the new ratio.

## 2. Engine bench — image-to-image

1. Same page, pick an **image-to-image** engine.
2. Optionally paste a sample image URL in the source field (leave blank to use
   the bundled test face).
3. Assemble → the prompt is built in `human_identity_i2i` mode against that exact
   image; **Test** renders a stylized version that preserves the face.

## 3. Engine bench — unenriched fact (negative)

1. Pick a fact that hasn't been enriched.
2. Expect: **"This fact has no valid enrichment — enrich it before using the
   image bench."** No prompt, no render.

## 4. Meme builder — generic AI background

1. Open the meme builder for an **enriched** fact, choose an aspect ratio
   (landscape / square / portrait), go to the **AI** image mode, **Generic** tab.
2. Click **Generate**.
3. Watch the progress: it should move through live status (generating → done),
   then the new background lands in the gallery in your chosen aspect ratio.
4. Try an **unenriched** fact → you should see "This fact isn't enriched yet —
   it can't be turned into an AI background", and no progress bar starts.

## 5. Confirm the untouched paths still work

- **Reference Photo** tab (upload your face) → still generates via the
  confirm-modal flow exactly as before.
- **Video builder** → unchanged.

## Regression smoke

| Area | Expectation |
| --- | --- |
| t2i bench assemble + Test | Nano-Banana prompt + render in chosen ratio |
| i2i bench assemble + Test | face-preserving render against the sample/bundled image |
| Bench, unenriched fact | clear "enrich first" message, no render |
| Generic AI background, enriched | live status → image in gallery, chosen ratio |
| Generic AI background, unenriched | inline refusal, no progress bar |
| Reference-photo upload | unchanged (confirm modal → render) |
| Video builder | unchanged |

## Known non-bug limitations

- Generic generation makes one image per click (as before), now via the async
  pipeline — it may take a little longer than the old FLUX path because it runs
  the planner + a 2K Nano Banana render.
- If the engine judges the fact a poor fit for a staged image, the generic flow
  shows a "can't be staged" message with a suggested fallback instead of a
  forced bad image.
- The video builder and reference-upload "stylings" still use the old engine
  under the hood until the video rebuild — no visible change there yet.

## Bug report template

```
Surface: (engine bench t2i / engine bench i2i / generic AI background)
Fact ID + text:
Aspect ratio selected:
What I clicked:
What I expected:
What happened (screenshot + any on-screen error):
```
