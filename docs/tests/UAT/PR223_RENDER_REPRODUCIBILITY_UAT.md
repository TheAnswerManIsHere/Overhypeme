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

- [david] Sign in with a **legendary** account (reference-photo styling is
  legendary-gated).
- [claude] Confirm a fact exists that supports generating a meme with a
  reference photo upload. (The no-photo steps are killed with the legacy
  meme studio: `docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*.)
- [david] Confirm you have admin access, for step 4's prompt preview.

## Steps

### 1. Generate with a reference photo

**Do:** The real-render capture run (`acceptance-run.ts --mode capture`, on the
Repl under the $3.00 cap, only on your go-ahead for that run), signed in as the paid test account, uploads the
reference face photo `artifacts/api-server/src/assets/test-face.jpg`,
generates an AI image for a fixture fact through the meme builder's
reference-photo path (`POST /api/memes/pulid-jobs`), and captures the
reference and the full-size result.

**Expect:** the render completes and the served result decodes as an image
(its dimensions are in the shot's caption); and the finished meme's caption reads the
account's full display name exactly as stored (the caption clause is the unit
test's, cited below). Whether the result shows the person in the reference
photo is step 7's, yours.

**Lane:** capture

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:personalizes the sentence AND both halves with the creator's identity`; `artifacts/api-server/src/testing/acceptance/captureJourneys.ts:pr223-s1-reference`; `artifacts/api-server/src/testing/acceptance/captureJourneys.ts:pr223-s1-result`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: the free account saves the same split twice, once tokenised and once typed by hand with its display name, and the two served images are byte-identical, while a different typed name serves a different image

**Deferred:** #628 — Phase 4 (Cut and prune) — driving a reference-photo generate through acceptance journey 6. Killed: journey 6 runs the user generate route, which only the legacy meme studio calls and which is deleted for launch (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*); the reference-photo render itself is this step's capture

### 2. Generate without a reference photo

**Do:** Generate a meme for the same fact, this time with no reference photo
uploaded (the text-to-image path).

**Expect:** the render completes as before, and the caption reads your full
display name exactly as stored.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### 3. A long display name doesn't leak into the caption

**Do:** Set your profile display name to something long and multi-word
(e.g. "David Franklin The Third"), then generate a meme.

**Expect:** the render completes normally and the caption shows the full
name you set, exactly ("David Franklin The Third"). The caption is
independent of what the image model receives either way, so this alone
does not prove the split — step 3b is what actually checks it.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### 4. The compiled prompt itself only carries the first name

**Do:** As admin, open the fact you just generated a meme for in
Admin → Facts, and expand its **Runtime Compiled Prompt Preview**.

**Expect:** the identity/reference section of the compiled prompt names
only your first name ("David"), not the full display name — this is the
actual oracle for the split; step 3's caption is a red herring for it.

**Lane:** ci

**Check:** `artifacts/api-server/src/__tests__/prepareAttemptInputs.test.ts:renders fact text from the SAME reduced identity the snapshot carries (user path)` `artifacts/api-server/src/__tests__/promptIdentity.test.ts:prefers firstName when present`

**Deferred:** #631 — 7b — the compiled prompt from the preview route naming only the first name of a multi-word previewName is unasserted, only the reducer and the prepare helper are — `artifacts/api-server/src/__tests__/imagePromptPreview.test.ts`

### 5. A disabled style is rejected, not silently dropped

**Do:** As admin, deactivate a look-style, then try to generate a meme
selecting that style.

**Expect:** a clear "style unavailable" rejection — not enqueued — instead
of the old behavior where it quietly rendered with no style at all.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### 6. Re-enabling the style lets the same generate succeed

**Do:** Re-enable the style you deactivated in step 5, then repeat the same
generate.

**Expect:** it succeeds and the style is applied as normal.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### 7. The reference-photo result shows you, in a scene that fits

**Do:** Look at step 1's two shots side by side, the reference photo and the
result (`/uat` shows them with their evidence links). Step 1 is deferred, so
its shots exist only after a capture run you gave the go-ahead for; without
one, generate the image yourself in the app instead: AI styling with your own photo as
the reference, on a fact with your name in it.

**Expect:** the result shows the same person as the reference photo,
recognisably the same face and not a stranger or a garbled face, placed in a
scene that fits the fact.

**Lane:** human

**Judgement:** whether a generated image shows the right person in a fitting scene is a judgement about AI-generated content, which is yours alone (David, 2026-10-17); step 1 proves only that the render completed and decodes.

## Regression

### R1. A valid selected style still applies

**Do:** Generate a meme selecting an active, valid look-style.

**Expect:** the style is applied as before.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### R2. An anonymous / no-profile render still falls back

**Do:** Generate a meme without a signed-in profile (or from an account with
no display name set).

**Expect:** it falls back to the canonical test identity and still renders.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

### R3. Older renders still display correctly

**Do:** Open an older, already-completed render (or re-poll one from before
this PR).

**Expect:** it still displays correctly — legacy attempts are untouched.

**Lane:** ci

**Deferred:** #628 — Phase 4 (Cut and prune) — this step can be done only through the legacy meme studio or a route only it calls, which is deleted for launch, so its verification is killed (`docs/ai-context/decisions.md`, *Verification work tied to the legacy meme studio is killed*)

## Not bugs

- **Moderation preview / eval renders still show the full sample name.** The
  admin Runtime Compiled Prompt preview and the moderation/eval render paths
  use fixed sample subjects ("David Franklin" and gender variants) and are
  intentionally left as-is — they were already reproducible and their short
  fixture names don't need shortening. This is not the user-render path.
- **No new budget/length rejection at render time.** Enforcing a hard prompt
  budget is a later change; this PR only bounds the identity, it doesn't
  reject over-budget prompts yet.
