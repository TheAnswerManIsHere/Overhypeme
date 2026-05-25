# Engine Management — User acceptance testing (in-app)

You're the end user here. This UAT validates the engine management
system + the cleanup of legacy AI/engine settings from the admin
panel. You'll walk through the new `/admin/engines` page, use its
"Test" button to bypass the meme builder entirely and prove that
each engine can be called correctly, then run the wizard end-to-end
with one engine before iterating on the others.

The strategy is deliberately **one engine at a time**. Veo 3.1 Lite is
the default; get it working through the full pipeline first. Once
that's solid, switch the default to the next engine and repeat. This
way every "what broke?" question has a small, isolated diff to look at.

The automated test side is in [`ENGINE_MANAGEMENT_TEST_RUN.md`](./ENGINE_MANAGEMENT_TEST_RUN.md)
and is owned by Replit AI; that runs in parallel and you don't need to
read it.

If anything fails, write down which section + row, what you saw vs.
what you expected, and a screenshot if it's visual. Bug-report
template at the bottom.

---

## Setup

1. Pull the latest from PR #59's branch (`claude/start-mbfo-4-z87MQ`).
   This rolls up PR #51 (engine catalogue), #54–#56 (test workbench),
   #57–#58 (fal-docs param audit), and #59 (workbench polish + Nano
   Banana Pro).
2. Boot the dev app. The session-start hook brings up the test DB.
   Three migrations apply (0059 deletedAt, 0060 retire legacy keys,
   0061 retire style_suffix keys) — no manual SQL.
3. You need:
   - An **admin** login (the engine management UI is admin-gated).
   - A **Legendary** test user to run the wizard end-to-end.
   - A selfie under 15 MB (JPEG/PNG/WebP).
4. You'll burn ~$0.45 of fal credits per successful wizard run, plus
   ~$0.05–$0.30 per /test button click (depends on engine — Nano
   Banana Pro at 1K is ~$0.14, 4K is ~$0.28).

**What's new since the last UAT pass:**

- **Per-kind test benches.** The workbench used to show one
  video-shaped form (motion prompt, dialogue, duration, audio) for
  *every* engine. It now renders the controls each engine kind
  actually needs — text-to-image gets a prompt only, image-to-image
  gets a source image + transform prompt, utility gets a video URL +
  caption knobs, video is unchanged. A bench-type banner at the top of
  the panel tells you which one you're looking at. See Section D/E.
- **Two new text-to-image engines** in the catalogue: **FLUX Pro v1.1**
  (`fal-ai/flux-pro/v1.1`, production parity — this is the model the
  legacy pipeline already calls for prompt-only generation) and
  **FLUX.2 Pro** (`fal-ai/flux-2-pro`, an upgrade candidate).
  Registered side by side so you can A/B them in the bench; both are
  non-default. (Engine count is now 10: 5 video, 4 image, 1 utility.)
- **No-face fallback now generates an image.** When you upload a photo
  with no detectable face in a *video* and choose "generate an abstract
  image based on the fact," Stage 1 now produces a faceless scene still
  via text-to-image instead of animating your raw upload. See F4.
- A new image engine, **Nano Banana Pro** (`fal-ai/nano-banana-pro/edit`)
  — Google Gemini 3 Pro Image. It's the default image engine in the
  catalogue now (★ badge moved off PuLID). **However**, the production
  video pipeline's Stage 1 still hardcodes PuLID — see F3 below for
  what to expect in the `video_jobs` row.
- Every existing engine gained the params it had been missing per
  fal's live docs: `auto_fix`, `safety_tolerance`, `enhance_prompt`,
  `negative_prompt`, `seed` on the Veo engines; `end_image_url` and
  `seed` on Kling and Seedance; `video_preset` enum (plus a new
  `spicy` mode) and `seed` on Grok; `id_weight`, `true_cfg`,
  `num_images`, `enable_safety_checker` on PuLID.
- Veo Lite/Fast now send `generate_audio: true` by default (fal's
  docs caught up to the previously-banned param).
