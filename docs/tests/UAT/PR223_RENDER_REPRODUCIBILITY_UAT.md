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

- [david] Sign in with a **legendary** account (AI meme generation is
  legendary-gated).
- [claude] Confirm a fact exists that supports generating a meme both with a
  reference photo upload and without one.
- [david] Confirm you have admin access, for the disabled-style check.

## Steps

### 1. Generate with a reference photo

**Do:** Upload a reference photo for a fact and generate a meme.

**Expect:** the render completes as before, the image looks right for your
subject, and the finished meme's caption reads your full display name
exactly as stored. Nothing about the visible result should feel different
from `main`.

### 2. Generate without a reference photo

**Do:** Generate a meme for the same fact, this time with no reference photo
uploaded (the text-to-image path).

**Expect:** the render completes as before, and the caption reads your full
display name exactly as stored.

### 3. A long display name doesn't leak into the caption

**Do:** Set your profile display name to something long and multi-word
(e.g. "David Franklin The Third"), then generate a meme.

**Expect:** the render completes normally and the caption shows the full
name you set, exactly ("David Franklin The Third"). The caption is
independent of what the image model receives either way, so this alone
does not prove the split — step 3b is what actually checks it.

### 4. The compiled prompt itself only carries the first name

**Do:** As admin, open the fact you just generated a meme for in
Admin → Facts, and expand its **Runtime Compiled Prompt Preview**.

**Expect:** the identity/reference section of the compiled prompt names
only your first name ("David"), not the full display name — this is the
actual oracle for the split; step 3's caption is a red herring for it.

### 5. A disabled style is rejected, not silently dropped

**Do:** As admin, deactivate a look-style, then try to generate a meme
selecting that style.

**Expect:** a clear "style unavailable" rejection — not enqueued — instead
of the old behavior where it quietly rendered with no style at all.

### 6. Re-enabling the style lets the same generate succeed

**Do:** Re-enable the style you deactivated in step 4, then repeat the same
generate.

**Expect:** it succeeds and the style is applied as normal.

## Regression

### R1. A valid selected style still applies

**Do:** Generate a meme selecting an active, valid look-style.

**Expect:** the style is applied as before.

### R2. An anonymous / no-profile render still falls back

**Do:** Generate a meme without a signed-in profile (or from an account with
no display name set).

**Expect:** it falls back to the canonical test identity and still renders.

### R3. Older renders still display correctly

**Do:** Open an older, already-completed render (or re-poll one from before
this PR).

**Expect:** it still displays correctly — legacy attempts are untouched.

## Not bugs

- **Moderation preview / eval renders still show the full sample name.** The
  admin Runtime Compiled Prompt preview and the moderation/eval render paths
  use fixed sample subjects ("David Franklin" and gender variants) and are
  intentionally left as-is — they were already reproducible and their short
  fixture names don't need shortening. This is not the user-render path.
- **No new budget/length rejection at render time.** Enforcing a hard prompt
  budget is a later change; this PR only bounds the identity, it doesn't
  reject over-budget prompts yet.
