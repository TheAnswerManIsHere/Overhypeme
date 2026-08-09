# PR #394 — Public/Private control in the meme builder — UAT

Your in-app acceptance test, David.

**Why this exists.** You went to UAT meme privacy and there was nothing to
click. The control existed in the old single-file builder and was never
carried into either builder that actually ships, so **every meme ever made
in the app was saved public** — the backend has honored a privacy choice
this whole time, the app just never sent one. This PR puts the choice back,
next to the save button, on both builder surfaces.

**One thing to know before you test:** visibility is chosen **at creation
time only**. There is no route and no UI anywhere in the product that
changes a meme's visibility afterwards — that was true before this PR and
is still true after it. If you make a meme private, private is what it
stays (you can still delete it). Worth deciding whether you want a
post-creation switch; it's a separate piece of work.

## Before you start

- No feature flag for the control itself — it's live wherever the builder is.
- You'll want **two accounts**: one Legendary, one plain registered. Plus a
  private/incognito window for the logged-out checks.
- The app has two meme builders and which one you get is a build-time flag
  (`VITE_MBFO_WIZARD`). **The control looks the same in both** — a
  Public | Private pair sitting just above the save button — so you don't
  need to know which one you're on. If you see a full-screen wizard that
  asked "what kind of meme?" first, you're on the wizard; if you see a
  single scrolling page with a Save button, you're on the other one.

## The main event

### 1. The control is there, and it defaults to Public

- Log in as your **Legendary** account, go to `/facts/39/meme`, pick a photo
  (any source).
- Look just above the **Make my meme** / **Save meme** button.
- ✅ There's a Public | Private pair, with **Public** selected.
- ✅ No explanatory sub-text while Public is selected — the row is one line.

### 2. Choosing Private says what it means

- Tap **Private**.
- ✅ Private becomes the selected side, and a line appears underneath:
  *"Only you. It stays out of the gallery and the link won't open for anyone
  else."*
- Tap **Public** again — ✅ it switches back and the line disappears.

### 3. A private meme really is private

- Back on **Private**, save the meme. You land on its permalink.
- ✅ You (the creator) can see it, and it renders normally.
- Copy that permalink and open it in a **private/incognito window** (or log
  out first).
- ✅ It does **not** load — you get a not-found page, not a "you don't have
  permission" page. That's deliberate: a private meme shouldn't even confirm
  it exists.
- ✅ It does not appear in the public gallery or in the fact's meme list when
  viewed logged-out.

### 4. A public meme still behaves exactly as before

- Make a second meme on the same fact, leaving **Public** selected.
- ✅ Saves as normal, permalink opens for anyone including logged-out, and it
  shows up in the gallery / fact meme list.
- This is the "did the fix break the normal path" check — if only step 3
  works, the change did more than it should have.

### 5. A non-Legendary account is offered the upgrade, not the feature

- Log in as your **plain registered** account and start a meme on any fact.
- ✅ The control is visible, but **Private** is dimmed and carries a small
  typeset `LEGEND` badge (no crown, no emoji).
- Tap **Private**.
- ✅ The upgrade modal opens, headlined *"Go Legendary to keep memes
  private."*
- ✅ Close the modal — **Public is still selected**, and your in-progress
  meme is exactly as you left it (photo, text, framing all intact — tapping
  Private must never cost you your work).
- Save it and check the permalink logged-out.
- ✅ It loads — a non-Legendary meme is public, which is the existing rule,
  now shown honestly instead of silently applied.

### 6. Logged-out sees no control at all

- Log out entirely and open `/facts/39/meme`.
- ✅ No visibility control anywhere. You can't save a meme until you sign up,
  so a choice about a meme that can't exist yet would just be noise.

### 7. The choice survives a reload (wizard only)

- As **Legendary**, on the wizard, set Private, then reload the page
  mid-build.
- ✅ The wizard restores your draft **with Private still selected**.
- On the single-screen builder this resets to Public on reload — if that
  bothers you, say so and I'll persist it there too.

## Layout check — the part that costs you screen space

Adding the control to the wizard grows the fixed bar at the bottom of Step 2
by about one row, which is viewport taken away from the scrolling controls.
Worth an explicit look on your phone:

- ✅ On a phone, scroll the Step 2 controls all the way down — the **last**
  control (Advanced options) can still be reached and isn't stuck under the
  bottom bar.
- ✅ The preview above still looks right; nothing is clipped.
- ✅ Toggling Public → Private (which adds the explanatory line) doesn't push
  the save button off-screen or make the layout jump in a way that feels
  broken.

If the fixed bar feels too heavy on a small screen, the alternative is
moving the control up into the scrolling panel near the aspect-ratio row —
cheaper on space, easier to miss. Your call; it's a small change either way.

## Known gap — video memes

**Video memes have no visibility control, on either builder.** That flow's
backend accepts no privacy field at all, so every video meme is public. It
isn't part of this fix (it needs a change inside the async video pipeline)
and it's tracked separately — so if you test a *video* meme and find no
toggle, that's the known gap, not a failure of this PR.
