# MBFO-4 — User acceptance testing (in-app)

You're the end user here. MBFO-4 is **the session where video memes
become real**. The wizard now has a complete video flow: select a
photo of yourself, the server stylizes it (PuLID), pauses at a
checkpoint where you approve the still, then generates a captioned
video (Veo 3.1 Lite by default) and lands you on the meme detail
page. The image flow's no-face behavior also changes — instead of
silently falling through to a generic image, the wizard now surfaces
the choice explicitly.

Everything is still gated behind `VITE_MBFO_WIZARD=1`, so this UAT
splits into two halves:

1. **Flag-OFF half (production path):** prove the production meme-
   build flow is unchanged.
2. **Flag-ON half (preview path):** walk the new video flow end-to-end,
   tier gating, source modes, checkpoint behavior, advanced options,
   engine selector (admin), and the image-mode no-face modal.

The automated test side is in [`MBFO_4_TEST_RUN.md`](./MBFO_4_TEST_RUN.md)
and is owned by Replit AI; that runs in parallel and you don't need
to read it.

If anything in this UAT fails, write down which section + row, what
you saw vs. what you expected, and a screenshot if it's visual. The
bug-report template is at the bottom.

---

## What MBFO-4 explicitly does NOT ship

These are deferred to MBFO-5 / future and are NOT expected to work
yet. If you hit them, that's expected — not a failure:

- **Stripe Embedded Checkout** inside the upgrade modal. The Video
  card on Step 1 (for free/anonymous) still routes to `/pricing`.
- **`MemeStudio` (Phase-3 builder) removal.** Stays in place behind
  `VITE_MBFO_WIZARD=0`. Cleanup at the end of MBFO-5.
- **Engine selector for non-admin LEGEND users.** The selector is
  gated by the `engine_experiments` feature flag; only admins have
  it by default in MBFO-4. (Per-user flag grants will come.)
- **Frame-level NSFW classification on the finished video.** Only
  the stylized still is classified pre-Stage 2.
- **Style content tuning.** The 19 look styles use prompt suffixes
  mirrored from the legacy server config. Motion preset prompts are
  whatever the old `video_styles` table had. They'll get a content
  pass later.
- **Live preview of motion.** Step 2 video shows a static still + a
  settings summary line. The actual video only renders on Make my
  meme — generating a motion preview on every change would cost real
  fal credits.

Anything outside that list — anything that exists on `main` today —
should still work exactly as it did before MBFO-4. The flag-OFF half
of this UAT exists to confirm that.

---

## Setup

1. Pull the latest of the MBFO branch (work is on
   `claude/start-mbfo-4-z87MQ`).
2. Boot the dev app in Replit. The session-start hook brings up the
   test DB. **MBFO-4 ships two new migrations** (`0056_steady_mongoose.sql`
   for DDL, `0057_mbfo4_seed_engines_and_look_styles.sql` for the
   engine + look-style seed). If the test DB was up before the pull,
   the migrate command will apply both cleanly.
3. Viewer states you'll need:
   - **Unregistered** — log out and visit in a private window.
   - **Registered (free)** — any free-tier account.
   - **Legendary** — a paid-tier account with budget remaining.
   - **Admin** (optional, for the engine selector tests in section D7).
4. You'll need:
   - At least one root fact (no parent fact) on hand.
   - For video tests: be ready to spend ~$0.45 of fal credits per
     successful end-to-end run (PuLID ~$0.03 + Veo Lite ~$0.40 +
     auto-subtitle ~$0.02). Have a few credits buffered if you want
     to test multiple paths.
   - A JPG selfie under 15 MB.
   - For the no-face test: a JPG with no face (landscape, object).
5. Devices:
   - A **real mobile phone** (iOS + Android if possible). The
     God Mode loading takeover and the checkpoint screen are designed
     mobile-first.
   - Desktop browser (Chrome preferred for DevTools).

---

# PART ONE — flag OFF (production regression)

These rows run against the **default** dev build, no env var set.

## Section A — production path is unchanged

### A1. Fact detail renders normally

Open a fact's detail page. Variant card, vote buttons, comments, and
inline meme grid render exactly as they did before MBFO-4. The
"Make a meme" CTA still mounts the **Phase-3** `MemeStudio` (not the
wizard).

