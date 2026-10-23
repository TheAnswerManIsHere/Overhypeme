# Video — lessons for a rebuild

Video was deleted in launch Phase 4, removal 2 (#744). Its ledger row is in
[`README.md`](README.md); the product definition and the architecture as they
stood are at the tag `pre-cut/video`, in `docs/ai-context/meme-and-video-studio.md`
(*AI video memes*) and `docs/manual/6-meme-and-video-studio.md`. This page holds
only what those docs do not: vendor contracts learned the hard way, the design
choices that held, and what failed. Read it before building video again; read
the tag's code for everything else.

## Vendor contracts (fal, verified May 2026; re-verify before relying on them)

Every one of these was a shipped bug or a near miss.

- **Veo 3.1 Lite** (`fal-ai/veo3.1/lite/image-to-video`): `duration` is a
  string with an `s` suffix (`"4s" | "6s" | "8s"`); a bare integer is a 422.
  `aspect_ratio` has no `1:1`. 1080p is only accepted with `"8s"` (a
  cross-field 422). `generate_audio` was a 422 once (migration 0058) and
  accepted later; it moves the price from $0.05/s to $0.03/s when off.
- **Kling v3 Standard** (`fal-ai/kling-video/v3/standard/image-to-video`): the
  image field is `start_image_url`, not `image_url` (the O3 family uses
  `image_url`). The *start image* governs output orientation, not
  `aspect_ratio`, so the still must be cropped to the target aspect first.
- **Seedance 2.0 Fast** (`bytedance/seedance-2.0/fast/image-to-video`): no
  `fal-ai/` prefix; `duration` is a string (`"auto"`, `"4"`–`"15"`); no 1080p
  on the fast tier; `generate_audio` costs the same on or off; ByteDance's
  terms want `end_user_id` on every call, so the schema made it required.
- **Grok Imagine video** (`xai/grok-imagine-video/image-to-video`): no
  `fal-ai/` prefix; the mode field is `video_preset` (full enum `normal`,
  `fun`, `custom`, `spicy` — a fix once wrongly narrowed it); `duration` is an
  integer 1–10. It invents extra dialogue to fill silence after a short cue,
  which is why the admin bench grew a "short dialogue" padding experiment.
- **Auto-subtitle** (`fal-ai/workflow-utilities/auto-subtitle`, the caption
  burn-in stage): `font_name` not `font`, `enable_animation` not `animation`;
  colours accept names and `#RRGGBB`; $0.03 per minute of input.
- **Audio is per engine, not per pipeline.** Four strategies were needed:
  native lip-sync with a dialogue parameter (Veo), a voice slot (Kling),
  a `generate_audio` boolean that improvises (Seedance), and a prompt cue
  appended as `Voiceover should say, "…"` (Grok). The engine row carried an
  `audio_handling` value and one function routed the dialogue per strategy.
- **Cost** was computed from video tokens: `(width × height × fps × seconds) /
  1024`, priced per million tokens from the fal pricing cache.

## Design choices that held

- **The async pipeline with a checkpoint.** The surviving design was a
  persisted job with phases `queued → stage1 (stylise the still) →
  stage1_review (user approves the still) → stage2 (animate) → stage2_subtitle
  → uploading → completed`. The checkpoint let a user reject a bad still before
  paying for the expensive stage. Progress was computed from the real phase,
  not faked.
- **Authorization captured at submission.** Each job row stored the tier and
  feature decisions resolved when the request arrived, NOT NULL with no
  default, and the runner never re-derived them at execution.
- **Polling leaks nothing.** A non-owner polling a job got 404, never 403, so
  job ids could not be probed.
- **Engines as code-defined rows.** The video engines lived in the same
  code-first catalogue as image engines, reconciled into the `engines` table at
  boot, with admin-tunable defaults preserved across reconciliation.

## What failed

- **A synchronous route that held the HTTP request open** for the whole
  generation, with a client-side, time-based progress bar that showed nothing
  real. It was superseded by the async pipeline but stayed deployed, unused,
  until this removal.
- **A feature flag the admin grid could not switch off.** `video_generation`
  was re-seeded by the boot seed with `DO UPDATE` on every restart, so an
  operator's toggle silently reverted at the next deploy. The grid's single
  writer is the fix, and the rule outlived video.
- **No privacy for video memes.** The async start route accepted no privacy
  field, so every video meme was public.
- **User deletion left video bytes behind.** Hard-deleting a user nulled
  `video_jobs.user_id` but never deleted the stylised still or the MP4 in
  object storage.
- **Stage 1 ignored the engine catalogue.** Nano Banana Pro was marked the
  default image engine for styling, but the pipeline's Stage 1 still called a
  hard-coded PuLID path, so the admin's choice did nothing in production.

## Left behind by the removal

- The MP4s and stylised stills in object storage. Migration 0103 dropped the
  columns that pointed at them; the files themselves were not deleted.
- The `engines` table's video-shaped columns (`allowed_durations_sec`,
  `supported_modes`, `audio_handling` and their defaults), kept because the
  engine type and editor are shared with image engines. Recorded as a removal
  11 candidate on #744; removal 11 dropped them, with their admin fields
  (migration 0110; ledger [`README.md`](./README.md)).
- The `engine_experiments` feature flag, which gated non-default video engines;
  it is the generic engine-gating flag and Plan 3 owns it.
