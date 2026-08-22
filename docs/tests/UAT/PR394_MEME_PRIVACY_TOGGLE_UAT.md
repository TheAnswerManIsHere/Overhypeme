# PR #394 — Public/Private control in the meme builder — UAT

Your in-app acceptance test, David.

**Why this exists.** You went to UAT meme privacy and there was nothing to
click. The control existed in the old builder and was never carried into
the wizard — the only builder that actually ships (`VITE_MBFO_WIZARD=1` is
committed to git, so it's the only path any real build ever renders) — so
**every meme ever made in the app was saved public**. The backend has
honored a privacy choice this whole time; the app just never sent one. This
PR puts the choice back, next to the save button, on wizard Step 2.

**One thing to know before you test:** visibility is chosen **at creation
time only**. There is no route and no UI anywhere in the product that
changes a meme's visibility afterwards — that was true before this PR and
is still true after it. If you make a meme private, private is what it
stays (you can still delete it). Worth deciding whether you want a
post-creation switch; it's a separate piece of work.

**Worth deciding, steps 12–14:** adding the control grows the fixed bar at
the bottom of Step 2 by about one row, which is viewport taken away from
the scrolling controls. If that feels too heavy on a small screen, the
alternative is moving the control up into the scrolling panel near the
aspect-ratio row — cheaper on space, easier to miss. Your call either way.

## Setup

- [claude] Confirm the app is up before you start. There's no feature flag
  for this control — it's live wherever the wizard is, which is
  everywhere.
- [david] Sign in with your **Legendary** account and your **plain
  registered** account (switching between them as steps call for it), and
  have a private/incognito window ready for the logged-out checks.

## Steps

### 1. The control is there, and it defaults to Public

**Do:** Log in as your **Legendary** account, go to `/facts/39/meme`, pick
"Image", pick a photo (any source), then look just above the **Make my
meme** button.

**Expect:** There's a Public | Private pair, with **Public** selected, and
no explanatory sub-text while Public is selected — the row is one line.

### 2. Choosing Private says what it means

**Do:** Tap **Private**.

**Expect:** Private becomes the selected side, and a line appears
underneath: *"Only you. It stays out of the gallery and the link won't
open for anyone else."*

### 3. Switching back to Public clears the explanation

**Do:** Tap **Public** again.

**Expect:** It switches back to Public and the explanatory line
disappears.

### 4. A private meme renders for its creator

**Do:** With **Private** selected, save the meme.

**Expect:** You land on its permalink, and it renders normally for you,
the creator.

### 5. A private meme is invisible to a logged-out visitor

**Do:** Copy that permalink and open it in a **private/incognito window**
(or log out first).

**Expect:** It does **not** load — you get a not-found page, not a "you
don't have permission" page. That's deliberate: a private meme shouldn't
even confirm it exists.

### 6. A private meme does not appear in listings

**Do:** While still logged out, check the public gallery and the fact's
meme list.

**Expect:** The private meme does not appear in either.

### 7. A public meme still behaves exactly as before

**Do:** Make a second meme on the same fact, leaving **Public** selected,
and save it.

**Expect:** Saves as normal; the permalink opens for anyone including
logged-out, and it shows up in the gallery and the fact's meme list.

### 8. A non-Legendary account is offered the upgrade, not the feature

**Do:** Log in as your **plain registered** account and start a meme on
any fact.

**Expect:** The control is visible, but **Private** is dimmed and carries
a small typeset `LEGEND` badge (no crown, no emoji).

### 9. Tapping Private for a non-Legendary account opens the upgrade modal

**Do:** Tap **Private**.

**Expect:** The upgrade modal opens, headlined *"Go Legendary to keep
memes private."*

### 10. Closing the upgrade modal preserves your in-progress meme

**Do:** Close the modal.

**Expect:** **Public** is still selected, and your in-progress meme is
exactly as you left it (photo, text, framing all intact — tapping Private
must never cost you your work).

### 11. A non-Legendary meme still saves public

**Do:** Save it and check the permalink logged-out.

**Expect:** It loads — a non-Legendary meme is public, which is the
existing rule, now shown honestly instead of silently applied.

### 12. Logged-out sees no control at all

**Do:** Log out entirely and open `/facts/39/meme`.

**Expect:** No visibility control anywhere. You can't save a meme until
you sign up, so a choice about a meme that can't exist yet would just be
noise.

### 13. The choice survives a reload

**Do:** As **Legendary**, set Private, then reload the page mid-build.

**Expect:** The wizard restores your draft **with Private still
selected**.

### 14. Step 2's last control is still reachable on a phone

**Do:** On a phone, scroll the Step 2 controls all the way down.

**Expect:** The **last** control (Advanced options) can still be reached
and isn't stuck under the bottom bar.

### 15. The preview isn't clipped on a phone

**Do:** On a phone, check the preview above the Step 2 controls.

**Expect:** It still looks right; nothing is clipped.

### 16. Toggling Public/Private doesn't break the layout on a phone

**Do:** On a phone, toggle Public → Private, which adds the explanatory
line.

**Expect:** The save button isn't pushed off-screen, and the layout
doesn't jump in a way that feels broken.

## Regression

### R1. Video memes still have no privacy control

**Do:** Start building a video meme.

**Expect:** No visibility toggle appears. Video memes have no privacy
field yet — a known, separate gap this PR doesn't touch.

## Not bugs

- **Video memes still have no visibility control in the wizard** (checked
  in R1). When this PR shipped the video backend accepted no privacy field
  at all; it does now — `routes/videos.ts` takes `isPrivate` and enforces
  the `meme_private_visibility` entitlement — but the wizard's video step
  still exposes no control, so R1's result is unchanged. What moved is the
  reason, not the outcome.
