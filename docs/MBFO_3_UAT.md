# MBFO-3 — User acceptance testing (in-app)

You're the end user here. MBFO-3 is the **first session where the
real meme builder actually shows up** inside the wizard takeover:
locked preview at the top, source segmented control (Stock / Your
photo / AI you), aspect-ratio toggle, stock picker with a pronouns-
aware default, self-upload + AI tabs, the three sliders (text split,
top vertical, bottom vertical), the typography drawer, and a working
"Make my meme" save flow that lands you on the meme detail page.

Everything is still gated behind `VITE_MBFO_WIZARD=1`, so this UAT
splits into two halves:

1. **Flag-OFF half (production path):** prove the production meme-
   build flow is unchanged.
2. **Flag-ON half (preview path):** walk Step 2 image flow end-to-end,
   tier × source matrix, drag-to-reposition, sliders, drawers, save
   paths, and the PuLID loading takeover.

The automated test side is in [`MBFO_3_TEST_RUN.md`](./MBFO_3_TEST_RUN.md)
and is owned by Replit AI; that runs in parallel and you don't need
to read it.

If anything in this UAT fails, write down which section + row, what
you saw vs. what you expected, and a screenshot if it's visual. The
bug-report template is at the bottom.

---

## What MBFO-3 explicitly does NOT ship

These are deferred to MBFO-4/5 and are NOT expected to work yet. If
you hit them, that's expected — not a failure:

- **The video flow.** Tapping the `Video` card in Step 1 still
  advances to Step 2, but Step 2 there is a "Video flow coming in
  MBFO-4" placeholder. **Do not flag the video Step 2 as broken** —
  test it only via the image card for MBFO-3.