### A2. MemeStudio image flow still works

Inside the legacy MemeStudio:

- Pick a stock photo, save → permalink generated, meme renders. Row
  in DB has `artifact_type = 'image'` (the new default; pre-existing
  rows also auto-default to `'image'`).
- Self-upload a photo, save → same.

### A3. MemeStudio video tab still works

The legacy MemeStudio video tab (Phase-3 path) uses the synchronous
`/api/videos/generate` endpoint. This endpoint was **refactored**
to use the new engines table + interpreter, but the wire shape is
unchanged.

Run a sample generation:

- The motion prompt comes from the chosen style row (now in
  `motion_presets`, table-renamed from `video_styles`).
- The video URL is returned synchronously, just like before.
- No regression in the legacy admin tooling.

### A4. Profile photo upload still works

Open Edit Profile → upload a new photo. Goes through the same Layer 1
(Arachnid) + Layer 2 (fal NSFW classifier) moderation pipeline.

### A5. Image-mode AI generation in the legacy MemeStudio

This is unaffected — MBFO-4 only changed the **wizard** image flow's
no-face behavior. The legacy MemeStudio AI tab still uses its prior
silent fallback path.

---

# PART TWO — flag ON (preview path)

Set `VITE_MBFO_WIZARD=1` in your dev environment and reload.

## Section B — Step 1 video card gating

### B1. Anonymous user

Step 1 shows two cards: `Image` and `Video`. The video card has a
LEGEND tag (no 👑 emoji). Tap it → the `UnifiedUpgradeModal` opens.

Pass criteria:

- Modal opens (does not navigate to Step 2)
- Modal CTA points at `/pricing`

### B2. Free user

Same as anonymous — video card opens the upgrade modal.

### B3. Legendary user

Tapping `Video` advances to Step 2 video.

---

## Section C — Step 2 video shell

### C1. Initial mount

The wizard shell renders with:

- Top bar: thin progress fill, back arrow (top-left), close X
  (top-right). No step counter text.
- Locked video preview area at the top. Empty state shows a frame
  outline matching the chosen aspect ratio (default **portrait** —
  9:16) and a settings summary line: "Style: Cinematic • Motion:
  Natural slow push • Length: 6s • Quality: 720p" (default values
  for Veo 3.1 Lite).
- Source picker section: heading "Upload a photo of yourself" with
  subtitle "We need to see a face — that's how Overhype works."
- "Advanced options" trigger button.
- Bottom-anchored primary action: "Make my meme" (disabled until a
  source is selected).

### C2. No `Adjust the text` sheet

There is **no** `Adjust the text` sheet on Step 2 video. Captions
are burned in by auto-subtitle with brand-locked styling — no user
overlay. If you see an `Adjust the text` button on video Step 2,
that's a bug.

### C3. Aspect ratio toggle

In the advanced sheet (Section D below), confirm the aspect ratio
toggle still offers landscape / square / portrait. Switching updates
the locked preview frame.

---

## Section D — Step 2 video advanced sheet

Tap `Advanced options`. The sheet opens from the bottom (Vaul
drawer). It contains, in order:

### D1. Source mode

Three radio options:

- **Stylize then video** (default) — full pipeline
- **Use photo as-is** — skips PuLID; feeds your raw upload to the
  video model
- **Use existing AI image** — pick a previously generated styled
  image from your library

Pass criterion: switching between them updates the source picker UI
(see D2).

### D2. Source picker affordance per mode

- `Stylize then video` — picker shows your library + Upload tab.
- `Use photo as-is` — same picker; you upload any photo with your face.
- `Use existing AI image` — picker switches to AI stylings tab. You
  pick from prior PuLID renders.

### D3. Look style picker

A scrollable list of the 19 look styles. Default selection is
**Cinematic**. Tapping a different style sets it as **uncommitted**.

The **Apply** button is:

- Disabled when no change is pending
- Enabled when uncommitted change exists
- On tap, commits the change and updates the preview summary line

### D4. Motion preset picker

A list of motion presets from the renamed `motion_presets` table
(formerly `video_styles`). There is **no Apply button** on motion
presets — selecting one just updates state. Motion only takes
effect on Make my meme.

