# PuLID — lessons for a rebuild

PuLID (face-in-scene stylising of the user's own photo) was deleted in launch
Phase 4, removal 3 (#744). Its ledger row is in [`README.md`](README.md); the
product definition and the architecture as they stood are at the tag
`pre-cut/pulid`, in `docs/ai-context/meme-and-video-studio.md` (*AI image
memes*, *Tier gates*) and `docs/manual/6-meme-and-video-studio.md`. Face-in-scene
comes back in launch Phase 7 on a newer model, so this page holds only what a
rebuild would otherwise rediscover: the vendor contract, the shapes that
held, and what failed. Read the tag's code for everything else.

## Vendor contract (`fal-ai/flux-pulid`, as of 2026-10; re-verify first)

- **The face goes in `reference_image_url`**, a URL, so the photo was first
  uploaded to fal's transient storage (`fal.storage.upload`). IP-Adapter
  (`fal-ai/ip-adapter-face-id-plus`) takes it as `face_image_url`; the
  pipeline kept a per-model map of that parameter name.
- **Likeness comes from the image embedding, not the text.** Putting
  face-preservation wording in the prompt crowded out the scene and produced
  headshots, so the prompt described the scene only.
- **Baked-in sampling:** `id_scale` 0.70, `guidance_scale` 5.5,
  `num_inference_steps` 30; `true_cfg_scale` and `start_step` left to the
  model. FLUX models, PuLID included, reject `negative_prompt`, and PuLID
  advertised no `safety_tolerance` field.
- **Priced per megapixel** ($0.0333/MP when cut). The cost bound rounds the
  requested `image_size` up to whole megapixels times `num_images`, and
  refuses a size it cannot read rather than under-reserving.
- **fal rate-limits a second pricing read.** On the 2026-10-16 capture run a
  live price fetch for `fal-ai/flux-pulid` got a 429 seconds after the cache
  had stored that price; reading the price cache first fixed it
  (`falCachedCallPrice`, kept).
- **A run took about 16 s** (the dev estimate `pulid_expected_run_ms_ema`
  stood at 16,101 ms), long enough that the UI needed a server-driven
  progress bar, not a spinner.

## What held

- **The result is an upload, not a new kind of thing.** A stylised image was
  stored as a row in `upload_image_metadata` with `transform = 'pulid'`, its
  `source_object_path` and a `transform_params_hash`; the meme was an
  ordinary upload recipe pointing at it, with `memes.image_transform` as an
  analytics label. That is why the cut deleted no meme: those recipes still
  compose from the stored image. The labels and the partial index
  `IDX_uim_pulid_dedup` remain, with no writer.
- **The entitlement is told to the client, never derived from tier.** The
  `meme_pulid_stylize` grid row gated the wizard tab, the remix toggle and
  the save; a tier check in any of them was the PR #402 bug shape, and each
  was moved to the resolved entitlement before the cut.
- **No face is a user choice, not a silent fallback.** When PuLID's face
  detector missed, the job parked in a `no_face_review` phase and the wizard
  offered "try a different photo" or "use an abstract image". The abstract
  path ran standard text-to-image generation, labelled
  `pulid_fallback_text`, and did not charge the budget twice.

## What failed or was never finished

- **Job state lived in the API process's memory** (a `Map`, 10-minute TTL),
  on the single-instance assumption. A restart lost every job in flight; a
  rebuild that runs more than one instance needs a table, and the generic
  `async_jobs` framework already exists.
- **Two paths did the same job.** The wizard used the async job routes; the
  meme page's remix builder still called the older blocking generate route,
  whose no-photo branch had no budget gate until removal 1 refused it. Build
  one path.
- **The engine catalogue never drove it.** The PuLID engine row was marked
  the default image engine, but the pipeline hardcoded `fal-ai/flux-pulid`;
  a rebuild should go through `loadDefaultEngine` and the interpreter.
- **The successor was already named:** Nano Banana 2 edit was recorded as
  the recommended replacement for selfie stylisation, with native identity
  handling and up to 14 reference images (`lib/engines/nano-banana-2-edit.ts`,
  kept).
- **A misnamed key survives:** `fal_safety_tolerance_pulid` sets the safety
  tolerance for the FLUX Pro models, not PuLID, so it stayed after the cut.
