# PR218 — Admin Input Validation (C9) — UAT

In-app acceptance test for David. This hardens a handful of **admin-panel**
actions so they reject malformed or oversized input instead of trusting it. The
headline is a real bug fix: the video-style **preview-GIF upload** could be
tricked into writing a file to the wrong place. Everything here is admin-only
and, for normal use, **invisible** — valid actions behave exactly as before.

Sibling doc (for Replit): [`PR218_ADMIN_INPUT_VALIDATION_TEST_RUN.md`](./PR218_ADMIN_INPUT_VALIDATION_TEST_RUN.md).

## What changed, in plain terms

Four admin endpoints now check their input:

1. **Video-style preview-GIF upload** — the style's id is now restricted to a
   safe format before it's used to name the stored file. (Previously a
   crafted id could escape the intended folder — the actual security fix here.)
2. **Bulk fact import (paste list)** — now capped at **1000 facts per import**.
3. **Bulk fact import (CSV)** — now capped at **~2 MB / 2000 rows per import**.
4. **Admin "set password"** — now requires a properly-formatted email.

## How to check it (in the admin panel)

Everything valid should work **exactly as today**:

1. **Video styles still work.** Edit a video style, upload a preview GIF, save.
   It still saves and shows the preview. (The id restriction only blocks
   malformed ids you'd never type by hand.)
2. **Fact import still works.** Import a normal batch of facts (paste list and
   CSV). Still imports.
3. **Set-password still works.** Use the admin set-password action with a real
   email address. Still works.

New guard rails you *can* trigger on purpose:

4. **Huge import is refused.** Try importing **more than 1000 facts** at once
   (or a CSV over ~2000 rows / 2 MB) → you get a clear "too many / invalid
   input" error instead of it grinding. Split into smaller batches — that
   still works.
5. **Bad email is refused.** Admin set-password with an obviously invalid email
   (e.g. `notanemail`) → rejected with a validation error.

## What you should NOT see

- Any **valid** admin action behaving differently than before.
- A normal-size import or a real preview-GIF upload getting rejected.
- Any change outside the admin panel (this PR touches only admin endpoints).

## Regression smoke table

| Admin action | Expect |
|--------------|--------|
| Upload a preview GIF to a video style | Saves, preview shows (as today) |
| Import a normal batch of facts (list + CSV) | Imports (as today) |
| Set a user's password with a real email | Works (as today) |
| Import **>1000** facts / a huge CSV | Rejected with a clear error (split it) |
| Set-password with a malformed email | Rejected with a validation error |

## Known non-bugs / limitations

- **This is a focused pass, not every admin field.** I hardened the genuinely
  risky inputs (the path-traversal fix, the bulk-import caps, and the
  API-key-reachable set-password). Lower-risk field-length tidying across the
  rest of the admin panel is a tracked follow-up — nothing you'll notice.
- **The import caps are generous.** 1000 facts / 2000 CSV rows per call is well
  above a normal batch; if you ever hit them, just import in chunks.
- **No user-facing change.** Nothing outside the admin panel is affected.

## If something's wrong

Tell me which admin action, what you entered, and the exact error text — and if
a *valid* action got rejected, that's a bound set too tight and I'll loosen it.