### D5. Length picker

Radios populated from the selected engine's `allowedDurationsSec`.
For Veo 3.1 Lite (default): `4s` / `6s` (default) / `8s`.

### D6. Quality picker

Radios populated from the selected engine's `allowedResolutions`.
For Veo 3.1 Lite (default): `720p` only. Switch to Veo Fast or
Seedance to see additional options (admin only — see D7).

### D7. Engine mode UI (engine-aware)

For Veo Lite, Veo Fast, Kling v3, Seedance: **no mode UI appears**.

For Grok Imagine (admin / engine_experiments flag): radios appear
for `Normal` / `Fun` / `Custom`. Selecting `Custom` reveals a
multiline text input "Add your own direction" — appended to the
motion prompt at generation time.

### D8. Engine selector (admin / engine_experiments flag)

If you have the `engine_experiments` feature flag (admins do by
default), an engine selector appears at the bottom of the sheet.
Five video engines visible: Veo 3.1 Lite (default), Veo 3.1 Fast,
Kling v3 Standard, Seedance 2.0 Fast, Grok Imagine.

Pass criteria:

- Without the flag: the selector is NOT rendered (you only see the
  default engine; no choice)
- Switching engines updates length, quality, aspect ratio, and mode
  options to match the new engine
- Switching from Grok back to Veo Lite hides the mode UI

### D9. Source mode "Use existing AI image" + style override

With `Use existing AI image` selected:

- The look style selector is shown as **read-only** ("Inherited from
  source")
- A toggle "Use a different style for the video" reveals a fresh
  look-style picker
- This second picker has its own Apply button

---

## Section E — Default video path (stylize-then-video)

This is the cost path. Each successful run is ~$0.45 of fal credits.

### E1. Happy path end-to-end

1. As Legendary, Step 1 → Video → Step 2.
2. Confirm defaults: Cinematic / 6s / 720p / portrait / Veo 3.1 Lite.
3. Upload a selfie.
4. Tap `Make my meme`.
5. **God Mode takeover** mounts. Watch for:
   - Stage 1 copy: *"Forging your likeness. Standard mortals take
     days. This takes seconds."*
   - Progress bar advances 0→25% smoothly over ~18s
6. **Checkpoint screen** mounts. Verify:
   - The stylized still is rendered prominently inside the aspect frame
   - Header: "Your starting frame is ready"
   - Subhead: "This is the still we'll animate. Approve to continue."
   - Cost preview line: "Next up: video generation (~$X.XX of your
     $Y.YY remaining budget)"
   - Buttons: `Animate it` (primary), `Try a different style`
     (secondary), `Regenerate this style` (secondary), `Cancel`
     (tertiary)
   - No countdown / auto-proceed timer
7. Tap `Animate it`. Bar continues 25→100% over ~45s.
   - Stage 2 copy: *"Setting you in motion. Welcome to legend."*
8. On completion, the page navigates to `/m/<slug>`. The video plays
   with captions:
   - White text (`#ffffff`)
   - Orange highlight on the **current word** (`#ff6b35`)
   - 3px black stroke
   - Captions positioned at the bottom (y_offset 75)
   - Word-by-word animation (one word at a time)

### E2. Database checks

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, artifact_type, video_object_path, look_style_id, \
          motion_preset_id, video_job_id \
   FROM memes WHERE permalink_slug='<slug>';"
```

Pass criterion:
- `artifact_type = 'video'`
- `video_object_path` is a `/objects/...` path
- `look_style_id = 'cinematic'`
- `motion_preset_id` matches what you picked (or null if you didn't)
- `video_job_id` references a real row in `video_jobs`

### E3. Cost ledger has three rows

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT endpoint_id, job_type, computed_cost_usd \
   FROM user_generation_costs \
   WHERE job_reference_id LIKE 'videoJob_<jobId>_%' \
   ORDER BY created_at;"
```

Pass criterion: three rows, one each for PuLID, Veo Lite endpoint,
auto-subtitle endpoint. Sum approximates $0.45.

---

## Section F — Checkpoint variants

### F1. Try a different style

