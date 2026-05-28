# Phase 2 — render-time image prompt pipeline (UAT)

In-app, click-through acceptance test for the Phase 2 pipeline. Engineering
test plan: [`PHASE_2_TEST_RUN.md`](./PHASE_2_TEST_RUN.md).

The goal of this PR is to let users (and admins) generate meme backgrounds
where:

- A clear face is treated as a face (i2i, face preserved).
- A photo of a person without a usable face triggers a t2i fallback (with
  a clear warning), not a silent failure.
- A cat / dog / car / mascot / object is treated as **the protagonist** in
  the meme, preserving its recognizable visual identity, with optional
  anthropomorphic staging.
- An unclear image cleanly falls through to t2i fallback.
- The user always picks the route — no silent reroute when compatibility
  is poor.

---

## Setup

1. Sign in as a legendary user (or use admin override).
2. Open `/admin/config` → set `enable_image_prompt_v2` to `true`. Save.
3. Reload the wizard; the AI background picker now shows the new flow when
   you have a reference image selected.

If the flag is `false`, the wizard uses the legacy `/generate` route — no
visible change.

---

## 1. Clear human face

1. Wizard → AI background → reference mode → upload a clear headshot (you
   or a stock face).
2. Click **Generate**.

Expected:
- Modal opens within ~3s with title "Face detected".
- Body: "We found a clear face. We'll use this photo as the identity source."
- Two buttons: **Use this face** + **Upload a different image**.
- Click "Use this face" → modal stays open, shows "Writing the prompt…"
  then "Rendering the image…".
- Within ~30-45s, modal closes; the new background appears in the gallery
  with the face preserved + the scene matching the fact.

## 2. Person with no usable face

1. Upload a photo of you facing away from the camera, or with the face
   blurry / mostly outside the frame.
2. Click Generate.

Expected:
- Modal opens with title "Face not usable".
- Body explains the face isn't usable for likeness preservation.
- Two buttons: **Generate without face preservation** + **Upload a different image**.
- Click "Generate without…" → t2i_fallback renders with the logged-in
  user's profile gender as the protagonist guidance (or neutral if no
  profile gender is set). The generated image does NOT claim to preserve
  your face.

## 3. Cat / dog (animal subject)

1. Upload a clear photo of a cat or dog.
2. Click Generate.

Expected:
- Modal opens with title "Animal detected".
- Body: "This looks like an animal rather than a person…"
- Three buttons: **Use this animal as the protagonist** + **Generate a person instead** + **Upload a different image**.
- Click "Use this animal…" → render proceeds. The result preserves the
  animal's markings / color / shape and stages the fact around the animal
  (anthropomorphic posing allowed when the fact requires it, e.g. cat
  sitting at a desk for a teacher fact).
- The animal is NOT replaced by a human in the output.

## 4. Cat + life-stage fact

1. Upload the same cat photo.
2. Use a fact that implies childhood, e.g. "When David was born, he drove
   his mom home from the hospital."

Expected (visible in `/admin/image-prompt/attempts` for this fact):
- `subjectFactCompatibility.rating` is `"risky"` or `"poor"`.
- If user proceeds, the rendered image may use a kitten version of the cat
  while preserving recognizable markings.
- If rating is "poor", the system recommends t2i fallback rather than
  proceeding silently.

## 5. Car (vehicle / object subject)

1. Upload a clear photo of a car.
2. Try fact: "David doesn't use GPS. Roads ask him where to go."

Expected:
- Modal title "Object detected" with an "experimental" tag chip.
- Body warns some facts may not make visual sense.
- "Use this object anyway" / "Generate a person instead" / "Upload different".
- Render: the car is the protagonist; color / shape preserved. The fact
  stages on the car.

## 6. Car + poor compatibility

1. Same car upload, different fact: "David's teachers raised their hands
   when they had questions."

Expected:
- Modal still opens with object-detected message.
- After clicking "Use this object anyway", the response visible in
  `/admin/image-prompt/attempts` shows
  `subjectFactCompatibility.rating: "poor"` with a non-`"none"`
  `recommendedFallback`.
- **No silent fallback**: the render still attempts non-human i2i for the
  car. The frontend doesn't (yet) auto-route to t2i for poor compat —
  that's a future UX improvement; for now the compatibility rating is
  visible in admin and informational.

## 7. No clear subject

1. Upload a landscape / interior / abstract photo with no dominant subject.
2. Click Generate.

Expected:
- Modal title "No clear subject".
- Two buttons: **Generate without this image** + **Upload a different image**.
- "Generate without…" → t2i_fallback render using fallback subject gender.

## 8. Multiple subjects

1. Upload a photo with two or more people / objects of comparable size.
2. Click Generate.

Expected:
- Modal title "Multiple subjects" with a warning that the result may not
  preserve the one you wanted.
- Options to use anyway / generate without / upload different.

## 9. Cache hit (repeated render of the same image)

1. After step 1 (clear human face), click Generate again with the same
   reference image but a different fact.
2. Watch the modal open phase.

Expected:
- Modal opens significantly faster (no fal detector call) — the analyzer
  cache hit on the upload's sha256 returns the same analysis instantly.
- `classificationMethod` in `/admin/image-prompt/attempts` is unchanged
  (still `fal_detector` from the original analysis); no second fal call.

## 10. Admin observability

Open `/admin` and visit:
- `GET /admin/image-prompt/attempts?factId=<id>` → JSON listing of recent
  attempts for that fact. Each row carries the full visualPlan +
  compiledPrompt + subjectFactCompatibility + sourceImageAnalysis snapshot
  used at render time.
- `POST /admin/image-prompt/preview` → fire a synchronous preview without
  going through the queue. Useful for prompt-engineering iteration.
- `POST /admin/source-image/analyze` → debug the analyzer on any image
  URL (admin bypasses the ownership gate).

---

## Known non-bugs (not in this PR)

- The legacy `/memes/ai/:factId/generate` route is still live; flipping
  `enable_image_prompt_v2` to `false` returns the wizard to the original
  flow. Cutover (deleting the flag + legacy route) is a follow-up PR after
  a week of clean prod UAT.
- The pre-generate modal only opens in **reference mode** with an upload
  selected. Generic (no reference) generation still uses the legacy path —
  there's no need for the analyzer when there's no upload.
- "Use this object anyway" with a poor-compat rating still proceeds with
  the render. A future UX iteration could surface the rating in the modal
  itself and recommend the user pick t2i_fallback. For now the rating is
  only visible to admins.
- The workbench classifier admin UI isn't fancied up yet — use
  `POST /admin/source-image/analyze` to test detector swaps.
- No batch backfill: the analyzer cache populates lazily on first
  analyze-source call per upload.

## Bug report template

```
Step: <which UAT step above>
Subject: <subjectKind the modal showed, or "no modal opened">
Expected: <what should have happened>
Got: <what actually happened>
attempt ID (from /admin/image-prompt/attempts): <id>
render job ID (from network panel): <uuid>
Screenshot: <attached>
```
