# Plan — profile photo zoom & crop

Workstream: #1215

```plan-oracle
# Oracle — profile photo zoom & crop (agreed by David, 2026-11-24, workstream #1215)

Direction served: the meme builder uses the member's own face ("made about a friend"; the profile photo is the reusable identity asset that photo memes and AI image generation consume as a square face crop).

Product intent: when a member adds a profile photo, they choose which part of the picture is used — the photo shown inside a round frame, drag to reposition, pinch (touch) or a slider to zoom — and what is inside the frame is exactly what is saved, as today's 1024-px square JPEG. No more silent centre-crop.

Surfaces (now):
1. Onboarding's "Add a real photo of you" step (artifacts/overhype-me/src/pages/Onboard.tsx) — today centre-crops on pick and shows the result only.
2. Profile's "Change photo" (artifacts/overhype-me/src/pages/Profile.tsx handlePhotoChange) — today uploads immediately with a centre-crop and no preview; gains the crop step before upload.

Must not change:
- How the photo is uploaded, stored, tagged as the profile photo and set as the member's picture (uploadUserImage kind "avatar"; POST /api/users/me/profile-image).
- "Skip for now" on onboarding; the "Take photo" camera path.
- GIFs on Profile still upload verbatim (cropping would kill animation).
- The read-only pause behaviour on Profile (a picker opened before a pause does not upload).

Settled decisions: one shared crop component used by both surfaces; output stays a square JPEG at up to 1024 px.

Next, not now: the meme builder's own self-upload cropping; Profile's 5 MB limit vs onboarding's 15 MB.
Never: server-side cropping changes.

Ceremony tier: full production-phase feature loop — plan + Astra review, David's approval, build, Codex review, UAT section.
```

## Problem

Both ways a member sets a new profile photo throw away their framing choice. Onboarding centre-crops the moment a file is picked and only shows the result; Profile's "Change photo" uploads a centre-crop with no preview at all. A face that isn't in the middle of the picture — a full-body shot, a group-edge selfie, the screenshot David tested with — produces a profile photo, and therefore every photo meme, framed on the wrong thing.

## Direction

The profile photo is the identity asset every photo meme and AI render consumes. The member must own its framing, once, at the moment they supply it.

## Product Intent

As the oracle. In one sentence: pick a photo → see it in a round frame → drag and zoom until the face is right → confirm → exactly that square is saved.

## Must Not Change

As the oracle, plus (from the scope exchange, S2): cancelling or replacing a selection uploads nothing; a failed save never shows the new picture as the member's photo.

## Settled Decisions

- **One shared crop editor**, used by both surfaces; each page keeps its own upload, error and completion flow and sends the confirmed file through `uploadUserImage({ kind: "avatar", preprocess: "none" })`, so the upload and profile-image transaction are untouched.
- **The saved file is the full square whose circular view the editor showed.** The round frame previews the circle of that square (how avatars render); the stored JPEG is the square, exactly as today.
- **Preview and export come from one crop calculation** on the original decoded image, never from the centre-crop helper (S1). The source is kept in memory while editing; export draws the chosen region directly.
- **Preview and export show the same still image** (S3): the same frame of an animated image and the same opaque black backing behind transparency that today's JPEG conversion applies, as well as the same coordinates. Conversion behaviour for inputs entering the editor is otherwise unchanged.
- **Output size:** the chosen square, at its source-pixel size capped at 1024 px — a smaller source crop is never enlarged, as today.
- **Default framing** on open is today's centre square at minimum zoom, so a member who confirms without touching anything gets exactly what they get today.
- **Zoom range:** minimum zoom is the largest square that fits the photo (no empty margins in the saved file — the photo always covers the frame); maximum is 4× that. Dragging is clamped so the frame never leaves the photo.
- **Camera path:** "Take photo" keeps its own input; its result enters the same editor.
- **GIFs on Profile** bypass the editor and upload verbatim, as today.
- **Affected-surface inventory.** Class: client code that turns a freshly picked file into the member's profile photo. Oracle: `git grep -n "kind: \"avatar\"" artifacts/overhype-me/src` and `git grep -n cropToSquareJpeg artifacts/overhype-me/src`, run at this revision: avatar uploads at `Onboard.tsx:345` and `Profile.tsx:648` only; `cropToSquareJpeg` called directly only at `Onboard.tsx:322` (and via `preprocess: "square"` inside `image-upload.ts`). Profile's library-thumbnail picker re-tags an existing upload and is not a new-file flow — unchanged. The meme builder's self-upload is a different asset (a meme source, not the profile photo) and is *next* per the oracle.

## Proposed Design