1. Run E1 up through the checkpoint.
2. Tap `Try a different style`.
3. An inline picker showing **all 19 look styles** appears.
4. Pick a different style → confirm → bar resets to 0% → Stage 1
   re-runs with the new style → checkpoint reappears with the new
   stylized still.
5. After two attempts, the screen shows a counter: `Stylizations: 2`.

### F2. Regenerate this style

1. Run E1 up through the checkpoint.
2. Tap `Regenerate this style`.
3. Stage 1 re-runs with the **same** style. New still appears at the
   checkpoint.
4. Costs accumulate: each PuLID call spends from your budget.

### F3. 5-attempt warning

If you do 5 regenerations on the same job, a soft warning appears:
"Each stylization spends from your budget. Want to try a different
photo instead?"

There is no hard cap. The budget gate is the only floor.

### F4. Cancel from checkpoint

1. Run E1 up through the checkpoint.
2. Tap `Cancel`.
3. A toast appears: "Your stylized image was saved to your library."
4. You're returned to Step 2 with your original source picker state.
5. Open the AI you tab (or your library) — the stylized still is
   there as a library entry. You can use it for an image meme OR
   re-enter video mode with source mode = `Use existing AI image`
   and pick this still.

### F5. Back arrow during Stage 1

1. Run E1, before Stage 1 completes (bar is between 0% and 25%):
   tap the top-bar back arrow or close X.
2. A soft confirm modal asks "Cancel? Your stylized image will be
   saved to your library."
3. On confirm, the job cancels. The partial work (if any
   stylized still exists yet) auto-promotes.

### F6. Back arrow during Stage 2

1. Run E1 past the checkpoint, during Stage 2 (bar between 25% and
   100%).
2. The top-bar controls are **disabled** with tooltip "Generation in
   progress" — you can't cancel.
3. Wait it out — the pipeline runs to completion.

---

## Section G — Source mode variants

### G1. Use photo as-is

1. Step 2 video, advanced sheet, source mode = `Use photo as-is`.
2. Upload any photo (face or not).
3. Tap `Make my meme`.
4. Stage 1 is **skipped entirely**. The God Mode takeover shows the
   source still for ~1s, then bar starts at 0% and runs through
   Stage 2 only.
5. Final video animates the photo as-is.
6. Cost ledger has only 2 rows (Veo + auto-subtitle, no PuLID).

### G2. Use existing AI image

1. Source mode = `Use existing AI image`. Source picker shows AI
   stylings tab.
2. Pick a prior PuLID render from your library.
3. Tap `Make my meme`.
4. Stage 1 is skipped. Bar runs 0→100% through Stage 2 only.
5. The video animates the pre-stylized still.

### G3. Use existing AI image + style override

1. As G2, but flip the "Use a different style for the video" toggle.
2. Pick a new look style.
3. Tap `Make my meme`.
4. Stage 1 **runs again** with the new style on the same source still.
5. Checkpoint appears with the newly stylized still.

---

## Section H — Failure / edge paths

### H1. No-face checkpoint

1. Upload a photo with no face (landscape, object).
2. Tap `Make my meme`.
3. Stage 1 runs (PuLID returns no_face after ~18s).
4. The God Mode takeover mounts a **no-face screen** (NOT a silent
   fallback). Header: "We couldn't find a face." Subhead explains
   the platform expects a face.
5. Two CTAs:
   - `Try a different photo` → cancels job, returns to Step 2
   - `Use an abstract image based on the fact` → proceeds with an
     abstract still (the user's photo for now, until the
     text-to-image follow-up lands)

### H2. NSFW upload

1. Upload an NSFW image.
2. The Layer 2 NSFW classifier rejects it at upload time (this is
   pre-MBFO-4 behavior; no change). Locked NSFW reject copy appears
   in the source picker.

### H3. NSFW stylized still

(Hard to trigger deliberately without a tame-input-NSFW-output
collision — likely to only happen in edge cases.)

If it does: the God Mode takeover terminates at `failed` with copy:
"This image can't be used. It violates our content policy." Stage 2
never runs. The PuLID cost is in the ledger; no Veo cost.

### H4. Budget exhausted (pre-flight block)

