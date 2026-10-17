# PR #398 — Meme images baked the raw `{NAME}` token into the picture — UAT

Your in-app acceptance test, David. This one came straight from your report
on `/m/o1bV9xne49`.

**What was wrong.** The finished meme image had `{NAME}` printed on it
instead of the person's name. The words *underneath* the picture on the
meme page were always correct, and so was the live preview inside the
studio while you were building it — only the actual saved picture was
wrong. That gap is the whole story: the picture was being drawn from a
different copy of the sentence than the caption, and only the caption ever
had the name filled in.

**Why it hit every meme, not just yours.** When you drag the split slider
to decide which words go on top and which go on the bottom, the app stores
the fact **as two halves**. Filling in the name was only ever done to the
whole sentence — the halves were left as the template. And when the
picture gets drawn, the halves win. So any meme with a top/bottom split —
which is all of them — showed the token.

**What you'll see now.** The name (and any pronouns, and the right verb
form for those pronouns) appears on the picture itself, exactly as it does
in the preview while you're building.

**No cleanup needed for old memes.** Meme pictures are re-drawn from their
saved recipe every time they're loaded, so every meme you've already made
is fixed the moment this deploys. Nothing was re-processed and nothing was
rewritten in the database.

**Hard-refresh matters for these checks.** Your browser cached the old
(broken) picture, so a normal reload may show you the wrong image even
after the fix is live. On iPad: pull down hard to refresh, or close and
reopen the tab. If you still see `{NAME}`, open the picture in a new tab
with `?v=2` on the end of the URL to be certain you're not looking at a
cached copy.

## Setup

- [claude] Confirm the app is up before step 1. There's nothing to
  toggle — no flag, no setting.

## Steps

### 1. The reported meme's picture is fixed

**Do:** Open `https://…/m/o1bV9xne49` and hard-refresh.

**Expect:** The picture reads **"NICK BARON MAKES / ONIONS CRY."** — it
does **not** read "{NAME} MAKES".

**Lane:** scripted

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:personalizes the sentence AND both halves with the creator's identity`; `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:renders a tokenized split identically to the same split typed out by hand`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: the free account saves the same split twice, once tokenised and once typed by hand with its display name, and the two served images are byte-identical, while a different typed name serves a different image

### 2. The caption underneath was never broken and still isn't

**Do:** On the same meme page, read the caption sentence: on a desktop
screen it sits beside the picture, under the "What's next?" heading.

**Expect:** It reads "Nick Baron makes onions cry." and shows no `{NAME}`.
The meme's API record carries that sentence as its factText.

**Lane:** ci

**Check:** `curl -s https://overhype.me/api/memes/o1bV9xne49` via the Replit connector; the factText field must read "Nick Baron makes onions cry."; `artifacts/overhype-me/e2e/publicScreens.spec.ts:the meme page shows the creator's personalized sentence as its caption`

**Deferred:** #631 — 7b — GET /api/memes/:slug for a meme whose creator is Nick Baron, he/him, on the fact {NAME} makes onions cry. returns factText Nick Baron makes onions cry. — `artifacts/api-server/src/__tests__/routes.memes.test.ts`

### 3. A brand-new meme's picture matches its own preview

**Do:** The capture set, signed in as the free test account (display name
Free Tester), builds an image meme from the fixture fact "Firearms carry
{NAME} for protection." with the framing-chart photo, captures the
builder preview at the default split, saves the meme, and captures the saved
picture the meme's image route serves.

**Expect:** On the finished meme page, the saved picture says the same
words as the preview did, in the same two places, with your name spelled
out, and no `{` or `}` anywhere on the picture.

