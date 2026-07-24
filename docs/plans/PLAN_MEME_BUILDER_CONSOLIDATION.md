# Meme Builder Consolidation (Image) — Store-the-Preview Fix + Privacy + One Builder

> **Approach decided by David (2026-07-24): store the user's preview image.**
> Root cause of the reported bugs is a regression: the old builder saved the
> *exact preview bitmap* the user saw (`previewImageBase64`); the new wizard
> dropped that and instead lets the server **re-draw** the meme from stored
> fields via `generateMemeBuffer` — a separate, unfaithful reimplementation of
> the client canvas. That re-draw is missing token substitution (the reported
> `{NAME}` bug), the orange name-highlight, `textColor`, and vertical position.
> Rather than re-implement the canvas on the server (the path rounds 3–7 of
> review kept finding new gaps in), we **restore the store-the-preview path**:
> the wizard sends the full-resolution rendered bitmap, the server stores and
> serves it. Saved = served = exported = exactly what the user saw, by
> construction. **Video is split to a separate rebuild** (appendix).

## Concrete symptoms (David's reports)

1. "We lost the ability to make memes private in the new meme builder."
2. Screenshot: a saved meme's image reads `{NAME} ONCE THREW A GRENADE...`
   literally, while the sidebar text on the same page renders correctly.

## Product intent

- The saved/downloaded/permalinked meme image must be **exactly what the user
  saw in the builder preview** — correct name/pronoun text (no raw tokens),
  orange name highlight, chosen colors, and text position.
- Legendary users can mark an image meme private again (unchanged behavior;
  `docs/PR213_PRIVATE_MEME_ACCESS_UAT.md`).
- One image builder: the wizard.

## Repo context inspected

- **The two pipelines.** `createMemeRecord.ts:302-359`: when the save payload
  carries `previewImageBase64`, the server NSFW-classifies that bitmap and
  uploads it as the meme image (`storedImageSource = null`). When it does NOT,
  the image is produced later by `generateMemeBuffer`. The **serve/export
  routes already prefer the stored bitmap**: `routes/memes.ts:622-624`,
  `761-763`, `891-893` try `memeKey(slug,"jpg")`/`png` first and only fall
  through to a `generateMemeBuffer` re-render (`:703`, `:818`, `:951`) when no
  stored bitmap exists. So the store-the-bitmap path is fully supported
  end-to-end; the wizard simply stopped using it.
- **Only the dead builder still sends it.** `previewImageBase64` is sent by
  exactly one component — the dead legacy `components/MemeBuilder.tsx`. The flat
  builder and the wizard don't, which is why wizard memes hit the unfaithful
  server re-draw and show raw tokens.
- **Privacy toggle** — still fully wired server-side, never migrated into the
  new UI: `memes.is_public` (`schema/memes.ts:23`), `meme_private_visibility`
  flag (`0013_feature_flags.sql:25-40`), `createMemeRecord.ts:170-175`
  (`canPrivate`/`isPublic`, currently always `true` because no client sends it),
  `memeBuilder.ts:159` (`isPublic` optional). Reference UI: dead
  `MemeBuilder.tsx:2116-2134`.
- **Remix/cold-permalink** — `MemePage.tsx:209-239` jumps into editing with the
  original's stock photo via `initialStockImageId`; the wizard has no
  equivalent prop.

## Settled decisions

1. The **wizard is the one image builder**, everywhere.
2. **Delete the legacy/duplicate builder frontend** (verified orphaned via
   import graph): `components/MemeBuilder.tsx` (dead), `meme-builder/MemeBuilder.tsx`
   (flat), `MemeStudio.tsx`, `pages/memePage/BuilderOverlay.tsx`, and the video-UI
   frontend orphaned by `MemeStudio`'s deletion (`MemeStudioVideoTab.tsx`,
   `MemeMagicVideo.tsx`, `VideoBuilder.tsx`), plus now-orphaned tests. **No video
   backend is touched** (appendix). An `rg` sweep is a gating acceptance check:
   no live import of any deleted component survives; the caller-less legacy
   `POST /api/videos/generate` route is documented as a known deferred orphan.
