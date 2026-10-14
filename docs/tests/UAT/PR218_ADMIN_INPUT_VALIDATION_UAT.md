# PR #218 — Admin Input Validation — UAT

This hardens a handful of **admin-panel** actions so they reject
malformed or oversized input instead of trusting it. The headline is a
real bug fix: the video-style **preview-GIF upload** could be tricked
into writing a file to the wrong place. Everything here is admin-only
and, for normal use, **invisible** — valid actions behave exactly as
before.

Four admin endpoints now check their input:

- **Video-style preview-GIF upload** — the style's id is now restricted
  to a safe format before it's used to name the stored file. (Previously
  a crafted id could escape the intended folder — the actual security fix
  here.)
- **Bulk fact import (paste list)** — now capped at **1000 facts per
  import**.
- **Bulk fact import (CSV)** — now capped at **~2 MB / 2000 rows per
  import**.
- **Admin "set password"** — now requires a properly-formatted email.

## Setup

- [david] Sign in as an admin.

## Steps

### 1. Video styles still work

**Do:** Edit a video style, upload a preview GIF, and save.

**Expect:** it still saves and shows the preview. (The id restriction
only blocks malformed ids you'd never type by hand.)

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — Video Styles are on the cut list and the admin screen is deleted there

### 2. Paste-list fact import still works

**Do:** Import a normal batch of facts using the paste-list import.

**Expect:** it still imports.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import`

### 3. CSV fact import still works

**Do:** Import a normal batch of facts using the CSV import.

**Expect:** it still imports.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv`

### 4. Set-password still works

**Do:** Use the admin "set password" action with a real email address.

**Expect:** it still works.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/localAuth.security.test.ts:C7: admin set-password minimum length`

**Deferred:** #631 — 7b — after the 200 the stored password hash verifies the new password, the test only checks status 200 — `artifacts/api-server/src/__tests__/localAuth.security.test.ts`

### 5. A huge paste-list import is refused

**Do:** Try importing more than 1000 facts at once via paste list.

**Expect:** a clear "too many / invalid input" error instead of it
grinding through. Splitting into smaller batches still works.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/admin.validation.security.test.ts:bulk-import size caps`

**Deferred:** #631 — 7b — over-1000 paste list returns 400 with nothing queued and exactly 1000 is accepted at the route, only the FactsImportBody schema is tested — `artifacts/api-server/src/__tests__/routes.admin.test.ts`

### 6. A huge CSV import is refused

**Do:** Try importing a CSV over ~2000 rows or ~2 MB.

**Expect:** a clear "too many / invalid input" error instead of it
grinding through. Splitting into smaller batches still works.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/admin.validation.security.test.ts:bulk-import size caps` `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv rejects an import of more than 2000 rows, by ROW COUNT and not by byte size`

**Deferred:** #631 — 7b — CSV over 2 MB by bytes returns 400 at the route with nothing queued, only the ImportCsvBody schema is tested — `artifacts/api-server/src/__tests__/routes.admin.test.ts`

### 7. A bad email on set-password is refused

**Do:** Use the admin set-password action with an obviously invalid
email (e.g. `notanemail`).

**Expect:** rejected with a validation error.

**Lane:** ci

**Deferred:** #631 — 7b — a malformed email such as notanemail returns 400 a valid email is required, only a missing email is tested — `artifacts/api-server/src/__tests__/localAuth.security.test.ts`

## Regression

### R1. Upload a preview GIF to a video style

**Do:** Upload a preview GIF to a video style and save.

**Expect:** saves, preview shows (as today).

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — Video Styles are on the cut list and the admin screen is deleted there

### R2. Import a normal batch of facts

**Do:** Import a normal batch of facts via both paste list and CSV.

**Expect:** imports (as today).

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import` `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv`

### R3. Set a user's password with a real email

**Do:** Set a user's password using a real email address.

**Expect:** works (as today).

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/localAuth.security.test.ts:C7: admin set-password minimum length`

**Deferred:** #631 — 7b — after the 200 the stored password hash verifies the new password, the test only checks status 200 — `artifacts/api-server/src/__tests__/localAuth.security.test.ts`

### R4. Import an oversized batch

**Do:** Import more than 1000 facts, or a CSV over the size/row cap.

**Expect:** rejected with a clear error (split it).

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/admin.validation.security.test.ts:bulk-import size caps` `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv rejects an import of more than 2000 rows, by ROW COUNT and not by byte size`

**Deferred:** #631 — 7b — over-1000 paste list and over-2 MB CSV are rejected at the route with nothing queued, only the schemas are tested for those two — `artifacts/api-server/src/__tests__/routes.admin.test.ts`

### R5. Set-password with a malformed email

**Do:** Set-password with a malformed email address.

**Expect:** rejected with a validation error.

**Lane:** ci

**Deferred:** #631 — 7b — a malformed email such as notanemail returns 400 a valid email is required, only a missing email is tested — `artifacts/api-server/src/__tests__/localAuth.security.test.ts`

## Not bugs

- **This is a focused pass, not every admin field.** The genuinely risky
  inputs were hardened (the path-traversal fix, the bulk-import caps, and
  the API-key-reachable set-password). Lower-risk field-length tidying
  across the rest of the admin panel is a tracked follow-up — nothing
  you'll notice.
- **The import caps are generous.** 1000 facts / 2000 CSV rows per call
  is well above a normal batch; if you ever hit them, just import in
  chunks.
- **No user-facing change.** Nothing outside the admin panel is affected.
