# Meme Studio

> The end-user-facing flow for actually making a meme: photo memes, the tier
> gates on them, and where the resulting media lives. (The file keeps its old
> name; video was deleted in launch Phase 4, removal 2, and AI image memes with
> PuLID in removal 3 — ledger [`docs/retired/README.md`](../retired/README.md),
> lessons [`docs/retired/video.md`](../retired/video.md) and
> [`docs/retired/pulid.md`](../retired/pulid.md).) **This is not the shared rendering machinery** — the Visual
> Concept, planner, and compiler that back AI image generation live in
> [`visual-pipeline.md`](./visual-pipeline.md); this spec covers the
> user-facing entry points into that machinery plus everything visual-pipeline
> doesn't own (photo memes, tier gates, storage). **This is not
> tier derivation either** — how `membershipTier` itself is computed lives in
> [`membership-entitlements.md`](./membership-entitlements.md); this spec
> only covers what each tier unlocks in the studio. Primary code:
> `artifacts/api-server/src/routes/memes.ts` (save, render),
> `artifacts/api-server/src/lib/createMemeRecord.ts` (the shared insert
> path), `artifacts/api-server/src/lib/storageKeys.ts` +
> `artifacts/api-server/src/lib/objectStorage.ts` (media storage).

## Frontend entry points (two live builders)

- **The fact page's wizard:** `components/meme-builder/wizard/MemeBuilderWizard.tsx`,
  mounted by `pages/FactDetail.tsx` on `/facts/:id/meme`. It opens directly on
  its image builder, `wizard/step2-image/Step2Image.tsx`; the image-or-video
  first step went with video.
- **The meme page's remix builder:** the universal builder
  `components/meme-builder/MemeBuilder.tsx`, mounted by
  `pages/memePage/BuilderOverlay.tsx` when a viewer taps the meme page's
  "make this about me" or anonymous "see it with my name" actions
  (`pages/MemePage.tsx`). It opens in `stock` or `self-upload` mode. Its
  Legendary stylise toggle and "Try AI mode" upsell went with PuLID (see *AI
  image memes*).

