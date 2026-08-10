# Meme and Video Studio

> The end-user-facing flow for actually making a meme: photo memes, AI image
> memes, AI video memes, the tier gates on each, and where the resulting
> media lives. **This is not the shared rendering machinery** — the Visual
> Concept, planner, and compiler that back AI image generation live in
> [`visual-pipeline.md`](./visual-pipeline.md); this spec covers the
> user-facing entry points into that machinery plus everything visual-pipeline
> doesn't own (photo memes, video memes, tier gates, storage). **This is not
> tier derivation either** — how `membershipTier` itself is computed lives in
> [`membership-entitlements.md`](./membership-entitlements.md); this spec
> only covers what each tier unlocks in the studio. Primary code:
> `artifacts/api-server/src/routes/memes.ts` (save, AI generate, render),
> `artifacts/api-server/src/routes/videoJobs.ts` +
> `artifacts/api-server/src/lib/videoPipelineRunner.ts` (async video),
> `artifacts/api-server/src/routes/videos.ts` (legacy sync video),
> `artifacts/api-server/src/lib/createMemeRecord.ts` (the shared insert
> path), `artifacts/api-server/src/lib/storageKeys.ts` +
> `artifacts/api-server/src/lib/objectStorage.ts` (media storage).

## Frontend entry points (one is dead code today, kept for reference)