- **Server-driven default split.** The `facts.split_token_index`
  column is still null for every fact (the gpt-4o-mini backfill
  pipeline isn't wired). The split slider defaults to a client-side
  heuristic ("intelligent split"). It's a reasonable default but it
  will sometimes pick an awkward word boundary.
- **No-face fallback (silent text-only generation).** If a PuLID
  generation fails because no face was detected, the wizard surfaces
  an inline error message instead of silently falling through to the
  text-only path. The proper silent fallback lands in MBFO-4.
- **Stripe Embedded Checkout.** The AI tab's upgrade modal still
  redirects to `/pricing` (MBFO-5 will swap to in-modal checkout).
- **Engine selection UI.** The image flow has no engine picker
  because PuLID is the only image engine. Video engine picker is
  MBFO-4.
- **Auto-subtitle, Grok Imagine, video budget pre-flight.** All
  MBFO-4.

Anything outside that list — anything that exists on `main` today —
should still work exactly as it did before MBFO-3. The flag-OFF half
of this UAT exists to confirm that.

---

## Setup

1. Pull the latest of the MBFO branch. (PR not yet opened at the time
   of writing; the work is on `claude/setup-mbfo-wizard-rTyMG`.)
2. Boot the dev app in Replit. The session-start hook brings up the
   test DB. **No new migrations** in MBFO-3 — the schema is the same
   as MBFO-2. If you opened the DB before the latest pull, you don't
   need to re-migrate.
3. Viewer states you'll need:
   - **Unregistered** — log out and visit in a private window.
   - **Registered (free)** — any free-tier account.
   - **Legendary** — a paid-tier account with an avatar on file (the
     "Primary" picker tab needs one to be useful).
4. You'll need:
   - At least one root fact (no parent fact) on hand. Stock photos
     and AI generation only work on root facts.
   - For self-upload tests: a JPG / PNG / WebP file under 15 MB.
   - For the AI tab test: be ready to spend ~$0.04 of fal credits on
     one PuLID generation.
5. Devices:
   - A **real mobile phone** (iOS + Android if possible). MBFO-3 is
     mobile-first and the drag-to-reposition gesture is a real touch
     interaction.
   - Desktop browser (Chrome preferred for the DevTools accessibility
     tree and the Performance panel for the debounce check).

---

# PART ONE — flag OFF (production regression)

These rows run against the **default** dev build, no env var set.

## Section A — production path is unchanged

### A1. Fact detail renders normally

Open a fact's detail page. Variant card, vote buttons, comments, and
inline meme grid render exactly as they did before MBFO-3.

**Pass / Fail:** ____.

### A2. The meme-build button opens the Phase-3 MemeStudio

Click whatever button currently launches meme creation. You see the
**existing Phase-3 MemeStudio**, not the full-screen wizard takeover
with image/video cards.

**Pass / Fail:** ____.

### A3. The Phase-3 studio works end-to-end

Pick Stock, make a quick test meme, save it. Save succeeds; the meme
detail page opens.

**Pass / Fail:** ____.

### A4. The new PuLID job endpoints are reachable but locked

Even with the flag off, the new endpoints exist on the server. Hit
them unauthenticated to prove they're mounted (you should get a 401,
NOT a 404):

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:<api-port>/api/memes/pulid-jobs/abcdef
```

Pass criterion: `401`. A 404 would mean the route isn't mounted.

**Pass / Fail:** ____.

### A5. The legacy AI generate endpoint still works

If you used the Phase-3 MemeStudio's AI flow in A3 path variants
(Legendary only), confirm it still completes — the new
`onQueueUpdate` callback was added as an optional parameter that
existing call sites don't pass.

**Pass / Fail:** ____ (skip if not testing legendary AI today).

---

# PART TWO — flag ON (the wizard with real Step 2)

Set `VITE_MBFO_WIZARD=1` and restart the dev server. Re-open the
same fact detail page. The meme-build entry point should now open
the **wizard takeover**.

If it doesn't, stop here — confirm the env var is set and the dev
server actually restarted.

## Section B — Step 1 quick re-pass (regression from MBFO-2)

This is the same surface MBFO-2 already validated. Spot-check, don't
deep-test.

### B1. Image / video cards still render correctly

Image card on top, video card below with crown + gradient ring. For
non-legendary, the video card is dimmed + locked. Tapping the image
card advances to Step 2.

**Pass / Fail:** ____.

### B2. Slide-left transition still feels right

When you tap the image card the wizard slides left into Step 2. When
you tap the back arrow on Step 2 it slides right back.

**Pass / Fail:** ____.

---

## Section C — Step 2 image flow: layout & visuals (no interaction)

You're on Step 2 after picking `image` in Step 1.

### C1. Locked preview sits at the top

A canvas-rendered meme preview sits flush against the top bar (just
under the orange progress fill). It's about 40-50% of the viewport
height. As you scroll the controls below, the preview stays
**stuck** at the top — it does not scroll out of view.

**Pass / Fail:** ____.

### C2. Preview shows the fact text immediately

Even with no source selected, the preview shows the fact text
rendered against a near-black background. The text is white with
Impact-style font + black outline (Phase-3 defaults).

**Pass / Fail:** ____.

### C3. "Drag to reposition" hint appears once a photo is picked

After you pick a stock photo, a tiny `Drag to reposition` chip
appears in the bottom-right of the preview frame. It's not loud — it
should feel like a faint affordance, not a banner.

**Pass / Fail:** ____.

### C4. Source segmented control sits directly below the preview

Three pill tabs in a horizontal row: `Stock`, `Your photo`, `AI you`.
The active tab has a brand-orange (#ff6b35) pill background.

**Pass / Fail:** ____.

### C5. Locked tabs use typeset badges, not emoji

For non-legendary viewers, the AI tab is dimmed and shows a small
`LEGEND` badge with an orange outline. For unregistered viewers, the
Your photo tab shows a `SIGN UP` badge. **There is no crown emoji,
no padlock emoji** — per the design doc, emoji decoration is an
anti-pattern.

**Pass / Fail:** ____.

### C6. Aspect ratio toggle

Three small icon-buttons inside a pill, each drawing the shape of
the ratio (wide rectangle / square / tall rectangle). The active
one fills orange. Label `Ratio` sits to its left in muted text.

**Pass / Fail:** ____.

### C7. Adjust the text + Advanced options buttons

Two button-like rows near the bottom of the scrollable area, each
with a label and a `▾` chevron. These are drawer triggers (we'll
test the drawers in Sections J + K).

**Pass / Fail:** ____.

### C8. Make my meme button

Sticky-bottom CTA with the same orange treatment as Step 1's
`Continue` button. Disabled until a photo source is selected.

**Pass / Fail:** ____.

---

## Section D — Source segmented control × tier matrix

Repeat for each viewer state.

### D1. Unregistered viewer

| Tab          | Visual                                           | Tap behavior                                  |
|--------------|--------------------------------------------------|-----------------------------------------------|
| Stock        | active (orange pill) on entry                    | already selected                              |
| Your photo   | dimmed, with `SIGN UP` badge                     | triggers signup flow (no advance to Step 2)   |
| AI you       | dimmed, with `LEGEND` badge                      | opens upgrade modal                           |

The wizard does NOT navigate away on locked-tab taps. The signup
flow is whatever the app currently does for unauthenticated users
(captcha-protected modal or redirect to sign-in).

**Pass / Fail:** ____.

### D2. Registered (free) viewer

| Tab          | Visual                                           | Tap behavior                                  |
|--------------|--------------------------------------------------|-----------------------------------------------|
| Stock        | active if user has no primary photo              | switches to stock panel                       |
| Your photo   | active if user HAS a primary photo               | switches to self-upload panel                 |
| AI you       | dimmed, with `LEGEND` badge                      | opens upgrade modal                           |

**Pass / Fail (with primary):** ____.
**Pass / Fail (without primary):** ____.

### D3. Legendary viewer

All three tabs available; no badges; no dim. Default tab on entry:

| Has primary photo? | Default tab |
|--------------------|-------------|
| Yes                | AI you      |
| No                 | Stock       |

**Pass / Fail (with primary):** ____.
**Pass / Fail (without primary):** ____.

### D4. Upgrade modal copy when triggered from AI tab

When a non-legendary user taps `AI you`, the upgrade modal opens with
the headline `Go Legendary to stylize with AI.` (Contrast with Step 1's
video-card-triggered modal, which says `Go Legendary to make videos.`)

**Pass / Fail:** ____.

### D5. Upgrade modal CTA still redirects to `/pricing`

`Go Legendary` button → full-page navigation to `/pricing`. (MBFO-5
will replace this with in-modal Stripe.)

**Pass / Fail:** ____.

---

## Section E — Stock picker

Stay on the Stock tab.

### E1. Default gender filter matches your pronouns

Before opening the wizard, set your pronouns:

| User pronouns | Default pool |
|---------------|--------------|
| `he/him`      | male         |
| `she/her`     | female       |
| `they/them`   | neutral      |
| custom / unset| neutral      |

Open the wizard, pick image, go to Step 2. The thumbnails shown
should match the table above. (Don't worry about photo content
matching — many of the curated pools are unisex by nature. The
mapping is in the request URL: open DevTools → Network → look for
`/api/facts/<id>/pexels-images?gender=<male|female|neutral>`.)

**Pass / Fail:** ____.

### E2. Show all toggle expands to the union

A subtle `Show all` link sits above the thumbnail strip. Click it.
The thumbnails should now include the union of all three pools, in
**gender-grouped order**: male photos first, then female, then
neutral (deduped by photo id).

**Open question, please confirm your expectation:** Is the
gender-grouped order what you want, or would you prefer interleaved
(M, F, N, M, F, N…) or shuffled? Flag the answer in your bug-report
notes; we'll address in a follow-up if needed.

**Pass / Fail (toggle works):** ____.
**Your preferred order:** ____.

### E3. Selected thumbnail has an orange border

Tap a thumbnail. The selected one gains a 2-3px orange (`#ff6b35`)
border. Tapping a different thumbnail moves the border.