The legacy meme studio (`MemeStudio.tsx`, its legacy builder, video tab and
pickers, and the `VITE_MBFO_WIZARD` flag that chose between it and the wizard)
was deleted in launch Phase 4, removal 1, with the routes only it called
([`decisions.md`](./decisions.md#2026-10-22--the-legacy-meme-studio-is-deleted-the-user-generate-route-survives-photo-only-until-pulid-goes);
ledger: [`docs/retired/README.md`](../retired/README.md)). Its code and this
doc's description of it are at the `pre-cut/legacy-meme-studio` tag.

**Where the visibility (Public/Private) choice lives.** `VisibilityToggle`
(`meme-builder/parts/VisibilityToggle.tsx`), rendered next to the save action
in the wizard's image builder via `WizardPrimaryAction`'s `aboveAction` slot
(`step2-image/Step2Image.tsx`). It is not wired into the meme page's remix
builder (`components/meme-builder/MemeBuilder.tsx`).
It is set **at creation time only** — no route or UI changes a meme's
visibility afterwards. The client's lock is tier-only —
`tier !== "legendary"` — and does not consult the
`meme_private_visibility` feature flag (see *Tier gates*), so the "Private"
pill is locked-but-visible for every lower tier even when an operator has
granted that tier the flag via Admin → Features: tapping opens
`UnifiedUpgradeModal` and the private state is unreachable through this UI.
That keeps the control from ever offering a choice `createMemeRecord` would
now refuse outright (a 403, not a silent overwrite) — at the cost of also
hiding the choice from a tier the server would actually honor it for; that
combination has no UI path today.

## Backend entry point and the `imageSource` union

`POST /memes` (`memes.ts:268-354`) requires `req.isAuthenticated()` (401
otherwise, `memes.ts:270-273`) — **auth only, no tier check** for the base
save. It's a thin delegate (`memes.ts:282-286`) to `createMemeRecord()`
(`createMemeRecord.ts`), so every meme — however it was built — goes
through this one insert path.

**There is no distinct "AI image meme" `imageSource` type.** The type is a
discriminated union, `ImageSourceSchema` (`memeBuilder.ts:77-114`):

| `type` | What it represents | Bytes or pointer? |
| --- | --- | --- |
| `"template"` | Built-in gradient/template background | Pointer only (`templateId`) |
| `"stock"` | Pexels stock photo | Pointer only (`pexelsPhotoId`, optional cached `photoUrl`) |
| `"upload"` | User's own uploaded photo | Pointer (`uploadKey`) — bytes already landed via a separate upload call |
| `"identity"` | "Use my profile photo" | Resolved server-side into `"upload"` pointing at the stored profile photo (`createMemeRecord.ts:205-219`); 400 if none exists |

A `"video"` variant, written only by the video pipeline, went with video in
launch Phase 4; a stored video meme is a soft-deleted row (migration 0103).

An AI-*generated* image background was just a file in object storage — it
re-entered `createMemeRecord` as an `"upload"`-shaped `imageSource`, same as
any other upload, which is why the memes built on one still render. (The
per-fact AI gallery picker was the legacy studio's and was deleted with it;
the rest went with PuLID.) The `memes.image_transform` column (`"pulid"`,
`"pulid_fallback_text"`) marked a PuLID-stylized meme; no path has written it
since PuLID's removal, and the labels stay on old rows as history.
`templateId` is derived server-side from the source
(`"photo_stock"`, `"photo_upload"`, or the literal template id;
`createMemeRecord.ts:312-316`).

## Photo memes

Upload: `POST /storage/upload-meme` (`routes/storage.ts:105-125`), JPEG
only (415 otherwise, `userImageUpload.ts:92-96`), delegates to
`processAndStoreUserUpload(..., {variant:"meme"})` — the same pipeline
used for avatars (`userImageUpload.ts:16-24`). Bytes are stored verbatim, no server-side
resize/recompress (`storage.ts:96-100`); a row lands in
`upload_image_metadata` (schema `lib/db/src/schema/memes.ts:81-119`,
tracking width/height/size/Arachnid scan/`isProfile`/`transform`).

**The meme row itself never stores meme image bytes for a photo meme** —
`POST /memes` saves a *recipe* (`imageSource` pointer + text options), not
an image (`memes.ts:261-266`). Rendering happens on demand: `GET
/memes/:slug/image` (`memes.ts:601-731`) resolves the `imageSource`
(`memes.ts:685-701`), calls `generateMemeBuffer()`
(`artifacts/api-server/src/lib/memeGenerator.ts`), and serves the composited image. It's cached via
an ETag over the render-pipeline version + `createdAt` + a hash of the
rendered bytes (`memes.ts:705-715`), so a pipeline-version bump
invalidates every previously-cached render even against a 304. Private
memes get `setNoStore` instead of that public caching (`memes.ts:616-723`).

Pre-recipe-architecture memes (`imageSource === null`) are legacy and
served straight from a pre-rendered object instead
(`memeKey(slug, ext)`, branch at `memes.ts:619-655`).

Two structural safeguards on every save, independent of meme type: a
tier-differentiated daily save cap (`createMemeRecord.ts:221-247`) and a
short-lived idempotency check keyed on the caller + a canonicalized body
hash, so a double-click can't create duplicate rows
(`createMemeRecord.ts:50-77,249-270`). If the client sends a rendered
preview, it's classified for NSFW before persisting; a reject 422s and
quarantines rather than saving (`createMemeRecord.ts:318-371`).

## AI image memes

**There are none.** The last user path to an AI image, PuLID face-in-scene
stylising (the wizard's "AI you" source through `/memes/pulid-jobs`, and the
remix builder's stylise toggle through `POST /memes/ai/:factId/generate`), was
deleted in launch Phase 4, removal 3, with the `meme_pulid_stylize` and
`meme_ai_background` features (migration 0104). Launch Phase 7 rebuilds
face-in-scene on a newer model. The record is the ledger row and
[`docs/retired/pulid.md`](../retired/pulid.md); the code is at the
`pre-cut/pulid` tag.

The legacy studio's AI image routes — the no-photo branch of `generate`,
`generate-v2`, `analyze-source`, the user render poll
`GET /memes/ai/renders/:renderJobId`, the per-fact AI image read and delete
`GET`/`DELETE /memes/ai/:factId/image`, and the admin scene-prompt pair —
were deleted with it (removal 1). Migration 0102 retired their queued user
render jobs. The per-fact `facts.aiMemeImages` arrays those routes served are
still written by the render pipeline and the AI background backfill; nothing
on the public site reads them now, and they are an orphan candidate for
removal 11. The generate paths lived in `routes/memes.ts`, not
`routes/ai.ts` — `routes/ai.ts` is fact-authoring tooling (duplicate-check,
tokenize-fact, admin enrichment tokenization), not a meme-creation surface.

## Tier gates

`requireRole("admin"|"legendary"|"registered")`
(`tierMiddleware.ts:19-58`) uses `req.user.realUserRole` — DB truth,
ignores the admin "view as user" toggle. `requireLegendary` is a shim for
`requireRole("legendary")` (`tierMiddleware.ts:64`).

**Gated to Legendary (or admin):** every one of these now resolves through
`featureAccess.ts` rather than a role comparison, so the grid is the place to
change them. Private meme visibility (Legendary-level by
default, or any tier an operator has separately granted the
`meme_private_visibility` feature flag via Admin → Features — a caller with
neither who explicitly requests `isPublic: false` gets a 403, not a silent
downgrade to public. See
[`membership-entitlements.md`](membership-entitlements.md)'s reader
inventory for why the role-vs-tier resolution matters,
`createMemeRecord.ts:174-202`); the higher daily-save-cap /
higher-rate-limit tier feature.

**NOT gated by tier (auth-only):** `POST /memes` itself — any
authenticated user, not Legendary-only. Template/stock/upload/identity
`imageSource` types carry no tier check in `createMemeRecord`. An unauthenticated caller can preview/download a
stock-mode meme via `POST /api/render-download` but cannot save
(`meme-builder/MemeBuilder.tsx`, the meme page's remix builder).

**Vestigial gate — flag before touching this area:** a `meme_upload_photo`
tier feature flag exists in `tier_feature_permissions` (seeded and later
flipped on for `registered` by two migrations), but **no route or
`createMemeRecord` code path reads it anywhere** (repo-wide grep finds
only the migration files). Photo-upload meme creation is, in the actual
code today, gated by nothing beyond authentication. **Needs David
confirmation** on whether this is a removed check or an
intended-but-never-wired one before relying on either reading.

## Where media actually lives

`ObjectStorageService` (`artifacts/api-server/src/lib/objectStorage.ts`) wraps GCS via a Replit
sidecar credential exchange (`objectStorage.ts:13-31`) — still the live
storage backend today, not legacy.

| Content | Stored (real bytes)? | Key builder |
| --- | --- | --- |
| Photo-meme background (upload) | Yes | `uploadKey()`, `storageKeys.ts:41-47` — `uploads/{hash2}/{uploadId}.{ext}` |
| Stock/template background | No — pointer, re-resolved at render time | — |
| Rendered meme image (recipe meme) | No — rendered on demand, cache only at the HTTP layer | — |
| Pre-recipe-architecture legacy meme | Yes | `memeKey()`, `storageKeys.ts:33-38` — `memes/{hash2}/{slug}.{ext}` |
| AI-generated meme background (shared gallery) | Yes | `aiBackgroundKey()`, `storageKeys.ts:14-29` — `ai-backgrounds/{hash2}/{factId}-{gender}-{uniqueKey}.{ext}` |
| Zazzle merch export | Yes, public ACL | inline at `memes.ts` (`zazzle-export`, `zazzle-redirect`) — `meme-exports/{slug}-v{MEME_RENDER_VERSION}.jpg` (render-versioned since PR #398 round 3, so a corrected re-export never collides with a stale edge-cached copy of an earlier render) |

The `{hash2}` path segment is a 2-hex-char SHA-256 prefix of the filename
(`hashPrefix()`, `storageKeys.ts:6-11`), used to avoid sequential-prefix
hotspotting on the bucket — not a security or ownership mechanism.

**Ownership is not the object ACL.** `user_ai_images` rows carry a
**public** object ACL by design — the real authorization gate is
`userOwnsAiReferenceImage()` (`artifacts/api-server/src/lib/objectAccess.ts`), used by the AI-user-image
read route (`GET /memes/ai-user/image`, the Library page's historical AI
images). Uploads instead authorize via
`userCanReadObject()` — ACL first, then a legacy upload-owner-table
fallback that also heals a missing ACL when it fires.

**Admin hard-delete cleanup gap:** `DELETE /admin/users/:id?hard=true`
(`admin.ts:462-581`) collects and deletes every AI-image storage path and
every `"upload"`-typed meme's storage object before nulling
`createdById`. (Video artifacts were the one meme type it skipped; video was
deleted in launch Phase 4 and its MP4s and stills were left unreferenced in
storage — see [`docs/retired/video.md`](../retired/video.md).)

## Files to inspect before studio/media work

- `artifacts/api-server/src/routes/memes.ts` — save, render, Zazzle export.
- `artifacts/api-server/src/lib/createMemeRecord.ts` — the single shared
  insert path every meme type goes through.
- `artifacts/api-server/src/lib/validators/memeBuilder.ts` —
  `ImageSourceSchema`, the discriminated union.
- `artifacts/api-server/src/lib/storageKeys.ts` +
  `artifacts/api-server/src/lib/objectStorage.ts` — key patterns, GCS
  access.
- `artifacts/api-server/src/lib/objectAccess.ts` — real ownership checks
  (`userOwnsAiReferenceImage`, `userCanReadObject`), distinct from the
  object ACL.
- `artifacts/api-server/src/middlewares/tierMiddleware.ts` — `requireRole`
  / `requireLegendary`.
- `artifacts/api-server/src/routes/admin.ts` — hard-delete storage
  cleanup.
- Frontend: `components/meme-builder/wizard/` (the fact page's wizard),
  `components/meme-builder/MemeBuilder.tsx` + `pages/memePage/BuilderOverlay.tsx`
  (the meme page's remix builder).
- Tests: `__tests__/createMemeRecord.test.ts`, `__tests__/tierMiddleware.test.ts`.
- For *what a tier is derived from*, not *what it unlocks here*:
  [`membership-entitlements.md`](./membership-entitlements.md). For the
  shared rendering machinery behind AI image generation:
  [`visual-pipeline.md`](./visual-pipeline.md).