- Workbench polish: humanized labels ("Auto fix" not `autoFix`), type
  + default chips next to every engine-specific input, a `{N} params`
  badge on each engine card, a `stringArray` text input for Nano
  Banana Pro's `image_urls`.
- The Test button is async now: it polls fal every 3 s, so the button
  cycles **Submitting…** → **In queue…** → **Running…** before the
  result panel mounts. This fixes the workbench failing on long
  video jobs that exceeded the previous blocking-call timeout.

---

# PART ONE — admin panel cleanup verification

Confirm the legacy AI/engine settings are gone from the existing
admin pages.

## Section A — /admin/config

Open `/admin/config` as admin.

### A1. AI Settings group

Expand the AI Settings group. You should see:

- A callout that says **"AI engine configuration has moved"** with a
  link to `/admin/engines`.
- A callout that says **"Image style suffixes moved to look_styles"**.
- The **AI Generation Limits** section (containing just
  `ai_gallery_display_limit`).

You should **NOT** see:

- ❌ Any model selector dropdown listing fal.ai endpoints.
- ❌ A "Per-model parameters" section showing `ai_std_num_inference_steps`,
  `ai_std_guidance_scale`, `ai_ref_pulid_*`, etc.
- ❌ "AI Image Generation" section.
- ❌ "AI Scene Prompt" section.
- ❌ "Video Generation" section with `video_model`, `video_duration`, etc.
- ❌ "Image Style Suffixes" section with the per-style suffix editor
  (the one with a Style dropdown + Standard/Reference textboxes).

If you see any of those: **flag it**. The cleanup missed something.

### A2. Other sections still present

The non-engine sections should still work normally:
- Budget
- Limits
- Email
- Zazzle
- AI Generation Limits (just the gallery display limit)
- Catch-all generic config rows (anything not in a named section)

## Section B — /admin/ai

Open `/admin/ai` as admin.

### B1. The page should be minimal

You should see:

