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

**Check:** `artifacts/api-server/src/__tests__/localAuth.security.test.ts:C7: admin set-password minimum length`; `artifacts/api-server/src/__tests__/localAuth.security.test.ts:stores a hash that verifies the new password after a 200`

### 5. A huge paste-list import is refused

**Do:** Try importing more than 1000 facts at once via paste list.

**Expect:** a clear "too many / invalid input" error instead of it
grinding through. Splitting into smaller batches still works.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/admin.validation.security.test.ts:bulk-import size caps`; `artifacts/api-server/src/__tests__/routes.admin.test.ts:rejects 1001 valid facts with 400 Invalid input and queues none of them`; `artifacts/api-server/src/__tests__/routes.admin.test.ts:accepts exactly 1000 facts and processes all of them — the cap is inclusive`

### 6. A huge CSV import is refused

**Do:** Try importing a CSV over ~2000 rows or ~2 MB.

**Expect:** a clear "too many / invalid input" error instead of it
grinding through. Splitting into smaller batches still works.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/admin.validation.security.test.ts:bulk-import size caps` `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv rejects an import of more than 2000 rows, by ROW COUNT and not by byte size`; `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv accepts an import of exactly 2000 rows — the cap is inclusive` — a batch at the cap is accepted and every row processed; `artifacts/api-server/src/__tests__/routes.admin.test.ts:rejects a csv over 2,000,000 characters (but under the 2 MiB limit and 2000 rows) with 400 Invalid input and queues nothing`

### 7. A bad email on set-password is refused

**Do:** Use the admin set-password action with an obviously invalid
email (e.g. `notanemail`).

**Expect:** rejected with a validation error.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/localAuth.security.test.ts:rejects a malformed email with 400 'a valid email is required'`

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

**Check:** `artifacts/api-server/src/__tests__/localAuth.security.test.ts:C7: admin set-password minimum length`; `artifacts/api-server/src/__tests__/localAuth.security.test.ts:stores a hash that verifies the new password after a 200`

### R4. Import an oversized batch

**Do:** Import more than 1000 facts, or a CSV over the size/row cap.

**Expect:** rejected with a clear error (split it).

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/admin.validation.security.test.ts:bulk-import size caps` `artifacts/api-server/src/__tests__/routes.admin.test.ts:POST /admin/facts/import-csv rejects an import of more than 2000 rows, by ROW COUNT and not by byte size`; `artifacts/api-server/src/__tests__/routes.admin.test.ts:rejects 1001 valid facts with 400 Invalid input and queues none of them`; `artifacts/api-server/src/__tests__/routes.admin.test.ts:rejects a csv over 2,000,000 characters (but under the 2 MiB limit and 2000 rows) with 400 Invalid input and queues nothing`

### R5. Set-password with a malformed email

**Do:** Set-password with a malformed email address.

**Expect:** rejected with a validation error.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/localAuth.security.test.ts:rejects a malformed email with 400 'a valid email is required'`

## Not bugs

- **This is a focused pass, not every admin field.** The genuinely risky
  inputs were hardened (the path-traversal fix, the bulk-import caps, and
  the API-key-reachable set-password). Lower-risk field-length tidying
  across the rest of the admin panel is a tracked follow-up — nothing
  you'll notice.
- **The import caps are generous.** 1000 facts / 2000 CSV rows per call
  is well above a normal batch; if you ever hit them, just import in
  chunks.
- **A CSV over about 2 MB gets a generic server error, not the clear
  message.** The server's 2 MiB request limit rejects it before the import
  route runs. Accepted by David on 2026-10-15: the import is only ever used
  for a few hundred rows (`decisions.md`, 2026-10-15). A CSV just over the
  2,000,000-character cap but under 2 MiB still gets the clear error.
- **No user-facing change.** Nothing outside the admin panel is affected.
