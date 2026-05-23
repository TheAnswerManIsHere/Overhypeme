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

1. Pull the latest from PR #51's branch (`claude/start-mbfo-4-z87MQ`).
2. Boot the dev app. The session-start hook brings up the test DB.
   Three new migrations apply (0059 deletedAt, 0060 retire legacy
   keys, 0061 retire style_suffix keys) — no manual SQL.
3. You need:
   - An **admin** login (the engine management UI is admin-gated).
   - A **Legendary** test user to run the wizard end-to-end.
   - A selfie under 15 MB (JPEG/PNG/WebP).
4. You'll burn ~$0.45 of fal credits per successful wizard run, plus
   ~$0.05-$0.15 per /test button click (depends on engine).

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
- Live tab groups engines by kind:
  - **Video engines** — Veo 3.1 Lite (★ default), Veo 3.1 Fast,
    Kling v3 Standard, Seedance 2.0 Fast, Grok Imagine.
  - **Image engines** — PuLID (FLUX) (★ default).
  - **Utility engines** — Auto-subtitle (★ default).
- Archived tab is empty.

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

This is the most important section. The **Test** button opens a full
tuning workbench where you can edit every meaningful input (motion
prompt, dialogue, duration, aspect ratio, resolution, mode, engine-
specific params) and iterate until the output matches the desired
behavior. **It bypasses the entire meme builder.**

The goal: dial in the right settings per engine, then encode those
into the engine's TypeScript definition so the wizard's production
flow inherits them.

## Section D — Workbench tour (using Veo 3.1 Lite)

### D1. Open the workbench

Tap **Test** on the Veo 3.1 Lite row. An inline panel opens with the
full form:

- **Experiment shape** radio row (A / B / C / custom)
- **Sample image URL** — defaults to the bundled face JPEG
- **Motion prompt** — editable textarea, pre-filled with the default
  observable choreography
- **Dialogue cue** — editable textarea + "Send dialogue" toggle
- **Universal dropdowns** — Duration, Resolution, Aspect ratio, Mode
  (sourced from the engine's allowed sets)
- **`generate_audio`** checkbox (visible only for audio engines)
- **Engine-specific params panel** — for Veo Lite this surfaces
  optional fields like `negativePrompt`. For Kling it surfaces
  `cfgScale`, `negativePrompt`, etc. Rendered dynamically from the
  engine's `paramSchema`.
- **Reset to defaults** link top-right
- **Run test** button

Editing any field flips the experiment radio to `custom` so you know
your last A/B/C choice no longer represents what's being sent.

### D2. Experiment A — Baseline (does the engine speak the cue?)

Click radio **A · Baseline (full dialogue)**, leave everything else
at defaults, click **Run test**. Wait ~15-30 seconds for the engine.

Expected pass state in the panel:

- **Spot-check callout** (amber border) — shows the expected motion
  + expected audio so you can compare against the output video.
- **falInput** (pretty-printed JSON) — exactly what was sent to fal.
  Confirm:
  - `image_url` is a fal-CDN URL.
  - `prompt` contains the long motion prompt **AND** the audio cue
    routed via `applyAudioHandling` (for Veo: `\nVoiceover should say,
    "This is a synthetic engine test…"`).
  - `duration` is `6` (engine's `defaultDurationSec`).
  - `aspect_ratio` is `"16:9"`.
  - `resolution` is `"720p"`.
  - **No `generate_audio` field** — the migration-0058 regression
    guard (Veo doesn't accept it).
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

---

## Section E — Walk the rest of the engines

For each remaining engine, repeat the full D1-D5 sequence (open
workbench, run experiments A/B/C, tune if needed). The expected
`falInput` shape per engine is below as a reference for the baseline
(Experiment A) — these mirror the engine's `paramSchema`. The
engine-specific params panel exposes everything else that's tunable.

### E1. Veo 3.1 Fast

Baseline falInput: same as Veo Lite. Try `resolution: "1080p"` via
the dropdown to verify the engine accepts it. Engine-specific params
panel: `negativePrompt` only.

### E2. Kling v3 Standard

Baseline falInput:
- `image_url`, `prompt`, `aspect_ratio`
- `duration` is a **string** ("5", not 5) — Kling's quirk; the
  `stringInt` interpreter type handles this.
- `negative_prompt` defaults to `"blur, distort, low quality"`
- `cfg_scale` defaults to `0.5`
- `voice_text` is omitted (the `includeWhen` predicate drops it when
  no `dialogueText` is supplied). For experiment A/B the dialogue
  routes via Kling's `voice_control` audioHandling → fills the
  `voice_text` field.

Engine-specific params panel: `cfgScale` (number, range 0–1),
`negativePrompt` (text). Use these to tune narration semantics —
lower cfgScale tends to give the model more latitude.

### E3. Seedance 2.0 Fast

Baseline falInput:
- `image_url`, `prompt`, `duration` (6), `aspect_ratio`, `resolution` (720p)
- `generate_audio: true` (Seedance accepts this — Veo doesn't)
- `end_user_id` ✓ (ByteDance ToS — a generated test id like
  `"admin-test-1234567890"`)

If `end_user_id` is missing, the engine's `paramSchema` is wrong
(`required: true` should be set on the entry). Fal will reject.

Engine-specific params panel: `negativePrompt` (text). The dialogue
routes through Seedance's `native_audio_boolean` handling — the
voiceover cue is appended to the motion prompt.

### E4. Grok Imagine

Baseline falInput:
- `image_url`, `prompt`, `duration` (6), `aspect_ratio`, `resolution` (480p)
- `mode: "normal"` ✓ (Grok-specific)

Mode dropdown lets you pick between Normal / Fun / Custom. Try each
to verify Grok honors the param.

**Note**: Grok is the engine that famously invents extra lip-synced
dialogue to fill clip silence (see Experiment B). Worth running B
explicitly to confirm the quirk still exists.

### E5. PuLID (image utility)

Image engine, not video. The workbench sends the same face image
and confirms the paramSchema works:

Baseline falInput:
- `reference_image_url` (string)
- `prompt` (string)

Result data shape: `{ data: { images: [{ url }] } }` rather than
`{ data: { video } }`. Don't expect a video URL or audio. Experiments
B/C don't apply (no audio path).

### E6. Auto-subtitle (utility)

Tapping **Test** without supplying a `sampleImageUrl` returns
`error: "test_not_supported"` because utility engines expect a video
URL, not the bundled face placeholder.

To test auto-subtitle:
1. Run Experiment A against Veo or another video engine and copy
   the `falResult.data.video.url`.
2. Paste that URL into the auto-subtitle row's **Sample image URL**
   field (which the route treats as `videoUrl` for utility engines).
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
