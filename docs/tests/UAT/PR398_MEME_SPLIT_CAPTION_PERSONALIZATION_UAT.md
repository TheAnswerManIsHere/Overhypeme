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

### 2. The caption underneath was never broken and still isn't

**Do:** On the same meme page, read the text underneath the picture.

**Expect:** It still reads "Nick Baron makes onions cry." — same as
before, it was never broken.

### 3. A brand-new meme's picture matches its own preview

**Do:** Build a meme from any fact that has your name in it (a photo of
yourself or a stock photo, whichever is quicker); before saving, read the
preview carefully and note the exact words top and bottom; then save it.

**Expect:** On the finished meme page, the saved picture says the same
words as the preview did, in the same two places, with your name spelled
out, and no `{` or `}` anywhere on the picture.

### 4. Splitting with the name on the bottom half

**Do:** Build another meme from a fact where your name is in the **middle
or the end** of the sentence, not the start (e.g. something like "Onions
cry because of …"), and drag the split slider so the name lands on the
**bottom** half.

**Expect:** The preview shows your name, and the saved picture matches it.

### 5. Splitting with the name on the top half

**Do:** On the same meme, drag the split slider again so the name lands on
the **top** half.

**Expect:** The preview shows your name, and the saved picture matches it.

### 6. Pronoun and verb agreement — they/them

**Do:** In your profile, set your pronouns to **they/them**, then build a
meme from a fact that uses a pronoun and a verb — anything phrased like
"They keep …" / "He keeps …".

**Expect:** The picture reads "**They keep**", not "They keeps" and not
"{Subj} {keeps|keep}".

### 7. Pronoun and verb agreement — he/him

**Do:** Switch your pronouns to **he/him** and build the same fact again.

**Expect:** This time it reads "**He keeps**".

### 8. The downloaded file matches the page

**Do:** On a finished meme, tap **Download**.

**Expect:** The downloaded file has the name on it, matching what's on the
page.

### 9. The share preview matches

**Do:** Tap **Share** and check the preview card.

**Expect:** Name spelled out, no token.

### 10. Merchandise export shows the real name (only if you use it)

**Do:** From a meme, go through the **Wear it** / Zazzle flow far enough
to see the product preview image.

**Expect:** The image Zazzle shows has the name on it, not `{NAME}`.

## Regression

### R1. Text styling is unchanged

**Do:** Compare text size, font, outline/shadow, and ALL-CAPS treatment on
a meme picture.

**Expect:** Same as before this PR.

### R2. Line positioning is unchanged

**Do:** Check where the top and bottom lines sit vertically, and try the
split slider and the position sliders.

**Expect:** Unchanged — they behave as they always did.

### R3. Photo framing and image quality are unchanged

**Do:** Check photo framing/cropping, the aspect-ratio choice
(landscape/square/portrait), and image sharpness.

**Expect:** Unchanged from before this PR.

### R4. Gradient-template memes are unaffected

**Do:** Look at a meme made from a gradient template (not a photo).

**Expect:** Looks the same as before.

### R5. The name highlight elsewhere in the app is untouched

**Do:** Check the orange highlight on the name in the fact text elsewhere
in the app.

**Expect:** Untouched.

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