1. As a test user near zero budget, attempt `Make my meme`.
2. POST returns 429 BUDGET_EXCEEDED before any compute spend.
3. The client shows the **VideoBudgetExceededScreen**:
   - Copy: *"You've out-legended your monthly budget. Your reset is
     {date}. Come back wilder."*
   - Single button: `Go back` (returns to Step 2)
   - No retry button

### H5. Budget exhausted mid-pipeline (rare)

If pricing changes between pre-flight and Stage 2: phase = `failed`
with `errorCode = "budget_exceeded"`. Same locked screen as H4. No
refund for Stage 1 cost.

### H6. Service unavailable

If fal.ai returns 503 or times out:

- The God Mode takeover ends in `failed` state
- Copy: *"Our servers couldn't handle that much legend at once.
  They need a minute. Try again shortly."*
- Two buttons: `Try again` / `Use my photo as-is`

---

## Section I — Image-mode no-face explicit choice

This is the small but meaningful image-mode change in MBFO-4.

### I1. Modal appears for no-face

1. Step 1 → Image → Step 2 image.
2. Source = `AI you` → upload a faceless photo → tap `Create`.
3. PuLID runs, returns no_face.
4. The PuLID loading takeover unmounts and a **NoFaceFallbackModal**
   opens on top of Step 2 image.

Pass criteria:

- Title: "We couldn't find a face"
- Description: "Overhype is built around your face — but we
  couldn't see one in this photo. Try a different shot, or we can
  render an abstract image based on the fact instead."
- Two buttons stacked vertically:
  - `Try a different photo` (primary)
  - `Use an abstract image` (secondary)
- Dismissing the modal (X / ESC / backdrop tap) cancels the job
  (treated as "try a different photo")

### I2. Try a different photo

1. From the modal, tap `Try a different photo`.
2. The job is DELETEd server-side, the source picker resets.

### I3. Use abstract image

1. From the modal, tap `Use an abstract image`.
2. The button label changes to "Generating…" briefly.
3. The PuLID loading takeover re-mounts (server is running the
   text-to-image fallback).
4. On completion, the abstract still appears as your selected
   source. Tap `Make my meme` to save the meme.

### I4. Image meme persistence

Save a meme generated through the no-face fallback. Confirm in DB:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, image_transform, artifact_type FROM memes \
   WHERE permalink_slug='<slug>';"
```

Pass criterion: `image_transform = 'pulid_fallback_text'`,
`artifact_type = 'image'`.

---

## Section J — Copy + UX polish

### J1. Upload affordance copy

Anywhere a user uploads a photo for the wizard image or video flow,
the copy should reflect the face-required nature:

- `SelfUploadZone` empty state: "Drop a photo of yourself" /
  "We need to see a face. JPEG, PNG, or WebP. Up to 15 MB."
- Video source picker: "Upload a photo of yourself" / "We need to
  see a face — that's how Overhype works."

If you find copy that still says generic things like "Upload a
photo" without face context, flag it as a polish followup.

### J2. Mobile drag-to-reposition

(MBFO-3 functionality, regression-only.) On a real touch device:

1. Open Step 2 image, pick a source.
2. Drag inside the preview rect to reposition the framing offset.
3. The drag should not cause page scroll (`touch-action: none` on
   the preview rect).

The video preview rect (Step 2 video) is currently static — no
drag gesture. The framing-offset state still exists in wizardStorage
but isn't exposed in the video flow UI for v1.

### J3. Settings summary line updates live

In Step 2 video, the settings summary line under the locked preview
should update as you change:

- Look style (after `Apply`)
- Motion preset
- Length
- Quality

The line is read-only — you can't edit it directly.

---

## Bug report template

```
Section: <e.g. E1>
Row: <e.g. checkpoint cost preview>
Viewer: <unregistered / free / legendary / admin>
Device: <iPhone 15 Pro / Android Pixel 8 / Chrome desktop>
Browser: <Chrome 140 / Safari 18>

Expected: <what the row says should happen>
Actual:   <what actually happened>

Steps to reproduce:
1.
2.
3.

Screenshot / video: <link or attachment>

Console output (DevTools → Console):
<paste any red errors>

Network: <any failed requests in DevTools → Network>
```
