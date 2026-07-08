# PR212 — Video Object IDOR (C2) — TEST_RUN

Engineering/automated checklist for Replit. Transient — delete once run. The
UAT sibling (`PR212_VIDEO_OBJECT_IDOR_UAT.md`) is the durable half.

## Scope

Server-only. Closes a cross-user private-image disclosure (IDOR) in
`POST /videos/generate`, which re-hosted a caller-supplied storage object on
fal's public CDN without an access check.

- New `src/lib/objectAccess.ts` → `userCanReadObject()` — shared private-object
  READ authorization (object ACL + legacy `upload_image_metadata` owner
  fallback + ACL heal).
- `src/routes/storage.ts` — `GET /storage/objects` now calls the shared helper
  (behavior-preserving refactor).
- `src/routes/videos.ts` — authorizes the object READ via the helper **before**
  download / fal upload; 403 on denial; no more logging of private paths / CDN
  URLs.

No schema/migration change. No frontend change.

## Commands (run in `artifacts/api-server`)

```bash
# 1. Typecheck — must be clean
npx tsc -b

# 2. Targeted suites — expect all pass
node --import tsx/esm --test \
  src/__tests__/videos.security.test.ts \
  src/__tests__/routes.storage.test.ts \
  src/__tests__/uploadMeme.test.ts \
  src/__tests__/videoJobs.test.ts

# 3. Full api-server suite (sanity — no regressions)
pnpm --filter @workspace/api-server test
```

## Expected results

- **`videos.security.test.ts` (new)** — 5 tests pass:
  - ACL grants read → allowed,
  - legacy upload **owner** allowed when ACL denies, and the ACL is healed,
  - a **different** authenticated user → **denied** (IDOR closed),
  - unauthenticated caller → denied,
  - non-`/objects/uploads/` path → denied (fallback is uploads-scoped).
- **`routes.storage.test.ts`** — the object-serving ACL path (now backed by the
  shared helper) still passes; if it fails, the extraction in `objectAccess.ts`
  diverged from the original inline logic — compare against
  `git show <base>:artifacts/api-server/src/routes/storage.ts`.

## Behavioral check (optional, against a running server)

As a Legendary user A, note one of your own private upload URLs
(`/api/storage/objects/uploads/...` or `/memes/ai-user/image?storagePath=...`).
As a different Legendary user B, call `POST /videos/generate` with `imageUrl`
set to A's private path → expect **403** (`"You don't have access to that
image."`) and **no** video job created. As A, generating from A's own image
still works.

## Gotchas

- The ACL verdict (`canAccessObjectEntity`) reads GCS, so `videos.security.test.ts`
  passes a **stub** storage service to isolate the authorization logic — it does
  not exercise real GCS. The live behavioral check above covers the GCS path.
- Public objects remain readable/re-hostable by anyone (public = intended); the
  fix only gates **private** objects.

## Deliberately NOT shipped

- The private-**meme** slug/image owner-only enforcement (C3) is a separate PR
  (PR-2B). This PR is only the video-generator object read (C2).