**Pass / Fail:** ____.

### E4. Live preview updates within ~150ms

After tapping a thumbnail, the locked preview at the top should
re-render with the new background. There's a short debounce (~150ms)
so rapidly tapping multiple thumbnails won't thrash the canvas.

**Pass / Fail:** ____.

### E5. Mobile: horizontal scroll strip with snap

On a narrow viewport (or in DevTools mobile emulation), the
thumbnails render as a horizontal scrollable strip with
scroll-snap. On desktop (hover-capable + fine pointer) they render
as a grid.

**Pass / Fail (mobile strip):** ____.
**Pass / Fail (desktop grid):** ____.

### E6. Empty pool falls back to "show all"

If the fact has no photos in your default gender pool, the picker
**silently widens** to "all" so you never see an empty picker. The
`Show all` toggle should already reflect the on state.

You can engineer this state by picking a fact with limited pexels
coverage, or by editing `facts.pexels_images` for a test fact via
SQL. (Optional row — skip if no easy way to repro.)

**Pass / Fail:** ____.

---

## Section F — Self-upload (Your photo tab)

Switch to `Your photo` tab. Only available as registered or
legendary; if unregistered, tapping triggers the signup flow per D1.

### F1. Tab nav matches the legacy MyImagePicker

Inside the panel: a sub-tab row with `Primary`, `My photos`,
`Upload new`. (AI stylings tab is hidden here — it's the AI tab's
job.) Mostly the same look as the Phase-3 builder's picker.