- Debug Mode toggle (kept — not engine-related)
- Both callouts ("AI engine configuration has moved" + "Image style
  suffixes moved to look_styles")
- AI Generation Limits (gallery display limit + max images per fact)

You should **NOT** see:

- ❌ Image Style Suffixes section
- ❌ Any per-style suffix editor
- ❌ Model parameter tables

---

# PART TWO — /admin/engines walkthrough

Open `/admin/engines` as admin.

## Section C — Page layout

### C1. Tabs and grouping

- Two tabs at top: **Live engines** (default) and **Archived**.
- Live tab groups engines by kind (note: the catalogue `kind` for both
  image-to-image and text-to-image engines is `image` — they're told
  apart by whether their schema needs a source image, which is what
  drives the bench type, not a separate kind):
  - **Video engines** — Veo 3.1 Lite (★ default), Veo 3.1 Fast,
    Kling v3 Standard, Seedance 2.0 Fast, Grok Imagine.
  - **Image engines** — Nano Banana Pro (edit) (★ default), PuLID
    (FLUX) — both image-to-image — plus **FLUX Pro v1.1** and
    **FLUX.2 Pro**, which are text-to-image (no source image). All
    four sit in the `image` group; the workbench tells image-to-image
    from text-to-image by the bench it renders.
  - **Utility engines** — Auto-subtitle (★ default).
- Archived tab is empty.
- Every engine card row shows a `{N} params` badge next to the id
  chip so you can see at a glance how many knobs each engine
  exposes (Nano Banana Pro: 7, Veo Lite/Fast: 9, Kling: 8, Seedance:
  7, Grok: 6, PuLID: 10, FLUX Pro v1.1: 7, FLUX.2 Pro: 6,
  auto-subtitle: 13).

### C2. Per-engine row header

Each engine row shows:
- Label (e.g. "Veo 3.1 Lite")
- Provider chip (e.g. "google")
- Status dot (green if active, gray if not)
- ★ badge if it's the default for its kind
- Buttons: **Test**, **Edit ▼**, **Archive** (and **Set as default**
  if it's not currently the default)

### C3. Expanded editor

Tap **Edit ▼** on Veo 3.1 Lite. The expanded panel should have two
columns:

**Left column — Admin-editable** (form inputs you can change):
- `isActive` toggle
- `isDefault` toggle
- `sortOrder` number
- `tierRequirement` dropdown: unregistered / registered / legendary
- `featureFlagRequired` text (nullable)
- `defaultDurationSec` number (constrained to the engine's allowed set)
- `defaultResolution` dropdown (limited to the engine's allowed set)
- `defaultAspectRatio` dropdown (limited to the engine's allowed set)
- `defaultMode` dropdown (limited to supportedModes — for Veo this
  will be empty since Veo has no modes)
- `expectedRunMs` number (with msToHuman display next to it)
- `estimatedCostUsdPerCall` (nullable number)
- `estimatedCostUsdPerSecond` (nullable number)
- A **Save** button

**Right column — Read-only metadata** (code-owned, displayed for
context only):
- `id`
- `provider`
- `endpointId`
- `kind`
- `audioHandling`
- `allowedDurationsSec` (the array)
- `allowedResolutions`
- `allowedAspectRatios`
- `supportedModes`
- `paramSchema` (pretty-printed JSON in a `<pre>` block)

If any editable field is on the right side (read-only), that's a bug.

---

# PART THREE — Synthetic engine test workbench

This is the most important section. The **Test** button opens a
tuning workbench where you iterate until the output matches the
desired behavior. **It bypasses the entire meme builder.**

The workbench is **bench-aware**: a banner at the top of the panel
names the bench (`video bench`, `image-to-image bench`,
`text-to-image bench`, `utility bench`) and only the controls that
bench needs are rendered:

- **video** — sample image, motion prompt, dialogue, duration,
  aspect/resolution/mode, `generate_audio`. (Section D below.)
- **image-to-image** (PuLID, Nano Banana Pro) — sample image +
  **transform prompt** + aspect/resolution. No motion/dialogue. (E5–E6.)
- **text-to-image** (FLUX Pro v1.1, FLUX.2 Pro) — **image prompt** +
  aspect only. No source image, no motion/dialogue. (E6a–E6b.)
- **utility** (auto-subtitle) — a **video URL** + caption knobs.
  No prompt/motion/dialogue. (E7.)

The goal: dial in the right settings per engine, then encode those
into the engine's TypeScript definition so the wizard's production
flow inherits them.

## Section D — Workbench tour (using Veo 3.1 Lite)

### D1. Open the workbench

Tap **Test** on the Veo 3.1 Lite row. An inline panel opens. The
bench-type banner reads **`video bench`**, and the full video form
appears (the image/utility benches in Section E render a deliberately
smaller subset):

- **Experiment shape** radio row (A / B / C / custom)
- **Sample image URL** — defaults to the bundled face JPEG
- **Motion prompt** — editable textarea, pre-filled with the default
  observable choreography
- **Dialogue cue** — editable textarea + "Send dialogue" toggle
- **Universal dropdowns** — Duration, Resolution, Aspect ratio, Mode
  (sourced from the engine's allowed sets)
- **`generate_audio`** checkbox (visible only for audio engines)
- **Engine-specific params panel** — auto-rendered from the engine's
  `paramSchema`. Each field has:
  - A **humanized label** (`autoFix` → "Auto fix", `safetyTolerance`
    → "Safety tolerance").
  - A monospace **type chip** (`boolean`, `int`, `string`, `float`,
    `stringArray`).
  - A **`default: <value>` chip** when the engine defines one.
  - For enums: a select dropdown with `(default: <value>)` in the
    placeholder option.
  - For `stringArray` (Nano Banana Pro's `image_urls`): a text input
    that accepts comma- or newline-separated URLs and converts them
    into an array at submit time.
  - A `{N} knobs` badge in the panel header.
- **Reset to defaults** link top-right
- **Run test** button — its label cycles "Submitting…" → "In queue…"
  → "Running…" while the workbench polls fal every 3 s.

Editing any field flips the experiment radio to `custom` so you know
your last A/B/C choice no longer represents what's being sent.

### D2. Experiment A — Baseline (does the engine speak the cue?)

Click radio **A · Baseline (full dialogue)**, leave everything else
at defaults, click **Run test**. The button shows "Submitting…", then
"In queue…", then "Running…" as it polls fal every 3 s; the **falInput**
panel renders immediately (so you can inspect what was sent without
waiting), and the **falResult** panel mounts when the job finishes
(~15–60 s depending on engine).

Expected pass state in the panel:

- **Spot-check callout** (amber border) — shows the expected motion
  + expected audio so you can compare against the output video.
- **falInput** (pretty-printed JSON) — exactly what was sent to fal.
  Confirm:
  - `image_url` is a fal-CDN URL.
  - `prompt` contains the long motion prompt **AND** the audio cue
    routed via `applyAudioHandling` (for Veo: `\nVoiceover should say,
    "This is a synthetic engine test…"`).
  - `duration` is `"6s"` (Veo uses a stringified seconds-suffix
    duration, e.g. `"6s"`).
  - `aspect_ratio` is `"auto"` (Veo's default) — change it via the
    dropdown to verify other values map correctly.
  - `resolution` is `"720p"`.
  - `generate_audio: true` ✓ — the fal docs caught up to this param;
    the previous "must not declare" regression guard was flipped.
  - `auto_fix`, `safety_tolerance: "4"`, `enhance_prompt: true` show
    with their defaults unless you override them in the engine-
    specific panel.
  - **No `mode` field** — Veo has no modes.
- **falResult** — `data.video.url` with a real video URL. Paste it
  into a new tab; verify:
  - Subject performs the motion described (head turn + dolly push-in).
  - Audio plays the test phrase clearly.
  - **The platform expects voiceover-style audio — the subject should
    NOT be mouthing the words.** If they are, the engine is producing
    on-screen dialogue instead of narration; flag the engine's
    `audioHandling` classification for review.

### D3. Experiment B — Padding test (does the engine invent dialogue?)

Click radio **B · Short dialogue (padding test)**. The dialogue field
auto-fills with a shorter phrase (~half the clip duration). Click
**Run test**.

Pass criterion:

- Audio plays the short phrase, then goes silent (or ambient sound
  only) for the remainder of the clip.

Fail signal:

- Engine invents extra spoken content to fill the remaining clip time.
  Watch for the subject mouthing words that weren't in the cue, or
  for the audio rambling on after the cue should have ended. This is
  the documented Grok Imagine quirk — if it shows up on Veo, that's
  a real signal to investigate.

### D4. Experiment C — Silence (does the engine respect a quiet clip?)

Click radio **C · No dialogue (silence test)**. The dialogue toggle
turns off, and the textarea greys out. Click **Run test**.

Pass criterion:

- Video has no spoken content (ambient SFX / room tone is fine).

Fail signal:

- Engine produces uninvited speech. The subject says something we
  never asked for. Flag the engine.

### D5. Tuning loop (when something doesn't pass)

If any of A/B/C produces unwanted behavior:

1. Edit the **motion prompt** or **dialogue cue** in the textareas to
   try a different phrasing. Re-run.
2. Adjust **engine-specific params** in the amber panel — for
   example, Kling's `cfgScale` controls how strictly the model
   follows the prompt; lower it if the engine is producing wild
   outputs.
3. Adjust **duration** / **resolution** / **mode** dropdowns to see
   if the failure is shape-specific.
4. Once you find a combination that produces clean output, note the
   exact settings (the **Spot-check callout** + falInput JSON are
   your source of truth) and report them back. The settings get
   encoded into `lib/engines/<id>.ts` so the wizard's production
   flow inherits them.

### D6. Expected fail states (engine-level failures, not behavior)

If the panel shows `ok: false`:

- **error.message** — human-readable reason. Common ones:
  - `Engine X parameter Y failed validation` — the paramSchema's
    `enum` rejected a value. Look at the engine's TS definition.
  - `fal: ApiError` with a body — fal rejected the request. The
    body usually says which param is wrong. If a key is rejected,
    the paramSchema in `lib/engines/<id>.ts` needs updating.
  - `503 fal_not_configured` — `FAL_AI_API_KEY` env var isn't set.
    Production fix, not a UAT issue.
- **error.body** — fal's structured error response.

The workbench bounds the poll loop at 4× the engine's
`expectedRunMs` (clamped to 60 s minimum, 5 min maximum). If fal
never returns a terminal status, the panel renders an explicit
timeout error in the result panel rather than spinning forever. If
fal returns `FAILED` or `CANCELED`, the same result panel shows the
fal-reported status under `error.status`. Three consecutive HTTP
errors from the poll endpoint are tolerated before the workbench
gives up.

---

## Section E — Walk the rest of the engines

For each remaining engine, repeat the full D1-D5 sequence (open
workbench, run experiments A/B/C, tune if needed). The expected
`falInput` shape per engine is below as a reference for the baseline
(Experiment A) — these mirror the engine's `paramSchema`. The
engine-specific params panel exposes everything else that's tunable.

### E1. Veo 3.1 Fast

Baseline falInput: same shape as Veo Lite, including
`generate_audio: true`, `auto_fix`, `safety_tolerance: "4"`,
`enhance_prompt: true`. Try `resolution: "1080p"` via the dropdown to
verify the engine accepts it. Engine-specific params panel exposes:
`autoFix` (boolean, default false on Lite / true on Fast),
`safetyTolerance` ("1"–"6" string enum), `enhancePrompt` (boolean),
`negativePrompt` (text), `seed` (int, omitted when blank).

### E2. Kling v3 Standard

Baseline falInput:
- `start_image_url`, `prompt`, `aspect_ratio`
- `duration` is a **string** ("5", not 5) — Kling's quirk; the
  `stringInt` interpreter type handles this.
- `negative_prompt` defaults to `"blur, distort, low quality"`
- `cfg_scale` defaults to `0.5`
- `generate_audio: true` (Kling now accepts this per fal's May 2026
  docs).
- `voice_text` is omitted (the `includeWhen` predicate drops it when
  no `dialogueText` is supplied). For experiment A/B the dialogue
  routes via Kling's `voice_control` audioHandling → fills the
  `voice_text` field.
- `end_image_url` and `seed` are omitted unless you set them in the
  engine-specific panel (both gated on `includeWhen: present`).

Engine-specific params panel: `cfgScale` (number, range 0–1),
`negativePrompt` (text), `endImageUrl` (text — image-to-image
endpoint), `seed` (int). Use cfgScale to tune narration semantics —
lower cfgScale tends to give the model more latitude.

### E3. Seedance 2.0 Fast

Baseline falInput:
- `image_url`, `prompt`, `duration` ("6"), `aspect_ratio`, `resolution` (720p)
- `generate_audio: true`
- `end_user_id` ✓ (ByteDance ToS — a generated test id like
  `"admin-test-1234567890"`)
- `seed` and `end_image_url` omitted unless set via the engine-
  specific panel.

If `end_user_id` is missing, the engine's `paramSchema` is wrong
(`required: true` should be set on the entry). Fal will reject.

Engine-specific params panel: `seed` (int), `endImageUrl` (text). The
dialogue routes through Seedance's `native_audio_boolean` handling —
the voiceover cue is appended to the motion prompt.

### E4. Grok Imagine

Baseline falInput:
- `image_url`, `prompt`, `duration` (6), `aspect_ratio`, `resolution` (480p)
- `video_preset: "normal"` ✓ — note this is `video_preset` in the
  payload (xAI-side name), sourced from the wizard's `mode` field.
- `seed` omitted unless set.

The Mode dropdown lets you pick between Normal / Fun / Custom /
**Spicy** (new — added in PR #57). Try each to verify Grok honors
the param.

**Note**: Grok is the engine that famously invents extra lip-synced
dialogue to fill clip silence (see Experiment B). Worth running B
explicitly to confirm the quirk still exists.

### E5. Nano Banana Pro (edit) (image-to-image, default)

**Bench: image-to-image.** The panel shows a sample-image field + a
**transform prompt** ("how to restyle the source image") + aspect.
No motion, dialogue, or duration. Edit the transform prompt to steer
the restyle; leave the sample blank to use the bundled face. Stage 1's
job is face-preserving stylization.

Baseline falInput:
- `prompt` (string — the meme image prompt)
- `image_urls` is an **array** (e.g. `["https://…/face.jpg"]`), not a
  string — the new `stringArray` primitive wraps the single
  `referenceImageUrl` we pass in. The fal endpoint accepts up to 14
  reference images; the workbench's `imageUrls` text input accepts
  comma- or newline-separated URLs and converts them to an array.
- `aspect_ratio` mapped from `portrait` → `"9:16"` (default).
- `resolution: "1K"` (not `720p`/`1080p` — Nano Banana Pro uses
  `1K`/`2K`/`4K`).
- `safety_tolerance: "5"` (string enum "1"–"6"; raised from the fal
  default of "4" because meme prompts on real selfies tend to trip
  the filter at "4". Bump to "6" if `IMAGE_SAFETY` rejections still
  show up.)
- `num_images: 1`, `output_format: "png"`, `enable_web_search: false`.

Result data shape: `{ data: { images: [{ url }] } }`. No video, no
audio. Experiments B/C don't apply (no audio path).

**Pricing surprise**: 1K and 2K both cost $0.139/image, but 4K is
$0.279. Bumping `enable_web_search` adds $0.015/call. Don't randomly
crank these dials during UAT or your fal bill will reflect it.

**Important**: Nano Banana Pro is the catalogue default for kind=
image, but **the production video pipeline still calls PuLID**. The
catalogue flip only changes what `/api/engines?kind=image` reports
and what the workbench's image-engines section defaults to. See F3
for what to expect in `video_jobs`.

### E6. PuLID (FLUX) (image-to-image)

**Bench: image-to-image** (same as Nano Banana — sample image +
transform prompt + aspect). No longer the catalogue default — Nano
Banana Pro took the ★. PuLID is still in the catalogue, marked
`is_default: false`. The production video pipeline's Stage 1 still
uses PuLID directly, so it remains the engine that actually runs when
you generate a meme.

Baseline falInput:
- `reference_image_url` (string), `prompt` (string — the transform
  prompt from the bench)
- `image_size: "portrait_16_9"`, `num_inference_steps: 28`,
  `guidance_scale: 4`, `id_weight: 1`, `true_cfg: 1`,
  `enable_safety_checker: true`, `num_images: 1`.

Engine-specific params panel exposes all of the above (each with its
`default:` chip), plus `negativePrompt`. Result data shape:
`{ data: { images: [{ url }] } }`. Experiments B/C don't apply.

### E6a. FLUX Pro v1.1 (text-to-image)

**Bench: text-to-image.** No sample-image field — just an **image
prompt** ("scene to generate") + aspect ratio. This is the model the
legacy pipeline already calls for prompt-only generation (fact scene
backgrounds + the no-face fallback), now exposed in the catalogue.

Baseline falInput (verified against fal's `fal-ai/flux-pro/v1.1` docs):
- `prompt` (string — the image prompt from the bench)
- `image_size` mapped from the aspect (`square` → `"square_hd"`,
  `landscape` → `"landscape_16_9"`, `portrait` → `"portrait_16_9"`)
- `safety_tolerance: "2"` (enum "1"–"6"), `enhance_prompt: false`,
  `output_format: "jpeg"`, `num_images: 1`. `seed` is omitted unless set.

Note: the base v1.1 endpoint does **not** take `num_inference_steps`
or `guidance_scale` (those are `/redux`-only); don't expect them in
`falInput`. Result data shape: `{ data: { images: [{ url }] } }`. There
is no source image in `falInput` — that's the tell that it's
text-to-image, not image-to-image. Experiments A/B/C don't apply.

### E6b. FLUX.2 Pro (text-to-image)

**Bench: text-to-image** (same form as E6a). Registered alongside v1.1
as an upgrade candidate — run the same image prompt through both and
compare output quality before we pick a production default.

Baseline falInput (verified against fal's `fal-ai/flux-2-pro` docs):
- `prompt` (string)
- `image_size` mapped from the aspect (`landscape` → `"landscape_16_9"`,
  `square` → `"square_hd"`, `portrait` → `"portrait_16_9"`) — FLUX.2 Pro
  uses the same named-size `image_size` enum as v1.1, **not** an
  `aspect_ratio` string.
- `safety_tolerance: "2"` (enum "1"–**"5"**, narrower than v1.1's "6"),
  `enable_safety_checker: true`, `output_format: "jpeg"`. `seed` omitted
  unless set. No `num_images` on this endpoint.

(There is also a `fal-ai/flux-2-pro/edit` endpoint that takes
`image_urls` for image-to-image — not catalogued yet; it'd be a
separate entry that would classify as an image-to-image bench.)

### E7. Auto-subtitle (utility)

**Bench: utility.** The panel shows a **video URL** field (labeled as
such — not "image") + the caption-styling knobs; no prompt, motion,
or dialogue. Tapping **Test** without supplying the video URL returns
`error: "test_not_supported"` because utility engines expect a video,
not the bundled face placeholder.

To test auto-subtitle:
1. Run Experiment A against Veo or another video engine and copy
   the `falResult.data.video.url`.
2. Paste that URL into the auto-subtitle row's **Sample video URL**
   field (the route routes it to `videoUrl` for utility engines).
3. Click **Run test**.

Expected falInput:
- `video_url` (the URL you supplied)
- Caption styling: `font: "Anton"`, `font_size: 70`, `font_color: "white"`,
  `highlight_color: "orange"`, `stroke_width: 3`, `stroke_color: "black"`,
  `position: "bottom"`, `y_offset: 75`, `words_per_subtitle: 1`,
  `animation: true`.

Result: a captioned MP4 URL. Verify the burned-in captions match
the brand spec (white text, orange highlight on current word, 3px
black stroke, bottom-aligned).

---

## Section F — Set Veo Lite as default and run the wizard end-to-end

Once Veo Lite passes Section D, validate the full wizard flow.

### F1. Confirm Veo Lite is the default

Back to /admin/engines, Live tab. Veo 3.1 Lite should show ★ badge.
If not, tap **Set as default** on that row.

### F2. Make one video meme

1. Log out from admin, log in as your Legendary test user.
2. Open the wizard, pick `video` in Step 1.
3. Upload a selfie.
4. Tap "Make my meme."
5. God Mode takeover mounts:
   - Stage 1 copy: "Forging your likeness…"
   - Progress bar climbs 0→25% over ~18s.
   - Checkpoint screen mounts with your stylized still.
6. Tap "Animate it."
7. Bar climbs 25→100% over ~45s.
8. Detail page loads, video plays with captions.

### F3. Confirm engines used

As admin, in SQL:

```bash
PGPASSWORD=overhype psql -h localhost -U overhype -d overhype_test -c \
  "SELECT id, video_engine_id, image_engine_id, subtitle_engine_id \
   FROM video_jobs ORDER BY id DESC LIMIT 1;"
```

Pass criteria:
- `video_engine_id = 'veo-3.1-lite'`
- `image_engine_id = 'pulid-flux'`
- `subtitle_engine_id = 'fal-auto-subtitle'`

If any are NULL or wrong, the engine selection didn't propagate.

### F4. No-face fallback now generates a scene still

Validate the changed no-face behavior:

1. As your Legendary user, open the wizard → `video`.
2. Upload an image **with no detectable face** (a landscape, an
   object, a pet — anything PuLID will reject).
3. Tap "Make my meme." Stage 1 runs PuLID, fails to find a face, and
   the God Mode takeover parks on the no-face screen ("We couldn't
   find a face in your photo.").
4. Tap **"Use an abstract image based on the fact."**

Pass criteria:
- The pipeline generates a faceless scene still from the fact's scene
  prompt (text-to-image) and animates **that** — NOT your raw upload.
  The finished video should show a generated scene, not your
  faceless photo panning around.
- If text-to-image generation itself fails (budget/moderation), the
  pipeline falls back to promoting the source photo so the job still
  completes rather than erroring — acceptable, but note it if you see
  your raw upload in the output.

(Before this change the fallback always promoted the raw upload, even
though the screen already promised "an abstract image based on the
fact." The copy and the behavior now agree.)

---

# PART FOUR — Swap engines one at a time

The whole point of the test harness is to make this loop tight.

For each engine that passed Section E and you want to try in the
wizard:

1. /admin/engines → tap **Set as default** on the engine.
2. Run the wizard end-to-end (Section F2-F3).
3. If it succeeds, move on. If it fails:
   - Watch the God Mode takeover carefully — does it park at
     `failed`? Click through to see the error message.
   - Compare with what the /test button said.
   - If /test passes but the wizard fails, the bug is in the
     wizard's pipeline runner, not the engine. File that
     specifically.
4. Set Veo Lite back as default when you're done.

---

# Bug report template

```
Section: <e.g. D2>
Engine: <e.g. kling-v3-standard>
Endpoint hit: <e.g. POST /api/admin/engines/kling-v3-standard/test>
Viewer: <admin / legendary>

Workbench state (only for PART THREE bugs):
  Experiment shape: <A / B / C / custom>
  Motion prompt: <verbatim or "default">
  Dialogue cue: <verbatim, or "off" for Experiment C>
  Duration / resolution / aspect / mode: <values from the dropdowns>
  generate_audio: <true / false / n/a>
  Engine-specific params changed: <list any non-default values>

Expected:
  <what the section says should happen>

Actual:
  <what happened>

falInput (paste the JSON from the workbench result panel):
  {...}

falResult / error.body (paste the JSON):
  {...}

durationMs: <number>

testFixtures (paste from the workbench result panel — confirms which
fixtures the route assembled, useful when motion/dialogue look wrong):
  {...}

Screenshots / video (paste the falResult.data.video.url too):
  <link or attachment>

Network panel:
  <any 4xx/5xx requests>
```

---

# Glossary of admin-editable vs code-owned fields

When you're editing in `/admin/engines`, this table tells you what
each side controls.

| Field                       | Admin-editable | Notes                                                                |
|-----------------------------|---------------:|----------------------------------------------------------------------|
| id                          | No             | Code-owned; never changes.                                           |
| provider                    | No             | Code-owned (e.g. "google", "xai").                                   |
| endpointId                  | No             | Code-owned; the fal endpoint string.                                 |
| label                       | No             | Code-owned; the UI display name.                                     |
| description                 | No             | Code-owned blurb.                                                    |
| kind                        | No             | Code-owned ("image"/"video"/"utility").                              |
| isActive                    | **Yes**        | Toggle the engine on/off without code changes.                       |
| isDefault                   | **Yes**        | Use the "Set as default" button for atomic flips.                    |
| sortOrder                   | **Yes**        | Display order in the wizard's engine selector.                       |
| tierRequirement             | **Yes**        | Per-tier visibility gate.                                            |
| featureFlagRequired         | **Yes**        | Hide behind a per-user feature flag (currently admin-only).          |
| defaultDurationSec          | **Yes**        | Default the wizard picks for this engine; must be in `allowedDurationsSec`. |
| defaultResolution           | **Yes**        | Must be in `allowedResolutions`.                                     |
| defaultAspectRatio          | **Yes**        | Must be in `allowedAspectRatios`.                                    |
| defaultMode                 | **Yes**        | Must be in `supportedModes` (empty array means no mode UI).          |
| expectedRunMs               | **Yes**        | Drives the progress bar's expected runtime.                          |
| estimatedCostUsdPerCall     | **Yes**        | Fallback cost when fal pricing cache is unavailable.                 |
| estimatedCostUsdPerSecond   | **Yes**        | Same — fallback only. Runtime pricing comes from fal.                |
| allowedDurationsSec         | No             | Code-owned. Edit `lib/engines/<id>.ts` to change.                    |
| allowedResolutions          | No             | Code-owned.                                                          |
| allowedAspectRatios         | No             | Code-owned.                                                          |
| supportedModes              | No             | Code-owned.                                                          |
| audioHandling               | No             | Code-owned.                                                          |
| paramSchema                 | No             | Code-owned. THIS is what describes the fal payload shape.            |
| deletedAt                   | Indirect       | Set via the **Archive** button; clear via **Restore**.               |

The split exists because the code-owned fields encode contracts with
fal that we don't want admins able to break through a typo. If you
really need to change a paramSchema, that's a code-side edit (we can
do it in a session).