3. Remove the `VITE_MBFO_WIZARD` flag — the wizard ships on-by-default.
4. `FactDetail.tsx` and `MemePage.tsx` both mount `MemeBuilderWizard` directly.
5. Add `initialStockImageId` to the wizard so remix/cold-permalink keep their
   one-tap UX.
6. **PRIMARY FIX — the wizard sends the rendered bitmap.** On save, the wizard
   renders the final meme to a bitmap at **full output resolution** (the aspect
   ratio's real output dimensions, not the smaller on-screen preview canvas) and
   includes it as `previewImageBase64` in the `POST /api/memes` payload — the
   same mechanism the old builder used. The server already classifies and stores
   it, and the serve/export routes already prefer it. Result: the saved, served,
   and exported image is byte-identical to the preview — tokens, orange
   name-highlight, colors, and position all correct by construction, with **no
   server-side canvas re-implementation required.**
   - **Full-resolution render.** The wizard's compositing (today in
     `LivePreview`) must be reusable to produce the export-resolution bitmap, not
     just the preview canvas — so stored image quality matches the download the
     user expects. Reuse one client compositor for both preview and export.
   - **Moderation retained.** The uploaded bitmap stays NSFW-classified server-
     side (`createMemeRecord.ts:317-347`) — client bytes remain untrusted.
   - **Snapshot semantics (intended).** The meme is a fixed snapshot of what the
     user made; it does not re-render if the creator later edits their name/
     pronouns. This is the correct behavior for a shared meme.
7. **Idempotency key must include effective identity (kept from earlier review).**
   Independent of the store-the-bitmap fix: `createMemeRecord`'s idempotency key
   (`createMemeRecord.ts:229-237`) excludes name/pronouns, so two rapid saves of
   the same fact differing only by name/pronouns dedupe — the second saver would
   receive the first's meme (now the first's *bitmap*). Add `effectiveName` and
   `effectivePronouns` (resolved: request → profile fallback → `"___"`) as
   dedicated key fields. Test: two saves differing only by name/pronouns yield
   two distinct memes; byte-identical repeats still dedupe.
