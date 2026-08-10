# PR #398 — Meme images baked the raw `{NAME}` token into the picture — UAT

Your in-app acceptance test, David. This one came straight from your report on
`/m/o1bV9xne49`.

**What was wrong.** The finished meme image had `{NAME}` printed on it instead of
the person's name. The words *underneath* the picture on the meme page were always
correct, and so was the live preview inside the studio while you were building it —
only the actual saved picture was wrong. That gap is the whole story: the picture
was being drawn from a different copy of the sentence than the caption, and only
the caption ever had the name filled in.

**Why it hit every meme, not just yours.** When you drag the split slider to decide
which words go on top and which go on the bottom, the app stores the fact **as two
halves**. Filling in the name was only ever done to the whole sentence — the halves
were left as the template. And when the picture gets drawn, the halves win. So any
meme with a top/bottom split — which is all of them — showed the token.

**What you'll see now.** The name (and any pronouns, and the right verb form for
those pronouns) appears on the picture itself, exactly as it does in the preview
while you're building.

**No cleanup needed for old memes.** Meme pictures are re-drawn from their saved
recipe every time they're loaded, so every meme you've already made is fixed the
moment this deploys. Nothing was re-processed and nothing was rewritten in the
database.

## Before you start

- Nothing to toggle — no flag, no setting.
- **Hard-refresh the meme page.** Your browser cached the old (broken) picture, so
  a normal reload may show you the wrong image even after the fix is live. On
  iPad: pull down hard to refresh, or close and reopen the tab. If you still see
  `{NAME}`, open the picture in a new tab with `?v=2` on the end of the URL to be
  certain you're not looking at a cached copy.

## The main event

### 1. The reported meme is fixed

- Open `https://…/m/o1bV9xne49` and hard-refresh.
- ✅ The picture reads **"NICK BARON MAKES / ONIONS CRY."**
- ✅ It does **not** read "{NAME} MAKES".
- ✅ The words underneath the picture still read "Nick Baron makes onions cry." —
  same as before, they were never broken.

### 2. A brand-new meme matches its own preview

This is the case worth doing end-to-end — it's the one that proves the fix at the
source rather than just repairing old pictures.

- Build a meme from any fact that has your name in it. Use a photo of yourself or
  a stock photo, whichever is quicker.
- Before you save, **read the preview carefully** — note the exact words top and
  bottom.
- Save it, then look at the finished meme page.
- ✅ The saved picture says the same words as the preview did, in the same two
  places, with your name spelled out.
- ✅ No `{` or `}` anywhere on the picture.

### 3. Drag the split slider somewhere unusual

The bug lived in the split, so the split is where to poke.

- Build another meme from a fact where your name is in the **middle or the end** of
  the sentence, not the start (e.g. something like "Onions cry because of …").
- Drag the split slider so the name lands on the **bottom** half, then again so it
  lands on the **top** half.
- ✅ Both times, the preview shows your name — and the saved picture matches it.

This matters because a half-done fix would have covered only the top line.

### 4. Pronouns and verb forms come out right

- In your profile, set your pronouns to **they/them**.
- Build a meme from a fact that uses a pronoun and a verb — anything phrased like
  "They keep …" / "He keeps …".
- ✅ The picture reads "**They keep**", not "They keeps" and not "{Subj} {keeps|keep}".
- Switch your pronouns to **he/him** and build the same fact again.
- ✅ This time it reads "**He keeps**".

### 5. Download and share still look right

- On a finished meme, tap **Download**.
- ✅ The downloaded file has the name on it, matching what's on the page.
- Tap **Share** and check the preview card.
- ✅ Same — name spelled out, no token.

### 6. Merchandise export (only if you use it)

- From a meme, go through the **Wear it** / Zazzle flow far enough to see the
  product preview image.
- ✅ The image Zazzle shows has the name on it, not `{NAME}`.

This one is worth a look because the same defect was quietly sending tokenized
images to a public URL for the print vendor.

## What should NOT have changed

Flag any of these if they look off — they're the neighbors this fix sits next to:

- ✅ Text size, font, outline/shadow, and ALL-CAPS look the same as before.
- ✅ Where the top and bottom lines sit vertically is unchanged — the split slider
  and the position sliders behave as they always did.
- ✅ Photo framing/cropping, the aspect-ratio choice (landscape/square/portrait),
  and image sharpness are unchanged.
- ✅ Memes made from the gradient templates (not photos) look the same.
- ✅ The orange highlight on the name in the fact text elsewhere in the app is
  untouched.

## One thing worth knowing

If a meme's creator has since deleted their account, that meme's picture falls back
to the generic name "Alex" — which is the same fallback the words under the picture
have always used. Before this fix, that case would have shown `{NAME}` on the
picture; now the two agree. You're unlikely to hit it, but if you see "Alex" on a
very old meme, that's this, working as intended.

## If something's wrong

Tell me which step, what you saw, and the meme's URL. If a picture still shows
`{NAME}` after a hard refresh, that's the real thing and I want it — the most
likely explanation would be a render path I missed.