Which UI mounts is a build-time flag, `VITE_MBFO_WIZARD`
(`FactDetail.tsx:30`, checked at `FactDetail.tsx:117-144,423-461`). **The flag
is pinned on, not runtime-configurable in this repo:**
`artifacts/overhype-me/.env.local` is committed to git (force-added — the
repo's `.gitignore` excludes `.env*` generally) and sets
`VITE_MBFO_WIZARD=1`; nothing else in the repo (`.replit`, `replit.nix`, any
CI workflow) ever sets or overrides it. So the Legacy branch below can never
render in any build — dev or deployed — of this repo as it stands. Don't read
the split as "two live paths"; verify with `git ls-files
artifacts/overhype-me/.env.local` before assuming otherwise, since flipping
that one committed line is all it would take to change this.

- **Legacy, currently unreachable** (`MBFO_WIZARD_ENABLED` false):
  `MemeStudio.tsx` — a hub of path cards (`photo-image`, `ai-gallery`,
  `stock-image`, `gradient-image`, `magic-video`, `manual-video`,
  `MemeStudio.tsx:62-69`). Image paths route through `NewBuilderAdapter`
  (`MemeStudio.tsx:634-708`) into `components/meme-builder/MemeBuilder.tsx` —
  **not** the older, no-longer-mounted duplicate at `components/MemeBuilder.tsx`
  (legacy, per its own header comment — that one is unreachable from *any*
  flag state, not just this one). Video paths go to `MemeStudioVideoTab.tsx`
  (manual) or `MemeMagicVideo.tsx` (magic).
- **New wizard, the only live path** (`MBFO_WIZARD_ENABLED` true):
  `components/meme-builder/wizard/MemeBuilderWizard.tsx`; its video step is
  `wizard/step2-video/Step2Video.tsx`.

Both flows converge on the same backend, so this only matters for *frontend*
work — a backend/route change still needs to consider both callers. A
frontend change (like the visibility control below) only needs the wizard.

**Where the visibility (Public/Private) choice lives.** `VisibilityToggle`
(`meme-builder/parts/VisibilityToggle.tsx`), rendered next to the save action
in the wizard's Step 2 via `WizardPrimaryAction`'s `aboveAction` slot
(`step2-image/Step2Image.tsx`). Not wired into the single-screen builder —
per the dead-path note above, it can't be reached, so there's nothing to wire.
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
combination has no UI path today. **Video memes
have no visibility control** — `POST /memes/video-jobs`'s `StartBody` accepts
no privacy field and `videoPipelineRunner` calls `createMemeRecord` without
`isPublic`, so every video meme is public (the retired `MemeStudioVideoTab`
had one, wired to the legacy sync `/videos` route's `isPrivate`).

## Backend entry point and the `imageSource` union

`POST /memes` (`memes.ts:268-354`) requires `req.isAuthenticated()` (401
otherwise, `memes.ts:270-273`) — **auth only, no tier check** for the base
save. It's a thin delegate (`memes.ts:282-286`) to `createMemeRecord()`
(`createMemeRecord.ts:139-445`), which the async video pipeline also calls
directly (bypassing HTTP), so every meme — however it was built — goes
through this one insert path.

**There is no distinct "AI image meme" `imageSource` type.** The type is a
discriminated union, `ImageSourceSchema` (`memeBuilder.ts:77-114`):

| `type` | What it represents | Bytes or pointer? |
| --- | --- | --- |
| `"template"` | Built-in gradient/template background | Pointer only (`templateId`) |
| `"stock"` | Pexels stock photo | Pointer only (`pexelsPhotoId`, optional cached `photoUrl`) |
| `"upload"` | User's own uploaded photo | Pointer (`uploadKey`) — bytes already landed via a separate upload call |
| `"identity"` | "Use my profile photo" | Resolved server-side into `"upload"` pointing at the stored profile photo (`createMemeRecord.ts:205-219`); 400 if none exists |
| `"video"` | AI video meme | Pointer (`videoJobId`, `videoObjectPath`, `stillObjectPath`, `lookStyleId`, `motionPresetId`) — bytes already produced by the video pipeline |

An AI-*generated* image background is just a file in object storage the
user picks via the AI Gallery — it re-enters `createMemeRecord` as an
`"upload"`-shaped `imageSource`, same as any other upload. The separate
`imageTransform: "pulid"` flag marks a meme as PuLID-stylized for
analytics/tier-gating (`createMemeRecord.ts:417`), independent of
`imageSource.type`. `templateId` is derived server-side from the source
(`"photo_stock"`, `"photo_upload"`, `"video"`, or the literal template id;
`createMemeRecord.ts:312-316`).

## Photo memes

Upload: `POST /storage/upload-meme` (`routes/storage.ts:105-125`), JPEG
only (415 otherwise, `userImageUpload.ts:92-96`), delegates to
`processAndStoreUserUpload(..., {variant:"meme"})` — the same pipeline
used for avatars, AI reference photos, and video frames
(`userImageUpload.ts:16-24`). Bytes are stored verbatim, no server-side
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

Both user-facing generate routes live in `routes/memes.ts`, not
`routes/ai.ts` — `routes/ai.ts` is fact-authoring tooling (duplicate-check,
tokenize-fact, admin enrichment tokenization), not a meme-creation surface.

- **`POST /memes/ai/:factId/generate`** (`memes.ts:1280-1550`,
  `requireLegendary`). Two branches: a **reference-image branch**
  (`memes.ts:1404-1467`, synchronous, calls
  `generateAiMemeBackgroundFromReference()` in `aiMemePipeline.ts`,
  returns `{objectPath}` directly) and a **generic branch** (no reference
  image, `memes.ts:1468-1534`) that goes through the same async attempt
  pipeline as `generate-v2` below and returns 202.
- **`POST /memes/ai/:factId/generate-v2`** (`memes.ts:1734-1900`,
  `requireLegendary`) — the flow reference-photo uploads always use
  (`memes.ts:1644-1650`). Validates the source image, resolves
  `subjectRenderMode`/`generationMode`, freezes identity+style (the same
  "frozen render inputs" contract as `visual-pipeline.md`), enqueues an
  `image_prompt_generation` job, returns 202 `{renderJobId, attemptId}`.
- **`POST /memes/ai/:factId/analyze-source`** (`memes.ts:1690-1732`,
  `requireLegendary`) — pre-flight source-image analysis.
- **Polling** (client-side `setTimeout` loop, not websocket — confirmed at
  `AiBgPicker.tsx:622-699`): `GET /memes/ai/renders/:renderJobId`
  (`memes.ts:1902-1938`) reads the `imagePromptAttempts` row, 403s a
  non-owner, 404s an admin-moderation-review row, returns
  `buildRenderStatusPayload()`, whose status union is `"pending" |
  "prompt_ready" | "image_ready" | "failed" | "blocked"`.
- **Where it lands:** `facts.aiMemeImages[gender]`, a **per-fact jsonb
  array shared across every user who views that fact** — not private to
  the generator (`imagePromptJobs.ts:648-689`, row-locked to avoid
  clobbering concurrent completions), plus a `user_ai_images` row for
  per-generation ownership tracking. Served by `GET
  /memes/ai/:factId/image` (`memes.ts:1044-1148`).
- **Deletion:** `DELETE /memes/ai/:factId/image` (`memes.ts:1576-1639`,
  `requireLegendary`), ownership-checked against `user_ai_images`,
  fail-closed (storage delete must succeed before the DB row is touched).
- **Storage cap:** AI-generated + uploaded images together are capped
  against `admin_config.user_max_images` (`aiMemePipeline.ts:144,346-356`);
  at/over → 429 `limitExceeded` (`memes.ts:1332-1339`).

## AI video memes — two live systems

### A. Legacy synchronous single-shot: `POST /videos/generate`

`routes/videos.ts:354-796`. Used by the legacy `MemeStudioVideoTab.tsx`
(both Magic and Manual paths). Gated by `hasFeature(tier,
"video_generation")` unless admin (403 `VIDEO_GENERATION_LOCKED`,
`videos.ts:407-423`), IP-rate-limited. Calls `fal.subscribe()` and
**blocks the HTTP request until the video finishes** — writes a
`video_jobs` row `pending` → `completed`/`failed` within one request
(`videos.ts:532-694`). **The frontend "progress bar" here is a fabricated
client-side time-based simulation** (`MemeStudioVideoTab.tsx:329-336`),
not real server state — this path has no status polling.

### B. Async multi-stage pipeline: `POST /memes/video-jobs`

`routes/videoJobs.ts`, orchestrated by
`artifacts/api-server/src/lib/videoPipelineRunner.ts`. Used by the new wizard
(`step2-video/Step2Video.tsx` → `GodModeLoadingTakeover.tsx`), mounted as
a sibling of `/api/memes`.

Endpoints (`videoJobs.ts:11-16`, all auth-required, 401 otherwise):
`POST /memes/video-jobs` (start; tier gate at `videoJobs.ts:91-105` — admin
exempt, else Legendary or the `video_generation` feature flag), `GET
/memes/video-jobs/:jobId` (poll; **404, never 403, for a non-owner** to
avoid leaking which job IDs exist, `videoJobs.ts:18-22`), `POST
.../proceed` (advance past the Stage-1 checkpoint), `POST
.../regenerate` (re-run Stage 1 with a new look), `POST
.../proceed-with-no-face-fallback`, `DELETE .../:jobId` (cancel; promotes
the stylized still if one exists).

Phase state machine (`videoPipelineRunner.ts:27-53,101-111`):

```
queued → stage1_pulid → stage1_review (checkpoint) → stage2_video → stage2_subtitle → uploading → completed
              │no-face
              └→ stage1_no_face_review
```

`sourceMode` (`"stylize-then-video" | "use-photo-as-is" |
"use-existing-ai-image"`) — only the first runs Stage 1 at all; the other
two skip straight to stage2. Terminal states: `completed`, `failed`,
`canceled`. Job state is in-memory (TTL-bounded,
`videoPipelineRunner.ts:266-267`) backed by a persistent `video_jobs` row
(`lib/db/src/schema/videoJobs.ts:20-77`) so cancelled/expired in-memory
state still leaves an audit trail (per-stage cost, engine ids,
checkpoint/proceeded/completed timestamps).

**Status shown to the user is real server-computed progress via polling**
(confirmed at `GodModeLoadingTakeover.tsx:63-190`, `api.poll(jobId)` →
`GET /memes/video-jobs/:jobId`), not a fabrication like path A —
`computeProgress()` (`videoPipelineRunner.ts:229-262`) is a per-phase
asymptotic curve, not a static floor.

**On completion**, the pipeline calls `createMemeRecord()` directly (not
via HTTP) with the `"video"`-typed `imageSource` — same shared insert path
as every other meme type (confirmed:
`createMemeRecord.test.ts:123-162`'s "video variant" assertions).

Legacy `GET /video/:videoId` / `GET /videos/:factId`
(`videos.ts:238-352`) serve only completed, non-private-or-owned
`video_jobs` rows — they back path A's history view, not path B's job
polling.

## Tier gates

`requireRole("admin"|"legendary"|"registered")`
(`tierMiddleware.ts:19-58`) uses `req.user.realUserRole` — DB truth,
ignores the admin "view as user" toggle. `requireLegendary` is a shim for
`requireRole("legendary")` (`tierMiddleware.ts:64`).

**Gated to Legendary (or admin):** all AI image generation (`generate`,
`generate-v2`, `analyze-source`, image delete); all AI video (both
systems, via `hasFeature`/`isAtLeastLegendary`); PuLID-stylized photo
memes (`imageTransform: "pulid"` → 403 `tier_mismatch` if not qualified,
`createMemeRecord.ts:188-191`); private meme visibility (Legendary-level by
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
`imageSource` types carry no tier check in `createMemeRecord` beyond the
PuLID case above. An unauthenticated caller can preview/download a
stock-mode meme via `POST /api/render-download` but cannot save
(`meme-builder/MemeBuilder.tsx:174-177`).

**Vestigial gate — flag before touching this area:** a `meme_upload_photo`
tier feature flag exists in `tier_feature_permissions` (seeded and later
flipped on for `registered` by two migrations), but **no route or
`createMemeRecord` code path reads it anywhere** (repo-wide grep finds
only the migration files). Photo-upload meme creation is, in the actual
code today, gated by nothing beyond authentication. **Needs David
confirmation** on whether this is a removed check or an
intended-but-never-wired one before relying on either reading.

## Where media actually lives

`ObjectStorageService` (`lib/objectStorage.ts`) wraps GCS via a Replit
sidecar credential exchange (`objectStorage.ts:13-31`) — still the live
storage backend today, not legacy.

| Content | Stored (real bytes)? | Key builder |
| --- | --- | --- |
| Photo-meme background (upload) | Yes | `uploadKey()`, `storageKeys.ts:41-47` — `uploads/{hash2}/{uploadId}.{ext}` |
| Stock/template background | No — pointer, re-resolved at render time | — |
| Rendered meme image (recipe meme) | No — rendered on demand, cache only at the HTTP layer | — |
| Pre-recipe-architecture legacy meme | Yes | `memeKey()`, `storageKeys.ts:33-38` — `memes/{hash2}/{slug}.{ext}` |
| AI-generated meme background (shared gallery) | Yes | `aiBackgroundKey()`, `storageKeys.ts:14-29` — `ai-backgrounds/{hash2}/{factId}-{gender}-{uniqueKey}.{ext}` |
| AI video: stylized still (Stage 1) | Yes | `video_jobs.stylizedStillObjectPath` |
| AI video: final captioned video | Yes | `video_jobs.videoUrl` (sync path) / `videoObjectPath` on the meme row (async path) |
| Zazzle merch export | Yes, public ACL | inline at `memes.ts:822-827` — `meme-exports/{slug}.jpg` |

The `{hash2}` path segment is a 2-hex-char SHA-256 prefix of the filename
(`hashPrefix()`, `storageKeys.ts:6-11`), used to avoid sequential-prefix
hotspotting on the bucket — not a security or ownership mechanism.

**Ownership is not the object ACL.** `user_ai_images` rows carry a
**public** object ACL by design (`videos.ts:110-121`) — the real
authorization gate is `userOwnsAiReferenceImage()`
(`lib/objectAccess.ts`), used identically by the AI-user-image read route
and the video generator's re-hosting logic. Uploads instead authorize via
`userCanReadObject()` — ACL first, then a legacy upload-owner-table
fallback that also heals a missing ACL when it fires (confirmed:
`videos.security.test.ts`).

**Admin hard-delete cleanup gap:** `DELETE /admin/users/:id?hard=true`
(`admin.ts:462-581`) collects and deletes every AI-image storage path and
every `"upload"`-typed meme's storage object before nulling
`createdById`, but **does not delete video artifact storage**
(`videoObjectPath`/`stillObjectPath`) for `"video"`-typed memes — the
cleanup loop only branches on `imageSource === null` or `type ===
"upload"` (`admin.ts:501-510`); `video_jobs.userId` is nulled but the
job's own storage objects are left in place. **Needs David confirmation**
on whether this is accepted debt or an oversight before treating
hard-delete as comprehensive across every meme type.

## Files to inspect before studio/media work

- `artifacts/api-server/src/routes/memes.ts` — save, AI generate
  (`generate`/`generate-v2`/`analyze-source`), render, AI image gallery
  read/delete, Zazzle export.
- `artifacts/api-server/src/routes/videoJobs.ts` +
  `lib/videoPipelineRunner.ts` — the async multi-stage video pipeline.
- `artifacts/api-server/src/routes/videos.ts` — the legacy synchronous
  video path and its history/gallery reads.
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
  cleanup (and its video-artifact gap).
- Frontend: `components/MemeStudio.tsx` (legacy hub, currently unreachable —
  see *Frontend entry points* above),
  `components/meme-builder/MemeBuilder.tsx` (universal builder, same —
  reachable only through the legacy hub),
  `components/meme-builder/wizard/` (the wizard — the only live path),
  `components/MemeStudioVideoTab.tsx` / `MemeMagicVideo.tsx` (legacy
  video UI, same), `components/meme-builder/wizard/step2-video/Step2Video.tsx`
  + `GodModeLoadingTakeover.tsx` (new video UI), `components/AiBgPicker.tsx`
  (AI image polling).
- Tests: `__tests__/createMemeRecord.test.ts`, `__tests__/videoJobs.test.ts`,
  `__tests__/videos.security.test.ts`, `__tests__/tierMiddleware.test.ts`.
- For *what a tier is derived from*, not *what it unlocks here*:
  [`membership-entitlements.md`](./membership-entitlements.md). For the
  shared rendering machinery behind AI image generation:
  [`visual-pipeline.md`](./visual-pipeline.md).