- **`PhotoCropEditor`** (shared component): takes the picked `File`; shows the image under a circular mask on a square stage; drag (mouse and one-finger touch) repositions, two-finger pinch and a labelled slider zoom; keyboard users can move with arrow keys and zoom with the slider. Buttons: **Use this photo** (confirm) and **Pick a different one** / **Cancel**. Confirm produces a square JPEG `File`. The interaction library is a technical choice made at build.
- **Onboarding:** picking or taking a photo opens the editor in place of today's static preview, inside the same card; the editor's **Use this photo** hands the cropped JPEG straight to the page's existing upload-and-set flow — one confirm, the same on both surfaces, never two successive buttons. "Pick a different one" and "Skip for now" behave as today.
- **Profile:** picking a non-GIF file opens the editor in a dialog; **Use this photo** in the dialog runs the existing upload-and-set flow. Closing the dialog uploads nothing.
- **Pause rule (S2):** Profile keeps today's check when the picker returns, and checks again at confirmation, immediately before upload (after the JPEG is encoded); a pause arriving while the editor is open refuses the upload with the existing read-only notice and leaves the current photo unchanged. Onboarding's confirm button keeps its existing `PausedWhenReadOnly` wrapper.
- **Errors:** an image that cannot be decoded shows the existing "Could not process that image" message and lets the member pick again; a failure of the upload or of setting the profile image leaves the old photo displayed. A cancelled or replaced selection never later publishes its encoding result.

## Data Model and Migration Impact

None. No stored crop coordinates; no server changes.

## Security, Permissions, and Validation

Unchanged: the same upload endpoint, size and type checks, and profile-image transaction. The editor runs entirely in the browser on a file the member chose.

## Testing Plan

- **Unit (vitest, `pnpm --filter overhype-me test`):** the crop calculation — for a range of image aspect ratios, zooms and offsets, the computed source square is always inside the image, its side equals visible-frame-side ÷ scale, clamping holds at every edge, default framing equals today's centre square, and output size is min(side, 1024).
- **Browser (Playwright, `e2e/`), registered in a suite CI already runs** (e.g. `e2e:screens`; discovery verified with that suite's command — S4): on both onboarding and Profile, use an asymmetric fixture with distinguishable landmarks. After dragging and zooming, assert the landmarks' positions and scale in the rendered circular preview — observed from the screen, independently of the crop calculation — then confirm, intercept the upload, and compare the same landmarks in the outgoing JPEG (allowing for compression and display scaling). Assert square dimensions and no upscaling. Fixtures include a rotated JPEG, a transparent PNG and (onboarding) an animated GIF, each showing preview and export agree. The test must fail if either the displayed or the exported framing is deliberately offset (S1). Negative cases: cancel uploads nothing; a GIF on Profile skips the editor and uploads its original bytes; a pause set while the editor is open refuses the upload; slider zoom changes the result; touch pinch is exercised with emulated touch; a failed upload and a failed profile-image set each leave the old photo displayed; replacing a selection mid-encode never publishes the stale result.
- **UAT (judgement only):** on David's iPad — does framing feel natural with fingers; is it clear what will be saved.

## Implementation Steps

1. Crop calculation module + unit tests.
2. `PhotoCropEditor` component (stage, mask, drag, pinch, slider, keyboard, JPEG export).
3. Wire onboarding; replace the "We cropped it square" copy with guidance to drag and zoom.
4. Wire Profile (dialog; GIF bypass; second pause check).
5. Browser tests for both surfaces.
6. PR with UAT section.

## Risks and Mitigations

- **Preview/export mismatch** (the failure that would make the feature lie) — single calculation; pixel-level browser test.
- **Pinch fighting page zoom/scroll on iPad** — the stage disables browser touch gestures on itself only; covered by emulated-touch test and the UAT step.
- **Very large camera photos** — today's 15 MB onboarding cap holds; the image is decoded once and only the 1024-px output is encoded.
- **EXIF-rotated phone photos** — the browser applies orientation on decode for both the preview and the canvas draw; the browser test includes a rotated JPEG.

## Questions for David

None. Every behaviour above is either in the agreed scope or follows from it.

## Definition of Done

- [ ] On onboarding and on Profile, a member can drag and zoom a picked photo (mouse, touch pinch, slider) and the saved profile photo is exactly the framed square.
- [ ] Confirming untouched saves today's centre crop.
- [ ] Cancel uploads nothing; GIFs on Profile still upload verbatim; Skip and Take photo still work; a pause during editing refuses the upload.
- [ ] Unit and browser tests pass in CI; Codex review returned; UAT section written.
