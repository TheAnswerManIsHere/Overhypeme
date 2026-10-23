# Stock photos and Pexels — lessons for a rebuild

Stock photos from Pexels (the wizard's and remix builder's stock source, the
per-fact photo library, the `fact_pexels` queue and its lane, the moderation
Pexels panel, the backfill buttons and the per-user image preferences) were
deleted in launch Phase 4, removal 6 (#744). Its ledger row is in
[`README.md`](README.md); the code and docs as they stood are at the tag
`pre-cut/stock-pexels`, in `docs/ai-context/meme-and-video-studio.md` (the
`imageSource` table), `docs/ai-context/moderation-workflow.md` and
`docs/manual/6-meme-and-video-studio.md`. Nothing on the roadmap brings stock
photos back, so this page holds only what a rebuild would otherwise
rediscover: the vendor contract, the shapes that held, and what failed.

## Vendor contract (Pexels API v1, as of 2026-10; re-verify first)

- **Auth is the raw key in `Authorization`**, no `Bearer` prefix, against
  `https://api.pexels.com/v1`. A 401 meant the key was wrong, and the client
  logged it and returned no photos rather than throwing.
- **Rate limits, as the client's comment recorded them:** 200 requests an
  hour and 20,000 a month on the free tier, with a 429 when exceeded. The
  old bulk routes spaced calls a second apart; the queue reproduced that by
  sleeping one second after each job on a lane of concurrency one, since a
  serialized lane alone starts the next job immediately.
- **Search:** `/search` with `query`, `orientation=landscape`, `per_page`
  (max 80) and `page=1` for a deterministic library. Lookup by id was
  `/photos/:id`.
- **Each photo carries a `src` map** (`original`, `large2x`, `large`,
  `medium`, `small`, `portrait`, `landscape`, `tiny`) plus `photographer`
  and `photographer_url`. Rendering used `large2x` (~1880 px): `large`
  (~940 px) gave ~650 px square crops that looked posterized when the meme
  page upscaled them.
- **Licence:** free to use in an app, attribution not required; the UI
  credited the photographer anyway.

## What held

- **The search terms came from the fact, not its words.** A utility LLM call
  (temperature 0.2, JSON output) read the tokenized template, classified it
  `action` (a stageable literal scene, even for an impossible claim) or
  `abstract` (no stageable scene), and wrote three queries, `male`, `female`
  and `neutral`, each naming the gender naturally rather than prepending it.
  Searching the literal scene ("bears, campsite, forest") beat searching the
  joke.
- **The library was a cache on the fact.** `facts.pexels_images` held
  `{fact_type, male[], female[], neutral[], keywords}`, each entry
  `{id, url, photographer, photographer_url, src}`; the count per gender was
  an admin setting (`pexels_photos_per_gender`, default 10, since the picker
  showed ten). It was rebuildable by searching again, which is why the cut
  dropped it without capturing it.
- **Images never gated moderation.** Enrichment moved a fact out of
  `prep_pending`; the Pexels job ran beside it and a failure left the fact
  approvable with `pexels_status = 'failed'`. A staging fact that had left
  prep skipped its paid calls and retired the job as a no-op.

## What failed or was never finished

- **A stock meme was never a stored image.** Its recipe kept the Pexels
  photo id, and every view re-resolved the photo through the API (a
  15-minute in-process cache, then the URL stored at save). Losing the key
  or the vendor broke every stock meme at once, which is why the cut had to
  soft-delete them rather than leave them serving. A rebuild should copy the
  chosen photo into object storage at save.
- **A status marker could go stale.** The pacing sleep widened a race
  between the job's `pexels_status` write and its row's finalization: a
  second enqueue in that window reset the fact to `pending` and deduped onto
  the finishing job, leaving it `pending` forever. Recorded in
  `docs/engineering/deferred-work.md` with the AI-meme backfill's identical
  gap, never fixed.
- **Two paths seeded the library.** The durable queue served moderation
  prep; a fire-and-forget in-process retry loop served admin edits. Build
  one path.
- **The preferences had no reader.** `user_fact_preferences.image_index` and
  `ai_meme_image_index` stored which photo a user last picked, but the
  builders had stopped calling the preference routes, so the columns only
  ever held defaults written by nobody who read them.
- **The anonymous path rested on it.** Stock was the only background a
  signed-out visitor could render, so the cut left anonymous visitors with
  the sign-up panel until launch Phase 7 rebuilds a free hero render.
