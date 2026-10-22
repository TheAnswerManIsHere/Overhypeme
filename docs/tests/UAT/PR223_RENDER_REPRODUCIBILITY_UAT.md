# PR #223 — Render identity/style reproducibility — UAT

When you click **generate**, the image engine now gets a **frozen** copy of
*who* the render is about and *which style* it uses — captured at the moment
you click, not re-looked-up minutes later while the render sits in the
queue. Editing your profile name or a style **after** you click can no
longer quietly change a render already in flight; your *next* render picks
up the new values. (Before this PR, an edit in that window could produce a
render whose text and whose identity disagreed.) As part of the same
change, the name fed to the image model is shortened to a **first name** — a
long display name no longer gets stuffed into the image prompt — while your
**caption still shows your full name**, untouched.

Most of this is invisible correctness: a normal render looks the same. What
you can actually see is (1) generation still working fine with a long
display name, with the caption unaffected, and (2) a clean error if you
pick a disabled style instead of a silent plain render.

## Setup

- [david] Confirm you have admin access, for step 4's prompt preview.

## Steps

_Step 1 retired with PuLID, which launch Phase 4 deleted (removal 3, #744; ledger: `docs/retired/README.md`)._

_Step 2 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

_Step 3 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

### 4. The compiled prompt itself only carries the first name

**Do:** As admin, open the fact you just generated a meme for in
Admin → Facts, and expand its **Runtime Compiled Prompt Preview**.

**Expect:** the identity/reference section of the compiled prompt names
only your first name ("David"), not the full display name — this is the
actual oracle for the split; step 3's caption is a red herring for it.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/prepareAttemptInputs.test.ts:renders fact text from the SAME reduced identity the snapshot carries (user path)` `artifacts/api-server/src/__tests__/promptIdentity.test.ts:prefers firstName when present`

**Deferred:** #693 — the compiled prompt from the preview route naming only the first name of a multi-word previewName is unasserted, only the reducer and the prepare helper are; the preview route uses the typed name in full while a real generation reduces it (POST /admin/image-prompt/preview with "David Franklin" compiles "David Franklin")

_Step 5 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

_Step 6 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

_Step 7 retired with PuLID, which launch Phase 4 deleted (removal 3, #744; ledger: `docs/retired/README.md`)._

## Regression

_Step R1 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

_Step R2 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

_Step R3 retired with the legacy meme studio, which launch Phase 4 deleted (removal 1, #744; ledger: `docs/retired/README.md`)._

## Not bugs

- **Moderation preview / eval renders still show the full sample name.** The
  admin Runtime Compiled Prompt preview and the moderation/eval render paths
  use fixed sample subjects ("David Franklin" and gender variants) and are
  intentionally left as-is — they were already reproducible and their short
  fixture names don't need shortening. This is not the user-render path.
- **No new budget/length rejection at render time.** Enforcing a hard prompt
  budget is a later change; this PR only bounds the identity, it doesn't
  reject over-budget prompts yet.
