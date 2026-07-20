# PR218 — Admin Input Validation (C9) — TEST_RUN

Engineering checklist for Replit. This PR adds bounded/zod validation to the
highest-risk admin handlers — most importantly a **path-traversal fix** on the
video-style preview-gif upload — using the repo's existing `safeParse` idiom.

Sibling doc: [`PR218_ADMIN_INPUT_VALIDATION_UAT.md`](./PR218_ADMIN_INPUT_VALIDATION_UAT.md).

## Commands

From `artifacts/api-server`:

```bash
pnpm run typecheck

# The new validation unit tests + the admin-auth suite (one assertion updated) +
# the existing import suite (must still pass under the new caps).
node --import tsx/esm --test \
  src/__tests__/admin.validation.security.test.ts \
  src/__tests__/routes.admin.auth.test.ts \
  src/__tests__/routes.import.test.ts
```

Expected: `typecheck` exits 0. The three files pass with **0 failures**
(locally: 8 validation + 143 admin-auth + 14 import). No new schema / migration.

## What the tests prove

`admin.validation.security.test.ts` (deterministic, no DB/routing):

- **Path-traversal guard** — `MotionPresetIdParam` rejects `..`, `../../evil`,
  `a/b`, `a.b`, `video/../x`, empty, uppercase, spaces, >64 chars, leading `-`;
  accepts normal slugs (`classic`, `zoom_1`, `slow-pan`).
- **Payload cap** — `PreviewGifBody` requires non-empty base64 and rejects
  >~7 MB (≈5 MB decoded).
- **set-password** — `SetPasswordBody` rejects malformed / >320-char emails,
  keeps the 8–128 password rule, and normalizes a valid email (trim +
  lowercase) so the DB lookup still matches.
- **Import caps** — `FactsImportBody` rejects empty / >1000-item arrays and
  >2000-char items; `ImportCsvBody` rejects empty / >2 MB payloads.

## Manual verification on the running app (you own the env)

The path-traversal fix is the one worth poking directly. With the API running
and an admin session (or the `ADMIN_API_KEY`):

```bash
# Traversal id → 400 "Invalid style id" BEFORE any object is written.
curl -sX POST https://<host>/api/admin/video-styles/..%2F..%2Fevil/preview-gif \
  -H 'content-type: application/json' -d '{"base64":"AAAA"}' -i | head -1

# Oversized import → 400 "Invalid input" (no rows inserted).
curl -sX POST https://<host>/api/admin/facts/import \
  -H 'content-type: application/json' \
  -d "{\"facts\":[$(python3 -c 'print(",".join(["\"x\""]*1001))')]}" -i | head -1
```

Confirm: a **valid** style id (e.g. `classic`) with a real base64 GIF still
uploads and sets the preview; a normal-size fact import still works.

## Deliberately NOT in this PR

- **Lower-risk field-length tidying** (video-style strings/colors, config
  value-length caps, per-field user bounds, feature-flag tier enum, UUID param
  guards). Defense-in-depth behind an admin session; deferred to keep the diff
  reviewable. Tracked as a follow-up.
- **`confirm`/`limit` gates on the API-key backfill launchers** — a behavior
  change that would break existing automation using the static key; belongs with
  a decision about scoping/rotating `ADMIN_API_KEY`, not this input sweep.