**Pass / Fail:** ____.

### F2. Primary tab shows your avatar

If you have a profile photo on file, the Primary tab shows it as a
selectable card. Tapping selects it and updates the locked preview.

**Pass / Fail:** ____.

### F3. Library tab lists prior uploads

If you've uploaded photos before, they appear here as a grid (or
horizontal strip on mobile). Tapping selects one.

**Pass / Fail:** ____.

### F4. Upload new — drag drop

Drag a JPG onto the upload zone. The zone transitions through:

- `Uploading…` → `Running moderation checks.`
- (briefly) `Moderating` if applicable
- `Ready` with a thumbnail of the uploaded image

After ready, the photo is selected and the preview updates.

**Pass / Fail:** ____.

### F5. Upload new — click to browse

Click the upload zone (don't drag). Native file picker opens. Pick
a JPG/PNG/WebP. Same transition states as F4.

**Pass / Fail:** ____.

### F6. Upload errors use the locked copy

Try uploading each of:

- A file >15 MB → `That file's bigger than 15MB. Try a smaller one.`
- A `.heic` or other unsupported format → `We need a JPEG, PNG, or
  WebP. That file's a {format}.`
- (Optional) Cut the network mid-upload → `Your upload didn't finish.
  Check your connection and try again.`

The error chip is the legacy MBFO error copy; same copy as the
Phase-3 builder.

**Pass / Fail (size):** ____.
**Pass / Fail (format):** ____.

### F7. Make my meme works for self-upload (no AI)

After selecting an uploaded photo (NOT stylize=true; that's the AI
tab), tap `Make my meme`. The button shows a loading spinner. On
success, you navigate to `/m/<slug>` and see the meme. The DB row's
`image_transform` column is NULL.

**Pass / Fail:** ____.

---

## Section G — AI you tab (Legendary only)

Switch to `AI you` tab. Skip this section if you're not testing as
Legendary today.

### G1. Tab nav adds the AI stylings sub-tab

Inside the AI panel: `Primary`, `My photos`, `AI stylings`, `Upload
new`. The AI stylings tab only appears here.

**Pass / Fail:** ____.

### G2. AI stylings re-use existing PuLID derivatives

If you've previously generated PuLID-stylized images for this fact,
they appear here as a grid. Tapping one selects it — and tapping
`Make my meme` will **NOT** trigger a new PuLID job (you're re-using
an existing one).

**Pass / Fail:** ____.

### G3. Selecting Primary + tapping Make my meme triggers a PuLID job

This is the expensive path (~$0.04 of fal credits per run). When
you're ready:

- Source = Primary tab → your avatar selected
- Tap `Make my meme`
- The PuLID **loading takeover** mounts (full-screen, dark, brand
  orange progress bar)

**Pass / Fail (takeover mounts):** ____.

### G4. Loading takeover copy is locked

The takeover shows:

- Headline (Bebas Neue, all caps): `Forging your likeness.`
- Subhead (white/70): `Standard mortals take days. This takes seconds.`
- A thin progress bar below the subhead

**Pass / Fail:** ____.

### G5. Progress bar reflects actual server progress

This is the headline test for MBFO-3's polling work. Watch the bar:

- It should **start small** (5-30%) while the request is queued.
- It should **climb smoothly** as fal.subscribe yields
  `IN_PROGRESS` events — not jumpy, not janky.
- It should **cap at ~95%** until the job is genuinely complete,
  then jump to 100% as you transition to the meme detail page.

If the bar slams to 100% immediately, or stays at 0 the whole time,
flag it.

**Pass / Fail:** ____.

### G6. Polling resilience

In DevTools → Network → throttle to Slow 3G mid-generation. The bar
should keep moving — after ~3 seconds of stale polls it switches to
an exponential-decay time-based estimator so the user still sees
motion. When polls recover, the bar tracks the real value again.

**Pass / Fail:** ____.

### G7. Save lands on the meme detail page

On completion, the takeover dismisses and you navigate to `/m/<slug>`.
The meme row in the DB has `image_transform = 'pulid'`.

**Pass / Fail:** ____.

### G8. Subsequent generations feel faster (EMA convergence)

After G7 succeeds, run another G3 → G7 pass. The progress bar's
in-progress portion should now climb to ~63% at roughly the same
elapsed time the previous generation finished at — the EMA in
`admin_config.pulid_expected_run_ms_ema` is converging on the real
duration.

This is hard to spot-check by eye; skip if you don't have the
patience. The math is unit-tested.

**Pass / Fail:** ____.

---

## Section H — Aspect ratio

Stay on Step 2 with a stock photo selected.

### H1. Toggle changes the preview canvas

Tap `square` (the middle option). The locked preview re-renders as
a 1:1 canvas. Tap `portrait` (the tall option). Re-renders as 9:16.
Tap `landscape` again. Re-renders as 16:9.

**Pass / Fail:** ____.

### H2. Framing offset is clamped to the new ratio

After dragging the image to a corner of the landscape canvas (use
Section I below first), switch to portrait. The image should snap
back so no empty canvas shows — the framing offset is auto-clamped
by the new aspect dimensions.

**Pass / Fail:** ____.

### H3. Default ratio is landscape

On a fresh wizard entry (no draft), the landscape option is active
by default.

**Pass / Fail:** ____.

---

## Section I — Drag to reposition

This is the gesture test. Mobile and desktop.

### I1. Desktop: click-drag on the preview pans the image

Click and hold on the preview area, drag. The background image pans
within the preview frame. The text overlay does NOT pan.

**Pass / Fail:** ____.

### I2. Desktop: cursor changes on hover

Hovering over the preview shows the `grab` cursor. While dragging,
it changes to `grabbing`.

**Pass / Fail:** ____.

### I3. Mobile: touch-drag pans the image

On a real device, touch the preview and drag horizontally. The
image pans. Vertical drag in the preview area also pans — it does
NOT scroll the page underneath. (CSS `touch-action: none` is doing
the work.)

**Pass / Fail:** ____.

### I4. Touches outside the preview still scroll the page

Touching anywhere below the source segmented control and dragging
vertically scrolls the page normally. The lock only applies to the
preview rect.

**Pass / Fail:** ____.

### I5. Pan is clamped — image never reveals empty canvas

Drag aggressively to a corner. The image should stop panning when
its edge meets the canvas edge — no white/black gap appears.

**Pass / Fail:** ____.

### I6. Pan persists across re-renders

After dragging, change the aspect ratio or pick a different
thumbnail. The pan offset should be preserved (until it gets
re-clamped by the new dimensions per H2).

**Pass / Fail:** ____.

---

## Section J — "Adjust the text" drawer

### J1. Tap the trigger row opens the drawer

The drawer slides up from the bottom of the screen, covering ~60%
of the viewport. The locked preview stays visible above the drawer
backdrop.

**Pass / Fail:** ____.

### J2. Drawer dismisses three ways

- Swipe the drawer down → closes (vaul's gesture handle).
- Tap outside the drawer (on the dim backdrop) → closes.
- The small drag-handle pill at the top is visible.

**Pass / Fail (swipe):** ____.
**Pass / Fail (backdrop):** ____.

### J3. Three sliders are present

The drawer contains:

- **Split position** — with the fact-text preview showing the top
  and bottom halves below.
- **Top position** — slider with a percentage readout.
- **Bottom position** — slider with a percentage readout.

**Pass / Fail:** ____.

### J4. Split slider snaps to word boundaries

Drag the split slider. The thumb commits to integer values (you
can't pick "between" words). Tick marks at the bottom of the track
show the per-word boundaries; the active one is highlighted orange.

**Pass / Fail:** ____.

### J5. Split slider updates the live preview

As you drag the split slider, the top and bottom text halves shown
in the drawer update. **After the drawer closes, the locked
preview** at the top shows the same split (debounced ~150ms).

**Pass / Fail:** ____.

### J6. Vertical sliders move the text without overlapping

Drag the top position slider higher and the bottom slider lower.
As they approach each other, the slider tracks visibly cap at the
collision boundary — you can't drag past the point where the two
text blocks would overlap.

**Pass / Fail:** ____.

### J7. Vertical sliders update the live preview

Same as J5 — preview updates after the drawer closes (or earlier
if the drawer happens to have re-rendered).

**Pass / Fail:** ____.

---

## Section K — "Advanced options" drawer

### K1. Trigger opens the drawer

Same drawer behavior as J1/J2. Dismissable the same three ways.

**Pass / Fail:** ____.

### K2. Font picker

A dropdown listing curated fonts (Bebas Neue, Anton, DM Sans,
JetBrains Mono, Impact). Picking a font changes the preview text
font.

**Pass / Fail:** ____.

### K3. Font size slider

Range 32-120px. The preview text scales as you drag. Default is
64.

**Pass / Fail:** ____.

### K4. Color swatches

- Text color: 5 swatches (white, brand orange, off-white, yellow,
  near-black). Selected swatch has an orange ring.
- Outline color: 4 swatches (black, near-black, brand orange,
  white). Selected swatch has an orange ring.

Tapping a swatch updates the preview text.

**Pass / Fail (text color):** ____.
**Pass / Fail (outline color):** ____.

### K5. Effect picker

Three options in a segmented row: `outline`, `shadow`, `none`.
Active one is orange-filled.

- Outline → text shows the outline color as a stroke.
- Shadow → text shows a drop shadow (rendered by the canvas).
- None → text shows no stroke or shadow.

**Pass / Fail:** ____.

### K6. All caps toggle

Switch (Radix `Switch`). Default ON. Flipping it OFF renders the
preview text in its original casing.

**Pass / Fail:** ____.

### K7. Changes apply live without an Apply button

Every change is applied immediately. No "Apply" or "Save" button
inside the drawer.

**Pass / Fail:** ____.

---

## Section L — Make my meme save flow

These are the bottom-anchored CTA's three modes.

### L1. Stock save — button shows spinner, then navigates

With a stock photo selected, tap `Make my meme`. The button text
becomes a spinner / `Working…` text. After ~500ms-2s, you navigate
to `/m/<slug>`. The meme is visible on the detail page.

**Pass / Fail:** ____.

### L2. Self-upload save (no AI) — same spinner path

Same as L1 but with a self-uploaded photo selected. Spinner →
navigation. `image_transform` in DB is NULL.

**Pass / Fail:** ____.

### L3. AI save — switches to the full-screen takeover

With the AI tab + a photo selected, tapping `Make my meme` mounts
the PuLID loading takeover (see Section G). The CTA spinner is
NOT used in this path — the takeover replaces the whole step.

**Pass / Fail:** ____.

### L4. Save failure surfaces an inline error

To force this, temporarily go offline (DevTools → Network → Offline)
and tap `Make my meme` with a stock photo selected. The button stops
spinning, and an inline error message appears above the CTA:

> `We couldn't save your meme. Try saving again.`

Tap again with network back on — the save succeeds.

**Pass / Fail:** ____.

### L5. CTA is disabled until a source is selected

On a fresh wizard entry to Step 2 with no source picked, the CTA is
visibly disabled. After picking a stock thumbnail, it becomes
active.

**Pass / Fail:** ____.

---

## Section M — Mobile-specific

In Chrome DevTools mobile emulation (iPhone 14 / Pixel 7) AND on a
real device.

### M1. Preview + controls fit without horizontal overflow

The locked preview occupies the top ~45%. Below it: source tabs,
ratio toggle, thumbnail strip, name/pronouns fields, two drawer
triggers, and the CTA — all fit a 375px-wide viewport without any
horizontal scrollbar.

**Pass / Fail (emulation):** ____.
**Pass / Fail (real device):** ____.

### M2. The CTA respects safe-area-inset-bottom

On a notched device (iPhone 13+), the `Make my meme` button sits
above the home indicator, not hidden under it. (`env(safe-area-
inset-bottom)` padding from the existing `WizardPrimaryAction`
component.)

**Pass / Fail:** ____.

### M3. Drawers feel native on mobile

Swipe-down to dismiss a drawer matches OS gesture expectations.
The drag handle pill at the top of the drawer reinforces the
gesture affordance.

**Pass / Fail:** ____.

### M4. Drag-to-reposition does NOT scroll the page

Already in Section I, but worth re-confirming on a real device.
Vertical drags inside the preview rect pan the image, not the page.

**Pass / Fail:** ____.

---

## Section N — Error states

These should all render the locked copy from the Cross-MBFO spec.

### N1. Service unavailable (PuLID 5xx)

Hard to reproduce without faking. If you have admin access to flip
fal-credentials temporarily to invalid, the AI save path should
surface:

> Our servers couldn't handle that much legend at once.

Skip if no easy repro path.

**Pass / Fail:** ____.

### N2. Budget exhausted — image (post-exhaustion notice)

Skip in MBFO-3. The full budget gate UX is wired in MBFO-4; right
now if PuLID gets a 429 from the budget check, the wizard shows an
inline error with the verbatim "out-legended" copy but doesn't have
the dedicated banner.

**Pass / Fail:** ____.

### N3. CSAM / NSFW rejection

Skip — we're not going to manually trigger this. Server-side gate
is the same one Phase-3 uses and is independently tested.

### N4. Face not detected

When PuLID returns "no face detected", the AI save flow currently
surfaces an inline error in the wizard. The silent text-only
fallback (`pulid_fallback_text`) is **deferred to MBFO-4**, so
don't flag the visible error message as a bug.

**Pass / Fail (error message visible):** ____.

### N5. Network drop during preview rendering

Drop the network mid-stock-thumbnail-pick. The preview canvas
keeps the last successfully drawn frame (it does not blank out).
Re-tapping a thumbnail with network restored re-renders normally.

**Pass / Fail:** ____.

---

## Section O — Accessibility quick pass

### O1. Tab order is sensible

Tab through Step 2 with the keyboard. Sensible order: source
tabs → ratio buttons → stock thumbnails (if visible) → name field
→ pronouns field → drawer triggers → CTA. Focus rings visible on
each.

**Pass / Fail:** ____.

### O2. ARIA labels on key controls

In DevTools → Accessibility tree:

- Source control wrapper: `role="tablist"`, `aria-label="Source"`.
- Each source tab: `role="tab"`, `aria-selected`, `aria-disabled`.
- Aspect ratio wrapper: `role="radiogroup"`, `aria-label="Aspect ratio"`.
- Each ratio button: `role="radio"`, `aria-checked`, descriptive
  `aria-label` (e.g., "Landscape 16:9").
- Stock picker wrapper: `role="radiogroup"`, `aria-label="Stock photo"`.

**Pass / Fail:** ____.

### O3. Locked tabs are still focusable

Both the dimmed `Your photo` (anonymous) and `AI you` (free) tabs
are focusable and announce `aria-disabled="true"`. Activating them
with the keyboard triggers the same signup/upgrade modal as a mouse
tap.

**Pass / Fail:** ____.

### O4. Reduced motion still applies

OS Settings → "Reduce motion" ON. The Step 1 → Step 2 slide
transition still happens but is instant. The drawer slide-up
animation honors the same preference (it's a vaul default).

**Pass / Fail:** ____.

---

## Section P — State persistence

### P1. Step 2 selections survive a refresh

On Step 2, pick a stock photo, change aspect ratio to portrait,
drag-reposition. Hard-refresh (Cmd-Shift-R). The wizard re-opens on
Step 2 with the same source, ratio, and framing offset.

**Pass / Fail:** ____.

### P2. Source-tab selection survives a refresh

Switch to the Self-upload or AI tab (whichever your tier allows).
Refresh. The wizard returns you to Step 2 on the same tab.

**Pass / Fail:** ____.

### P3. Drafts are still scoped to factId

Open Fact A, configure Step 2 fully. Navigate to Fact B, open the
wizard. Fact B should start at Step 1 — no inherited state from
Fact A.

**Pass / Fail:** ____.

### P4. Drafts still expire after 1 hour

Time-permitting only. Leave a Step 2 draft sitting for an hour, then
re-open. Wizard should return to Step 1. (Tedious to test manually;
unit tests cover the TTL math.)

**Pass / Fail:** ____.

---

## Section Q — Known scaffolded but unreachable surfaces

Re-stating the deferred items so you don't try to test them and flag
them as broken:

- **Video flow Step 2.** Routes to "coming in MBFO-4" placeholder.
- **Server-driven default split** (`facts.split_token_index`). Falls
  back to client-side heuristic.
- **No-face → silent text-only fallback.** Surfaces an inline error
  instead. MBFO-4 wires the silent path.
- **Stripe Embedded Checkout.** Upgrade modal still redirects to
  `/pricing`.
- **Engine picker.** No image engine selection (PuLID is the only
  one). Video engine picker is MBFO-4.
- **Pre-flight image budget check.** The wizard doesn't show a
  proactive "budget exhausted" banner for image saves; you'll see
  the standard "Try saving again" inline error if the server 429s.
  MBFO-4 wires the proactive UX.

---

## Section R — Engineering preview hooks (optional)

Skip unless you want to eyeball something specific.

### R1. Force the PuLID loading takeover without spending fal credits

To preview the loading screen visual without running a real
generation, you can poke a fake job into the in-memory map. Open
the dev console while on Step 2 and:

```js
// Won't actually work in production — only useful as a quick
// look at the layout while the wizard is mounted in dev:
fetch("/api/memes/pulid-jobs/fake-jobid", { credentials: "include" })
  .then(r => r.json()).then(console.log);
```

You'll get a 404. To actually see the takeover, run a real
generation per Section G.

### R2. Inspect the EMA value

After running at least one PuLID generation:

```sql
SELECT key, value, updated_at
FROM admin_config
WHERE key = 'pulid_expected_run_ms_ema';
```

The value is the current EMA in milliseconds — it should be in the
3000-120000 range and drift toward the average of your recent
generation durations.

---

## Bug-report template

Please format any issues like:

```
[Section / row, e.g. "G5"] Title
Tier: <unregistered / registered / legendary>
Viewport: <mobile / desktop, browser, OS>
Source mode: <stock / self-upload / AI>
Expected: ...
Observed: ...
Repro: ...
Screenshot/video: ...
```
