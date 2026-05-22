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

# PART THREE — Synthetic engine tests (the headline feature)

This is the most important section. The **Test** button runs an engine
with a synthetic test face image and shows you exactly what was sent
to fal + what fal returned. **It bypasses the entire meme builder.**

The goal: confirm each engine's `paramSchema` is correct before we
debug anything in the meme builder flow.

## Section D — Veo 3.1 Lite test

### D1. Run the test

Tap **Test** on the Veo 3.1 Lite row. An inline panel opens.

Click **Run test**. Wait ~15-30 seconds.

### D2. Expected pass state

The panel should display:

- **falInput** (pretty-printed JSON) — exactly what was sent to fal.
  Confirm:
  - `image_url` is a URL starting with `https://fal.media` or similar
    (the synthetic test face uploaded to fal's CDN).
  - `prompt` is "Synthetic admin test: subtle camera push-in, gentle
    motion." (or similar).
  - `duration` is `6` (the engine's `defaultDurationSec`).
  - `aspect_ratio` is `"16:9"`.
  - `resolution` is `"720p"`.
  - **No `generate_audio` field.** (The migration-0058 bug class —
    Veo doesn't accept this.)
  - **No `mode` field.** (Veo has no modes.)
- **falResult** — fal's response. For a successful run, this includes
  `data.video.url` with a real generated video URL. You can paste
  that URL into a new tab to see a ~6 second video.
- **durationMs** — wall-clock duration (typically 15000-30000 ms).

### D3. Expected fail states

If the panel shows `ok: false` instead:

- **error.message** — human-readable reason from the engine interpreter
  or fal. Common reasons:
  - "Engine X parameter Y failed validation" — the paramSchema declares
    a value that didn't make it through (probably an `enum` mismatch).
    Look at the engine's TypeScript definition.
  - "fal: ApiError" with a body — fal rejected the call. The body
    usually says which param is wrong. If a key is wrong, file a bug —
    the paramSchema in `lib/engines/veo-3.1-lite.ts` needs to be updated.
- **error.body** — fal's structured error response, if any.

### D4. Outcome

If D2 passes, Veo Lite is wired correctly. Move on to D5.

If D2 fails, **stop**. The wizard isn't going to do better than the
direct test. Capture the failure details and we fix the paramSchema
before trying anything else.

---

## Section E — Walk the rest of the engines

For each remaining engine, repeat the Section D test pattern.

### E1. Veo 3.1 Fast

Expected falInput fields: same as Veo Lite, but `resolution` is
`"720p"` (default) and could be set to `"1080p"`. Test with default.

### E2. Kling v3 Standard

Expected falInput fields:
- `image_url` (string)
- `prompt` (string)
- `duration` is a **string** ("5", not 5) — Kling's quirk.
- `aspect_ratio`
- `negative_prompt` ("blur, distort, low quality" default)
- `cfg_scale` ~0.5 (or whatever the engine's default is set to)
- **No `voice_text`** field (omitted because no `dialogueText` was
  supplied; the `includeWhen` predicate dropped it).

### E3. Seedance 2.0 Fast

Expected falInput fields:
- `image_url`, `prompt`, `duration` (6 default), `aspect_ratio`,
  `resolution` ("720p")
- `generate_audio: true` (Seedance accepts this — it's Veo that doesn't)
- `end_user_id` ✓ (ByteDance ToS requirement — should be a generated
  test id like `"admin-test-1234567890"`)

If `end_user_id` is missing, the engine's `paramSchema` is wrong
(`required: true` should be set). Fal will reject.

### E4. Grok Imagine

Expected falInput fields:
- `image_url`, `prompt`, `duration` (6 default), `aspect_ratio`,
  `resolution` ("480p" default)
- `mode: "normal"` ✓ (Grok-specific)

### E5. PuLID (image utility)

This is an image engine, not video. The synthetic test sends the same
face image and confirms the paramSchema works:

Expected falInput:
- `reference_image_url` (string)
- `prompt` (string)

Result data shape: `{ data: { images: [{ url }] } }` rather than
`{ data: { video } }`. Don't expect a video URL.

### E6. Auto-subtitle (utility)

Tapping **Test** on auto-subtitle without supplying a `sampleImageUrl`
should return `error: "test_not_supported"` with copy explaining that
utility engines need an explicit video URL.

To actually test auto-subtitle: enter a real video URL (e.g. a fal
CDN URL from a successful Veo test in D2) in the **Sample image URL**
input (which auto-subtitle treats as a video URL), then Run test.
Expected falInput:
- `video_url` (the URL you supplied)
- Caption styling fields: `font: "Anton"`, `font_size: 70`,
  `font_color: "white"`, `highlight_color: "orange"`, etc.

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

Expected:
  <what the section says should happen>

Actual:
  <what happened>

falInput (paste the JSON from the Test panel):
  {...}

falResult / error.body (paste the JSON):
  {...}

durationMs: <number>

Screenshots / video:
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