**Lane:** capture

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:renders a tokenized split identically to the same split typed out by hand`; `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:the default split: preview and saved picture (step 3)`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: the free account saves the same split twice, once tokenised and once typed by hand with its display name, and the two served images are byte-identical, while a different typed name serves a different image

### 4. Splitting with the name on the bottom half

**Do:** The capture set, signed in as the free test account (display name
Free Tester), builds an image meme from the fixture fact "Firearms carry
{NAME} for protection." with the framing-chart photo, moves the split
slider to 2 of 5 so the name falls in the bottom line, captures the
preview, saves, and captures the saved picture.

**Expect:** The preview reads FIREARMS CARRY over FREE TESTER FOR
PROTECTION., with the name in the bottom line, and the saved picture shows
the same words in the same two lines, with no `{` or `}`.

**Lane:** capture

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:substitutes a token that lands in the BOTTOM half (not just the top)`; `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:name in the bottom line, saved (step 4)`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: a split with the name in the bottom half, saved tokenised and typed by hand, serves byte-identical images, and a different typed bottom line serves a different image

### 5. Splitting with the name on the top half

**Do:** On the same builder, the capture set moves the split slider on to 3
of 5 so the name falls in the top line, captures the preview, saves, and
captures the saved picture.

**Expect:** The preview reads FIREARMS CARRY FREE TESTER over FOR
PROTECTION., with the name in the top line, and the saved picture shows the
same words in the same two lines.

**Lane:** capture

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:substitutes {NAME} in both split halves`; `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:name in the bottom line, then moved to the top line (steps 4 and 5)`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: a split with the name in the top half, saved tokenised and typed by hand, serves byte-identical images

### 6. Pronoun and verb agreement — they/them

**Do:** In your profile, set your pronouns to **they/them**, then build a
meme from a fact that uses a pronoun and a verb — anything phrased like
"They keep …" / "He keeps …".

**Expect:** The picture reads "**They keep**", not "They keeps" and not
"{Subj} {keeps|keep}".

**Lane:** scripted

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:conjugates plural for they/them and singular for he/him inside a half`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: with the profile pronouns set to they/them, a {Subj} {keeps|keep} split serves the same image as They keep typed by hand

### 7. Pronoun and verb agreement — he/him

**Do:** Switch your pronouns to **he/him** and build the same fact again.

**Expect:** This time it reads "**He keeps**".

**Lane:** scripted

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:conjugates plural for they/them and singular for he/him inside a half`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: with the profile pronouns set to he/him, the split serves the same image as He keeps typed by hand, and They keep typed by hand does not

### 8. The downloaded file matches the page

**Do:** The capture set saves a meme as in step 3 and presses Download on
the meme page.

**Expect:** The downloaded file is byte-for-byte the picture the page
serves (asserted by the check), and it shows the name spelled out as FREE
TESTER, with no `{` or `}`.

**Lane:** capture

**Check:** `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:the downloaded file is the page's picture (step 8)`; `artifacts/api-server/scripts/acceptance-run.ts` — `--mode acceptance`, journey 4: the free account saves the same split twice, once tokenised and once typed by hand with its display name, and the two served images are byte-identical, while a different typed name serves a different image

### 9. The share preview matches

**Do:** Tap **Share** and check the preview card.

**Expect:** Name spelled out, no token.

**Lane:** scripted

**Deferred:** #628 — Phase 6 (The loop) — #592 fixes meme OG previews and that phase's exit evidence verifies the OG card and its image with a crawler fixture, which must show the spelled-out name and no token

### 10. Merchandise export shows the real name (only if you use it)

**Do:** From a meme, go through the **Wear it** / Zazzle flow far enough
to see the product preview image.

**Expect:** The image Zazzle shows has the name on it, not `{NAME}`.

**Lane:** scripted

**Deferred:** #628 — Phase 4 (Cut and prune) — merch and Zazzle export are on the cut list and are removed with it

## Regression

### R1. Text styling is unchanged

**Do:** The capture set, signed in as the free test account (display name
Free Tester), builds an image meme from the fixture fact "Firearms carry
{NAME} for protection." with the framing-chart photo, saves it once at
each aspect ratio (landscape, square and portrait), and captures each saved
picture.