8. **Restore the legendary-gated Public/Private toggle** in the wizard's Step 2
   image flow (mirroring the dead builder's UX); add `isPublic` to
   `SaveMemePayload`/`buildSaveMemePayload()` so it reaches the existing
   `createMemeRecord` path.
9. **Server re-render (`generateMemeBuffer`) is now only a rare fallback** — it
   fires if the bitmap upload fails at save (`createMemeRecord.ts:356-358`) or
   when serving a meme that has no stored bitmap. Its fidelity gaps (unfaithful
   neopronoun forms, `textColor`/`topY`/`bottomY` schema drift, no orange
   name-highlight) are **documented as known degraded-mode limitations, not
   fixed here** — the stored bitmap is the source of truth, so these paths are
   effectively unreached for new wizard memes. (Hardening or retiring the server
   re-render is a possible future cleanup, out of scope.)

## What must NOT change

- Private-meme access-control (404-not-403, no social preview, no public cache).
- The split-slider UX.
- Video creation capability and all video backend (appendix).

## Source-of-truth analysis

| Concept | Source of truth |
|---|---|
| The saved meme image | The client-rendered bitmap (`previewImageBase64`) stored at save and served directly — not a server re-render |
| Whether an image meme is public | `memes.is_public` + `meme_private_visibility` flag (unchanged) |
| Idempotency | Key includes `effectiveName` + `effectivePronouns`, so name/pronoun differences never collapse |
| Which image builder is mounted | `MemeBuilderWizard`, unconditionally |
| Video backend | Unchanged by this PR (appendix) |

## Migration/backfill impact

Existing wizard memes saved through the server-re-render path have **no stored
bitmap**, so their permalink/export still re-renders (broken tokens). Pre-launch
(no real data to preserve): a one-time, idempotent cleanup **deletes image-meme
rows that have no stored bitmap and whose `text_options` carry an unresolved
token** (`hasUnresolvedFactTokens`). Safe to re-run. New saves all store bitmaps.

## Testing plan

- Save→serve→export end-to-end: a wizard meme with a name token, a neopronoun
  set, a non-default text color, and a moved vertical position produces a stored
  bitmap; `GET /api/memes/:slug/image` and the export routes return **that
  bitmap** (byte-identical), not a re-render — so tokens, orange highlight,
  color, and position all match the preview.
- Full-resolution: the stored bitmap is at output resolution, not the smaller
  preview canvas size.
- Moderation: an NSFW preview bitmap is rejected at save (classifier path).
- Idempotency: two saves differing only by name/pronouns → two distinct memes;
  identical repeats dedupe.
- `buildSaveMemePayload` includes `isPublic` when private is chosen; e2e re-run
  of the PR213 private-meme UAT (image).
- `initialStockImageId`: Step 1 skipped, Step 2 mounts with that photo selected.
- Stale-row cleanup: a bitmap-less raw-token meme row is deleted; a row with a
  stored bitmap is untouched; re-run is a no-op.
- `rg` deletion sweep: no live import of any deleted builder component remains.

## Risks

- **Full-resolution client render.** The wizard must render the export bitmap at
  true output dimensions (the old builder did this; reuse that approach). If it
  only captured the on-screen canvas, downloads would be low-res — call this out
  in implementation and test the stored bitmap's dimensions.
- Deleting the builder frontend touches every importer — the `rg` sweep guards it.
- `initialStockImageId` is new code in the well-tested `useWizardState`/
  `wizardStorage` area — needs its own coverage.

## Definition of done

- One image builder (wizard) mounted from `FactDetail.tsx` and `MemePage.tsx`;
  `VITE_MBFO_WIZARD` removed; builder frontend deleted; `rg` sweep clean.
- A meme saved through any image entry flow stores a **full-resolution bitmap**
  that the serve/export routes return directly — so the saved image is exactly
  the preview (tokens, orange highlight, color, position all correct).
- Two saves differing only by name/pronouns yield two distinct memes.
- Legendary users can toggle Public/Private on image memes (per PR213).
- Remix/cold-permalink jump to the pre-selected stock photo.
- Bitmap-less raw-token memes cleaned up.
- Video backend unchanged; video creation still works via the wizard.
- `check:docs` + relevant suites pass; TEST_RUN + UAT docs shipped with the PR.

---

## Carry-forward: video rebuild (findings to inherit — David, 2026-07-24)

Video is split out; this PR touches **zero video backend**. These verified
findings must shape the rebuild (to be promoted to a durable `docs/ai-context/`
note during implementation):

1. **Object-ownership IDOR (highest priority; live today).** The wizard route
   `POST /api/memes/video-jobs` regex-validates `sourceImagePath` only; the
   runner downloads that `/objects/...` path with no ownership check
   (`videoJobs.ts:120-138`, `videoPipelineRunner.ts:782,891`) — the legacy
   route authorized it. The rebuilt path MUST authorize source-object ownership,
   with a regression test.
2. **Resource governance.** The legacy route wraps generation in
   `enforceGovernance`/`completeGovernance` (per-user concurrency, spend/
   duration/payload caps, fal circuit-breaker); the wizard route has only a
   budget pre-check. The rebuild needs equivalent governance.
3. **Async lease lifecycle.** `startVideoJob` schedules the FAL pipeline via
   `setImmediate` (`videoPipelineRunner.ts:430,544`); a lease completed in the
   HTTP handler frees before the work runs. Acquire at job start, complete from
   the pipeline's terminal states.
4. **TTL/prune is a terminal state.** `stage1_review`/`stage1_no_face_review`
   jobs dropped by `pruneExpired()` after the 1-hour TTL must also release the
   governance lease, or the user stays throttled until restart.
5. **Video privacy.** Wizard video-jobs have no privacy field (`isPrivate:
   false`); the rebuild should design privacy in (parity with image `is_public`).