**Expect:** On every saved picture each caption line is drawn in a heavy,
condensed, all-caps typeface, white with a thick black outline, centred
across the picture, and large enough to read at a glance.

**Lane:** capture

**Check:** `artifacts/api-server/src/__tests__/memeCaptionPersonalization.test.ts:preserves every other text option and does not mutate the input`; `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:a finished meme at`

### R2. Line positioning is unchanged

**Do:** The capture set, signed in as the free test account (display name
Free Tester), builds an image meme from the fixture fact "Firearms carry
{NAME} for protection." with the framing-chart photo, captures the
preview with the top line at its default position, moves the top-position
slider to about 45%, captures the preview again, saves, and captures the
saved picture.

**Expect:** In the first preview the top line sits near the top edge and the
bottom line near the bottom edge; after the move the top line sits visibly
lower, near the middle, while the bottom line stays put; and the saved
picture shows the top line at that lower position. The check asserts the
slider's reported value rose.

**Lane:** capture

**Check:** `artifacts/overhype-me/src/components/meme-builder/wizard/step2-image/__tests__/splitLogic.test.ts:clamps maxTopY below the bottom-block boundary`; `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:the caption at two position-slider settings (R2)`

### R3. Photo framing and image quality are unchanged

**Do:** The capture set, signed in as the free test account (display name
Free Tester), builds an image meme from the fixture fact "Firearms carry
{NAME} for protection." with the framing-chart photo, saves it once at
each aspect ratio (landscape, square and portrait), and captures each saved
picture.

**Expect:** Each saved picture has the chosen aspect ratio (16:9, 1:1 or
9:16, asserted from its dimensions by the check); the chart fills the frame,
cropped about its centre, with the crosshair circle centred and round, not
stretched; and the chart's fine black line pairs read as separate lines, not
a smear.

**Lane:** capture

**Check:** `artifacts/overhype-me/e2e/capture/memeCaption.capture.spec.ts:a finished meme at`

### R4. Gradient-template memes are unaffected

**Do:** Look at a meme made from a gradient template (not a photo).

**Expect:** the finished gradient-template meme shows its gradient background
edge to edge, with the caption drawn in the same font, outline and all-caps
treatment as a photo meme.

**Lane:** capture

**Deferred:** #628 — Phase 4 (Cut and prune) — gradient templates are on the cut list and are deleted, so there is nothing left to compare

### R5. The name highlight elsewhere in the app is untouched

**Do:** Check the orange highlight on the name in the fact text elsewhere
in the app.

**Expect:** The name inside fact text is drawn in the brand orange (the
`--primary` colour in `src/index.css`) and the rest of the sentence is not:
the sample name "David Franklin" in the home page's welcome card, and the
visitor's own name in a feed card once they have entered one. On-screen fact
text goes through the highlighting renderer.

**Lane:** ci

**Check:** `artifacts/overhype-me/src/components/facts/HighlightedFactText.test.tsx:highlights a plain {NAME} substitution`; `artifacts/overhype-me/src/__tests__/factTextHighlighting.guard.test.ts:only allowlisted modules import the flat renderFact` — on-screen fact text goes through the highlighting renderer; `artifacts/overhype-me/e2e/publicScreens.spec.ts:the name inside fact text is drawn in the brand orange`

## Not bugs

- **If a meme's creator has since deleted their account, the picture falls
  back to the generic name "Alex"** — before this fix it would have shown
  `{NAME}` instead, so this is strictly better. But the **caption**
  underneath the picture doesn't fall back the same way: it's usually
  frozen from the moment the meme was made, so it keeps showing the real
  name even after the creator is gone. That gap between the picture and
  the caption is real, predates this fix, and isn't closed by it — it's a
  separate, pre-existing quirk, tracked in #399. You're very unlikely to
  hit it (it needs a deleted creator on an old-enough meme), and if you
  do, "Alex" on the picture next to a real name in the caption is that
  quirk, not a new bug.
